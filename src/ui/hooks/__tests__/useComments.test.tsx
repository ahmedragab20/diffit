import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useComments } from '../useComments.js'
import type { ReviewComment } from '../../../lib/types.js'

const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

const sampleComments: ReviewComment[] = [
  {
    id: 'c1',
    filePath: 'src/index.ts',
    side: 'additions',
    lineNumber: 10,
    lineContent: 'const x = 1',
    body: 'Consider renaming',
    status: 'open',
    createdAt: 1000,
    replies: [],
  },
  {
    id: 'c2',
    filePath: 'src/app.ts',
    side: 'deletions',
    lineNumber: 5,
    lineContent: 'oldCode()',
    body: 'Remove this',
    status: 'open',
    createdAt: 2000,
    replies: [{ id: 'r1', body: 'Done', createdAt: 3000, role: 'agent', model: 'claude-3-5-sonnet' }],
  },
]

function mockApi() {
  mockFetch.mockImplementation((url: string | URL, options?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    if (urlStr === '/api/comments' && (!options || options.method === 'GET' || !options.method)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleComments) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
  })
}

describe('useComments', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('loads comments on mount', async () => {
    mockApi()
    const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.comments).toHaveLength(2)
    })

    expect(result.current.comments).toEqual(sampleComments)
  })

  it('adds a comment via mutation', async () => {
    const newComment: ReviewComment = {
      id: 'c3',
      filePath: 'src/index.ts',
      side: 'additions',
      lineNumber: 15,
      lineContent: 'newFn()',
      body: 'Nice addition',
      status: 'open',
      createdAt: 4000,
      replies: [],
    }

    mockFetch.mockImplementation((url: string | URL, options?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr === '/api/comments' && options?.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(newComment) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    })

    const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.comments).toEqual([]))

    await act(async () => {
      await result.current.addComment('src/index.ts', 'additions', 15, 'newFn()', 'Nice addition')
    })

    expect(mockFetch).toHaveBeenCalledWith('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: 'src/index.ts',
        side: 'additions',
        lineNumber: 15,
        lineContent: 'newFn()',
        body: 'Nice addition',
      }),
    })

    await waitFor(() => {
      expect(result.current.comments).toHaveLength(1)
    })
  })

  it('rejects a failed add and leaves the cached comments unchanged', async () => {
    mockApi()
    const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.comments).toHaveLength(2))
    mockFetch.mockImplementation((url: string | URL, options?: RequestInit) => {
      if (String(url) === '/api/comments' && options?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'server down' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleComments) })
    })
    await expect(result.current.addComment('x.ts', 'additions', 1, 'x', 'body')).rejects.toThrow('server down')
    expect(result.current.comments).toEqual(sampleComments)
  })

  it('does not duplicate a comment when creation returns an existing id', async () => {
    mockApi()
    const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.comments).toHaveLength(2))
    mockFetch.mockImplementation((url: string | URL, options?: RequestInit) => {
      if (String(url) === '/api/comments' && options?.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleComments[0]) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleComments) })
    })
    await act(async () => {
      await result.current.addComment('src/index.ts', 'additions', 10, 'const x = 1', 'Updated')
    })
    expect(result.current.comments.filter((comment) => comment.id === 'c1')).toHaveLength(1)
  })

  it('removes a comment via mutation', async () => {
    mockApi()
    const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.comments).toHaveLength(2))

    await act(async () => {
      result.current.removeComment('c1')
    })

    expect(mockFetch).toHaveBeenCalledWith('/api/comments/c1', { method: 'DELETE' })
  })

  it('edits a comment via mutation', async () => {
    const updatedComment: ReviewComment = { ...sampleComments[0], body: 'Updated body' }

    mockFetch.mockImplementation((url: string | URL, options?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.startsWith('/api/comments/') && options?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(updatedComment) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleComments) })
    })

    const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.comments).toHaveLength(2))

    await act(async () => {
      result.current.editComment('c1', 'Updated body')
    })

    expect(mockFetch).toHaveBeenCalledWith('/api/comments/c1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Updated body' }),
    })
  })

  it('resolves a comment via mutation', async () => {
    const resolvedComment: ReviewComment = { ...sampleComments[0], status: 'resolved' }

    mockFetch.mockImplementation((url: string | URL, options?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.startsWith('/api/comments/') && options?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(resolvedComment) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleComments) })
    })

    const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.comments).toHaveLength(2))

    await act(async () => {
      result.current.resolveComment('c1')
    })

    expect(mockFetch).toHaveBeenCalledWith('/api/comments/c1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    })
  })

  describe('getAnnotationsForFile', () => {
    it('returns annotations for a specific file', async () => {
      mockApi()
      const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
      await waitFor(() => expect(result.current.comments).toHaveLength(2))

      const annotations = result.current.getAnnotationsForFile('src/index.ts')
      expect(annotations).toHaveLength(1)
      expect(annotations[0]).toEqual({
        side: 'additions',
        lineNumber: 10,
        metadata: sampleComments[0],
      })
    })

    it('returns empty array for file with no comments', async () => {
      mockApi()
      const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
      await waitFor(() => expect(result.current.comments).toHaveLength(2))

      const annotations = result.current.getAnnotationsForFile('src/other.ts')
      expect(annotations).toEqual([])
    })
  })

  describe('formatAllComments', () => {
    it('returns empty string when no comments', async () => {
      mockFetch.mockResolvedValue({ json: () => Promise.resolve([]) })

      const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
      await waitFor(() => expect(result.current.comments).toEqual([]))

      expect(result.current.formatAllComments()).toBe('')
    })

    it('formats comments as XML', async () => {
      mockApi()
      const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
      await waitFor(() => expect(result.current.comments).toHaveLength(2))

      const formatted = result.current.formatAllComments()
      expect(formatted).toContain('<code-review-comments>')
      expect(formatted).toContain('</code-review-comments>')
      expect(formatted).toContain('<instructions>')
      expect(formatted).toContain('You are an AI coding assistant.')
      expect(formatted).toContain('HOW TO REPLY OR ASK FOR CLARIFICATION:')
      expect(formatted).toContain('<comment-replies>')
      expect(formatted).toContain('<file path="src/index.ts">')
      expect(formatted).toContain('<comment id="c1" line="10" side="additions" status="open" created-at="1970-01-01T00:00:01.000Z">')
      expect(formatted).toContain('<code><![CDATA[+ const x = 1]]></code>')
      expect(formatted).toContain('<body><![CDATA[Consider renaming]]></body>')
      expect(formatted).toContain('<file path="src/app.ts">')
      expect(formatted).toContain('<comment id="c2" line="5" side="deletions" status="open" created-at="1970-01-01T00:00:02.000Z">')
      expect(formatted).toContain('<code><![CDATA[- oldCode()]]></code>')
      expect(formatted).toContain('<body><![CDATA[Remove this]]></body>')
      expect(formatted).toContain('<replies>')
      expect(formatted).toContain('<reply id="r1" created-at="1970-01-01T00:00:03.000Z" role="agent" model="claude-3-5-sonnet">')
      expect(formatted).toContain('<![CDATA[Done]]>')
    })
  })

  describe('copyAllComments', () => {
    it('copies formatted comments to clipboard', async () => {
      const writeText = vi.fn()
      Object.assign(navigator, { clipboard: { writeText } })

      mockApi()
      const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
      await waitFor(() => expect(result.current.comments).toHaveLength(2))

      await act(async () => {
        await result.current.copyAllComments()
      })

      expect(writeText).toHaveBeenCalledWith(result.current.formatAllComments())
    })
  })

  describe('agent handoff', () => {
    it('sendToAgent POSTs the chosen verdict to /api/review/send', async () => {
      mockApi()
      const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
      await waitFor(() => expect(result.current.comments).toHaveLength(2))

      await act(async () => {
        await result.current.sendToAgent('approved')
      })

      expect(mockFetch).toHaveBeenCalledWith('/api/review/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', force: false }),
      })
    })

    it('sendToAgent forwards the verdict and an overall comment in the request body', async () => {
      mockApi()
      const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
      await waitFor(() => expect(result.current.comments).toHaveLength(2))

      await act(async () => {
        await result.current.sendToAgent('changes-requested', 'Please prioritise the security fixes')
      })

      expect(mockFetch).toHaveBeenCalledWith('/api/review/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'changes-requested',
          generalComment: 'Please prioritise the security fixes',
          force: false,
        }),
      })
    })

    it('sendToAgent retries with force=true when secrets are detected', async () => {
      let calls = 0
      mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr === '/api/comments' && (!init || init.method === 'GET' || !init.method)) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleComments) })
        }
        if (urlStr === '/api/review/send') {
          calls++
          if (calls === 1) {
            return Promise.resolve({
              ok: false,
              status: 400,
              json: () => Promise.resolve({ ok: false, error: 'secrets-detected', findings: [] }),
            } as unknown as Response)
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ok: true, round: 1, openCount: 0, waiters: 0 }),
          } as unknown as Response)
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as unknown as Response)
      })
      const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
      await waitFor(() => expect(result.current.comments).toHaveLength(2))

      await act(async () => {
        try {
          await result.current.sendToAgent('approved')
          throw new Error('expected secrets-detected error')
        } catch (err: any) {
          expect(err.kind).toBe('secrets')
          // Simulate the popover confirming force-send.
          await result.current.sendToAgent('approved', undefined, 'standard', true)
        }
      })

      // First call: no force flag.
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/review/send',
        expect.objectContaining({ method: 'POST', body: expect.stringContaining('"force":false') }),
      )
      // Second call: force=true.
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/review/send',
        expect.objectContaining({ method: 'POST', body: expect.stringContaining('"force":true') }),
      )
    })

    it('agentWaiting reflects the seeded review status', async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr === '/api/review/status') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ round: 0, waiters: 1, lastSentAt: null }) })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      })
      const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
      await waitFor(() => expect(result.current.agentWaiting).toBe(true))
    })

    it('resolveAllOpen POSTs to /api/comments/resolve-all and refetches', async () => {
      mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr === '/api/comments' && (!init || init.method === 'GET' || !init.method)) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleComments) })
        }
        if (urlStr === '/api/comments/resolve-all' && init?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ok: true, resolved: 3 }),
          } as unknown as Response)
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as unknown as Response)
      })
      const { result } = renderHook(() => useComments(), { wrapper: createWrapper() })
      await waitFor(() => expect(result.current.comments).toHaveLength(2))

      await act(async () => {
        const resolved = await result.current.resolveAllOpen()
        expect(resolved.resolved).toBe(3)
      })
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/comments/resolve-all',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })
})
