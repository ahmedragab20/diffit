// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import {
  SESSION_TOKEN_COOKIE,
  SESSION_TOKEN_HEADER,
  SESSION_TOKEN_QUERY,
  buildSessionTokenSetCookieValue,
  createServerAuthMiddleware,
  injectSessionTokenIntoHtml,
  isAllowedRequestHost,
  isLoopbackHost,
} from '../lib/server-auth.js'
import { appendSessionToken, joinSessionApiUrl, reviewSessionUrl } from '../lib/session-url.js'
import type { ServerLock } from '../lib/server-lock.js'

describe('server-auth', () => {
  it('recognises loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('192.168.1.1')).toBe(false)
  })

  it('rejects non-loopback Host headers on loopback binds', () => {
    expect(isAllowedRequestHost('evil.test', '127.0.0.1')).toBe(false)
    expect(isAllowedRequestHost('127.0.0.1:8080', '127.0.0.1')).toBe(true)
  })

  it('requires a matching token on /api routes when configured', async () => {
    const app = new Hono()
    app.use('*', createServerAuthMiddleware({
      bindHost: '127.0.0.1',
      authToken: 'secret-token',
    }))
    app.get('/api/ping', (c) => c.json({ ok: true }))
    app.get('/api/live', (c) => c.json({ ok: true }))
    app.get('/index.html', (c) => c.text('ok'))

    expect((await app.fetch(new Request('http://127.0.0.1/api/ping'))).status).toBe(401)
    // Query param is NOT accepted on general API routes (tokens in URLs leak).
    expect((await app.fetch(new Request(`http://127.0.0.1/api/ping?${SESSION_TOKEN_QUERY}=secret-token`))).status).toBe(401)
    const withHeader = new Request('http://127.0.0.1/api/ping')
    withHeader.headers.set(SESSION_TOKEN_HEADER, 'secret-token')
    expect((await app.fetch(withHeader)).status).toBe(200)
    const withWrongHeader = new Request('http://127.0.0.1/api/ping')
    withWrongHeader.headers.set(SESSION_TOKEN_HEADER, 'wrong-token')
    expect((await app.fetch(withWrongHeader)).status).toBe(401)
    const withCookie = new Request('http://127.0.0.1/api/ping')
    withCookie.headers.set('Cookie', `${SESSION_TOKEN_COOKIE}=secret-token`)
    expect((await app.fetch(withCookie)).status).toBe(200)
    expect((await app.fetch(new Request('http://127.0.0.1/index.html'))).status).toBe(200)
  })

  it('accepts the query token only on the SSE /api/live endpoint', async () => {
    const app = new Hono()
    app.use('*', createServerAuthMiddleware({
      bindHost: '127.0.0.1',
      authToken: 'secret-token',
    }))
    app.get('/api/live', (c) => c.json({ ok: true }))

    expect((await app.fetch(new Request('http://127.0.0.1/api/live'))).status).toBe(401)
    expect((await app.fetch(new Request(`http://127.0.0.1/api/live?${SESSION_TOKEN_QUERY}=secret-token`))).status).toBe(200)
    expect((await app.fetch(new Request(`http://127.0.0.1/api/live?${SESSION_TOKEN_QUERY}=wrong`))).status).toBe(401)
  })

  it('builds a loopback-safe session cookie', () => {
    expect(buildSessionTokenSetCookieValue('abc123')).toBe(
      `${SESSION_TOKEN_COOKIE}=abc123; Path=/; SameSite=Strict; HttpOnly`,
    )
  })
})

describe('auth-boundary: Host/Origin checks must cover HTML routes, not only /api/*', () => {
  const HTML = '<html><head></head><body>review</body></html>'

  const buildApp = () => {
    const app = new Hono()
    app.use('*', createServerAuthMiddleware({
      bindHost: '127.0.0.1',
      authToken: 'secret-token',
    }))
    app.get('/', (c) => c.html(HTML))
    app.get('/plan/test', (c) => c.html(HTML))
    app.get('/api/ping', (c) => c.json({ ok: true }))
    return app
  }

  it('rejects a hostile Host header with 403 on HTML routes (/ and /plan/test), not only /api/*', async () => {
    const app = buildApp()
    expect((await app.fetch(new Request('http://127.0.0.1/', { headers: { Host: 'evil.test' } }))).status).toBe(403)
    expect((await app.fetch(new Request('http://127.0.0.1/plan/test', { headers: { Host: 'evil.test' } }))).status).toBe(403)
    // Sanity: the API surface already rejects hostile Host.
    expect((await app.fetch(new Request('http://127.0.0.1/api/ping', { headers: { Host: 'evil.test' } }))).status).toBe(403)
  })

  it('rejects a hostile Origin with 403 on HTML and API routes even with the correct token header', async () => {
    const app = buildApp()
    const htmlReq = new Request('http://127.0.0.1/', {
      headers: { Host: '127.0.0.1', Origin: 'http://evil.test', [SESSION_TOKEN_HEADER]: 'secret-token' },
    })
    expect((await app.fetch(htmlReq)).status).toBe(403)
    const planReq = new Request('http://127.0.0.1/plan/test', {
      headers: { Host: '127.0.0.1', Origin: 'http://evil.test', [SESSION_TOKEN_HEADER]: 'secret-token' },
    })
    expect((await app.fetch(planReq)).status).toBe(403)
    const apiReq = new Request('http://127.0.0.1/api/ping', {
      headers: { Host: '127.0.0.1', Origin: 'http://evil.test', [SESSION_TOKEN_HEADER]: 'secret-token' },
    })
    expect((await app.fetch(apiReq)).status).toBe(403)
  })

  it('accepts a matching Origin/Host header with the correct token on HTML and API routes', async () => {
    const app = buildApp()
    const htmlReq = new Request('http://127.0.0.1/', {
      headers: { Host: '127.0.0.1', Origin: 'http://127.0.0.1', [SESSION_TOKEN_HEADER]: 'secret-token' },
    })
    expect((await app.fetch(htmlReq)).status).toBe(200)
    const apiReq = new Request('http://127.0.0.1/api/ping', {
      headers: { Host: '127.0.0.1', Origin: 'http://127.0.0.1', [SESSION_TOKEN_HEADER]: 'secret-token' },
    })
    expect((await app.fetch(apiReq)).status).toBe(200)
  })
})

describe('injectSessionTokenIntoHtml', () => {
  it('injects a global token script before </head>', () => {
    const html = '<html><head><title>x</title></head><body></body></html>'
    const out = injectSessionTokenIntoHtml(html, 'abc"123\\token')
    expect(out).toContain('window.__DIFFING_SESSION_TOKEN__="abc\\"123\\\\token"')
    expect(out.indexOf('<script>window.__DIFFING_SESSION_TOKEN__')).toBeLessThan(out.indexOf('</head>'))
  })

  it('returns html unchanged when no token is configured', () => {
    const html = '<html><head></head></html>'
    expect(injectSessionTokenIntoHtml(html, null)).toBe(html)
  })
})

describe('session-url', () => {
  it('returns clean browseable URLs without auth query params', () => {
    const lock: ServerLock = {
      port: 4321,
      host: '127.0.0.1',
      pid: 1,
      repoRoot: '/repo',
      startedAt: 1,
      version: 'test',
      authToken: 'abc123',
    }
    expect(reviewSessionUrl(lock)).toBe('http://127.0.0.1:4321')
    expect(appendSessionToken('http://127.0.0.1:4321/gh/pr', 'abc123'))
      .toBe('http://127.0.0.1:4321/gh/pr')
    expect(appendSessionToken('http://127.0.0.1:4321/?token=legacy', 'abc123'))
      .toBe('http://127.0.0.1:4321/')
  })

  it('joins API paths without inserting path after query params', () => {
    expect(joinSessionApiUrl('http://127.0.0.1:4321/?token=abc123', '/api/ping'))
      .toBe('http://127.0.0.1:4321/api/ping')
    expect(joinSessionApiUrl('http://127.0.0.1:4321/gh/pr?token=abc123', '/api/diff'))
      .toBe('http://127.0.0.1:4321/api/diff')
  })
})
