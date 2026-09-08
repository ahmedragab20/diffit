// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const locks = vi.hoisted(() => ({
  current: null as {
    host: string
    port: number
    pid: number
    repoRoot: string
    startedAt: number
    version: string
    mode: 'web' | 'tui' | 'gh-pr'
    capability?: string
    authToken?: string
  } | null,
}))

vi.mock('../lib/server-lock.js', () => ({
  resolveActiveServerLock: () => locks.current,
}))

import { runSubcommand } from '../cli-agent.js'

describe('comment CLI commands', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    locks.current = null
  })

  for (const mode of ['web', 'tui', 'gh-pr'] as const) {
    it(`uses the ${mode} local comment routes`, async () => {
      locks.current = {
        host: '127.0.0.1',
        port: 43123,
        pid: process.pid,
        repoRoot: '/tmp/repo',
        startedAt: 1,
        version: 'test',
        mode,
        capability: mode === 'tui' ? 'capability' : undefined,
        authToken: mode === 'tui' ? undefined : 'session-token',
      }
      const calls: Array<{ url: string; method: string; body?: string }> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input)
          calls.push({
            url,
            method: (init?.method ?? 'GET').toUpperCase(),
            body: typeof init?.body === 'string' ? init.body : undefined,
          })
          return new Response('{}', { status: 200 })
        }),
      )

      expect(await runSubcommand('reply', ['comment/id', '--body', 'reply', '--model', 'gpt-test'])).toBe(0)
      expect(await runSubcommand('resolve', ['comment/id'])).toBe(0)
      expect(await runSubcommand('unresolve', ['comment/id'])).toBe(0)
      expect(await runSubcommand('comment', ['edit', 'comment/id', '--body', 'edited'])).toBe(0)
      expect(await runSubcommand('comment', ['delete', 'comment/id'])).toBe(0)

      const prefix = mode === 'gh-pr' ? '/api/gh/pr-session/comments' : '/api/comments'
      expect(calls.map((call) => `${call.method} ${call.url.replace('http://127.0.0.1:43123', '')}`)).toEqual([
        `POST ${prefix}/comment%2Fid/replies`,
        `PUT ${prefix}/comment%2Fid`,
        `PUT ${prefix}/comment%2Fid`,
        `PUT ${prefix}/comment%2Fid`,
        `DELETE ${prefix}/comment%2Fid`,
      ])
      expect(JSON.parse(calls[0].body!)).toMatchObject({
        body: 'reply',
        role: 'agent',
        model: 'gpt-test',
      })
      expect(calls.every((call) => call.url.startsWith('http://127.0.0.1:43123/'))).toBe(true)
    })
  }

  it('does not fall back from a missing PR draft route', async () => {
    locks.current = {
      host: '127.0.0.1',
      port: 43123,
      pid: process.pid,
      repoRoot: '/tmp/repo',
      startedAt: 1,
      version: 'test',
      mode: 'gh-pr',
      authToken: 'session-token',
    }
    let requestedUrl = ''
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = input instanceof Request ? input.url : String(input)
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    expect(await runSubcommand('resolve', ['comment/id'])).toBe(4)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(requestedUrl).toContain('/api/gh/pr-session/comments/comment%2Fid')
  })
})
