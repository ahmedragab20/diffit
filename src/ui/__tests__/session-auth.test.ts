// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('session-auth', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    sessionStorage.clear()
    delete window.__DIFFING_SESSION_TOKEN__
    window.history.replaceState(null, '', '/')
    vi.resetModules()
  })

  it('migrates legacy ?token= from the URL into sessionStorage and strips the bar', async () => {
    window.history.replaceState(null, '', '/?token=url-token')
    const mod = await import('../session-auth')
    mod.installSessionAuth()
    expect(sessionStorage.getItem('diffing-session-token')).toBe('url-token')
    expect(window.location.pathname + window.location.search).toBe('/')
    expect(mod.sessionTokenQuerySuffix()).toBe('')
  })

  it('falls back to sessionStorage when URL has no token', async () => {
    sessionStorage.setItem('diffing-session-token', 'stored-token')
    window.history.replaceState(null, '', '/plan/foo')
    const mod = await import('../session-auth')
    mod.installSessionAuth()
    expect(mod.liveEventSourceUrl()).toBe('/api/live?token=stored-token')
  })

  it('returns bare /api/live when no token is available', async () => {
    const mod = await import('../session-auth')
    mod.installSessionAuth()
    expect(mod.liveEventSourceUrl()).toBe('/api/live')
  })

  it('withSessionTokenPath does not add token query params', async () => {
    window.__DIFFING_SESSION_TOKEN__ = 'injected'
    const mod = await import('../session-auth')
    mod.installSessionAuth()
    expect(mod.withSessionTokenPath('/plan/abc')).toBe('/plan/abc')
    expect(mod.withSessionTokenPath('/plan/abc?token=existing')).toBe('/plan/abc')
    expect(mod.withSessionTokenPath('/plan/abc?foo=bar&token=existing')).toBe('/plan/abc?foo=bar')
  })

  it('patches fetch with x-diffing-token header for /api routes', async () => {
    window.__DIFFING_SESSION_TOKEN__ = 'header-token'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const mod = await import('../session-auth')
    mod.installSessionAuth()
    await window.fetch('/api/ping')
    expect(fetchMock).toHaveBeenCalledOnce()
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init?.headers).get('x-diffing-token')).toBe('header-token')
  })

  function lastCallHeaders(fetchMock: ReturnType<typeof vi.fn>): Headers {
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit
    return new Headers(init?.headers)
  }

  it('does not attach x-diffing-token to cross-origin absolute fetches', async () => {
    window.__DIFFING_SESSION_TOKEN__ = 'boundary-token'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const mod = await import('../session-auth')
    mod.installSessionAuth()
    await window.fetch('https://foreign.test/api/ping')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(lastCallHeaders(fetchMock).get('x-diffing-token')).toBeNull()
  })

  it('does not attach x-diffing-token to protocol-relative foreign fetches', async () => {
    window.__DIFFING_SESSION_TOKEN__ = 'boundary-token'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const mod = await import('../session-auth')
    mod.installSessionAuth()
    await window.fetch('//foreign.test/api/ping')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(lastCallHeaders(fetchMock).get('x-diffing-token')).toBeNull()
  })

  it('does not attach x-diffing-token when /api/ appears only in the query string', async () => {
    window.__DIFFING_SESSION_TOKEN__ = 'boundary-token'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const mod = await import('../session-auth')
    mod.installSessionAuth()
    await window.fetch('/plan/abc?next=/api/ping')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(lastCallHeaders(fetchMock).get('x-diffing-token')).toBeNull()
  })

  it('attaches x-diffing-token to same-origin absolute URL and URL object', async () => {
    window.__DIFFING_SESSION_TOKEN__ = 'boundary-token'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const mod = await import('../session-auth')
    mod.installSessionAuth()
    await window.fetch(`${window.location.origin}/api/ping`)
    expect(lastCallHeaders(fetchMock).get('x-diffing-token')).toBe('boundary-token')
    await window.fetch(new URL('/api/ping', window.location.origin))
    expect(lastCallHeaders(fetchMock).get('x-diffing-token')).toBe('boundary-token')
  })

  it('preserves existing headers on a same-origin Request input while adding the token', async () => {
    window.__DIFFING_SESSION_TOKEN__ = 'boundary-token'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const mod = await import('../session-auth')
    mod.installSessionAuth()
    const request = new Request(`${window.location.origin}/api/ping`, {
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
    })
    await window.fetch(request)
    expect(fetchMock).toHaveBeenCalledOnce()
    const headers = lastCallHeaders(fetchMock)
    expect(headers.get('x-diffing-token')).toBe('boundary-token')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-request-id')).toBe('req-1')
  })

  it('gives explicit init.headers replacement precedence over Request headers', async () => {
    window.__DIFFING_SESSION_TOKEN__ = 'boundary-token'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const mod = await import('../session-auth')
    mod.installSessionAuth()
    const request = new Request(`${window.location.origin}/api/ping`, {
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
    })
    await window.fetch(request, { headers: { 'x-explicit': 'yes' } })
    expect(fetchMock).toHaveBeenCalledOnce()
    const headers = lastCallHeaders(fetchMock)
    expect(headers.get('x-diffing-token')).toBe('boundary-token')
    expect(headers.get('x-explicit')).toBe('yes')
    expect(headers.get('content-type')).toBeNull()
    expect(headers.get('x-request-id')).toBeNull()
  })
})
