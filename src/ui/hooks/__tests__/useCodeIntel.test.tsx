// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeIntelTarget } from '../useCodeIntel'

vi.mock('../../live', () => ({ subscribeLive: () => () => {} }))

describe('useCodeIntel', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/capabilities')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ configured: true, extensions: ['ts'] }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ available: true, op: 'hover', hover: 'test' }),
      })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('probes nothing while the setting is off', async () => {
    const { useCodeIntel } = await import('../useCodeIntel')
    const { result } = renderHook(() => useCodeIntel({ enabled: false, staged: false }))

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.ready).toBe(false)
  })

  it('reports not ready when no language server is configured', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/capabilities')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ configured: false, extensions: [] }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ available: true, op: 'hover', hover: 'test' }),
      })
    })

    const { useCodeIntel } = await import('../useCodeIntel')
    const { result } = renderHook(() => useCodeIntel({ enabled: true, staged: false }))

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(result.current.capabilities).toBeTruthy()
    expect(result.current.ready).toBe(false)
  })

  it('reports not ready when the review cannot answer', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/capabilities')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ configured: true, extensions: ['ts'], unavailable: 'pull-request' }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ available: true, op: 'hover', hover: 'test' }),
      })
    })

    const { useCodeIntel } = await import('../useCodeIntel')
    const { result } = renderHook(() => useCodeIntel({ enabled: true, staged: false }))

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(result.current.capabilities).toBeTruthy()
    expect(result.current.ready).toBe(false)
  })

  it('becomes ready when configured and in scope', async () => {
    const { useCodeIntel } = await import('../useCodeIntel')
    const { result } = renderHook(() => useCodeIntel({ enabled: true, staged: false }))

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(result.current.ready).toBe(true)
    expect(result.current.capabilities?.configured).toBe(true)
  })

  it('requests no hover until the debounce elapses', async () => {
    const { useCodeIntel } = await import('../useCodeIntel')
    const { result } = renderHook(() => useCodeIntel({ enabled: true, staged: false }))

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(result.current.ready).toBe(true)

    const target: CodeIntelTarget = {
      path: 'src/a.ts',
      side: 'additions',
      line: 7,
      character: 2,
      tokenText: 'foo',
      anchor: document.createElement('span'),
    }

    await act(async () => {
      result.current.hoverToken(target)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1) // only capabilities
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/code-intel'),
      expect.any(Object),
    )

    await act(async () => {
      vi.advanceTimersByTime(250)
      await vi.runAllTimersAsync()
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/code-intel',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('coalesces a pointer sweep into one request', async () => {
    const { useCodeIntel } = await import('../useCodeIntel')
    const { result } = renderHook(() => useCodeIntel({ enabled: true, staged: false }))

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(result.current.ready).toBe(true)

    const target1: CodeIntelTarget = {
      path: 'src/a.ts',
      side: 'additions',
      line: 7,
      character: 2,
      tokenText: 'foo',
      anchor: document.createElement('span'),
    }

    const target2: CodeIntelTarget = {
      ...target1,
      line: 8,
    }

    const target3: CodeIntelTarget = {
      ...target1,
      line: 9,
    }

    await act(async () => {
      result.current.hoverToken(target1)
      vi.advanceTimersByTime(50)
      result.current.hoverToken(target2)
      vi.advanceTimersByTime(50)
      result.current.hoverToken(target3)
      vi.advanceTimersByTime(250)
      await vi.runAllTimersAsync()
    })

    const hoverPosts = fetchMock.mock.calls.filter((call) => {
      if (call[0] !== '/api/code-intel') return false
      const body = JSON.parse(String((call[1] as RequestInit).body)) as { op?: string }
      return body.op === 'hover'
    })
    expect(hoverPosts).toHaveLength(1)
  })

  it('asks nothing for a file with unsaved edits', async () => {
    const { useCodeIntel } = await import('../useCodeIntel')
    const { result } = renderHook(() =>
      useCodeIntel({
        enabled: true,
        staged: false,
        isDirty: () => true,
      }),
    )

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(result.current.ready).toBe(true)

    const target: CodeIntelTarget = {
      path: 'src/a.ts',
      side: 'additions',
      line: 7,
      character: 2,
      tokenText: 'foo',
      anchor: document.createElement('span'),
    }

    await act(async () => {
      result.current.hoverToken(target)
      vi.advanceTimersByTime(250)
      await vi.runAllTimersAsync()
    })

    const postCalls = fetchMock.mock.calls.filter((call) => call[0] === '/api/code-intel')
    expect(postCalls).toHaveLength(0)
  })

  it('serves a repeated position from cache', async () => {
    const { useCodeIntel } = await import('../useCodeIntel')
    const { result } = renderHook(() => useCodeIntel({ enabled: true, staged: false }))

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(result.current.ready).toBe(true)

    const target: CodeIntelTarget = {
      path: 'src/a.ts',
      side: 'additions',
      line: 7,
      character: 2,
      tokenText: 'foo',
      anchor: document.createElement('span'),
    }

    await act(async () => {
      result.current.hoverToken(target)
      vi.advanceTimersByTime(250)
      await vi.runAllTimersAsync()
    })

    expect(result.current.hover).toBeTruthy()

    await act(async () => {
      result.current.clearHover()
      vi.advanceTimersByTime(200)
    })

    await act(async () => {
      result.current.hoverToken(target)
      vi.advanceTimersByTime(250)
      await vi.runAllTimersAsync()
    })

    const hoverPosts = fetchMock.mock.calls.filter((call) => {
      if (call[0] !== '/api/code-intel') return false
      const body = JSON.parse(String((call[1] as RequestInit).body)) as { op?: string }
      return body.op === 'hover'
    })
    expect(hoverPosts).toHaveLength(1)
  })

  it('surfaces an explicit refusal rather than an empty hover', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/capabilities')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ configured: true, extensions: ['ts'] }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ available: false, reason: 'unsupported-language' }),
      })
    })

    const { useCodeIntel } = await import('../useCodeIntel')
    const { result } = renderHook(() => useCodeIntel({ enabled: true, staged: false }))

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(result.current.ready).toBe(true)

    const target: CodeIntelTarget = {
      path: 'src/a.ts',
      side: 'additions',
      line: 7,
      character: 2,
      tokenText: 'foo',
      anchor: document.createElement('span'),
    }

    await act(async () => {
      result.current.hoverToken(target)
      vi.advanceTimersByTime(250)
      await vi.runAllTimersAsync()
    })

    expect(result.current.hover?.status).toBe('unavailable')
    expect(result.current.hover?.reason).toBe('unsupported-language')
  })

  it('returns definition locations', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/capabilities')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ configured: true, extensions: ['ts'] }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          available: true,
          op: 'definition',
          locations: [{ path: 'src/b.ts', line: 3, character: 0, endLine: 3, endCharacter: 4, inRepository: true }],
        }),
      })
    })

    const { useCodeIntel } = await import('../useCodeIntel')
    const { result } = renderHook(() => useCodeIntel({ enabled: true, staged: false }))

    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(result.current.ready).toBe(true)

    const target: CodeIntelTarget = {
      path: 'src/a.ts',
      side: 'additions',
      line: 7,
      character: 2,
      tokenText: 'foo',
      anchor: document.createElement('span'),
    }

    const locations = await act(async () => {
      const result2 = await result.current.resolveDefinition(target)
      await vi.runAllTimersAsync()
      return result2
    })

    expect(locations).toEqual([{ path: 'src/b.ts', line: 3, character: 0, endLine: 3, endCharacter: 4, inRepository: true }])
  })

  it('returns rename edits for the open file', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/capabilities')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ configured: true, extensions: ['ts'] }),
        })
      }
      const body = JSON.parse(String(init?.body)) as { op?: string }
      if (body.op === 'rename') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              available: true,
              op: 'rename',
              edits: {
                edits: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 3 },
                    },
                    newText: 'bar',
                  },
                ],
                otherEdits: 0,
                otherFiles: 0,
              },
            }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ available: true, op: 'hover', hover: 'test' }),
      })
    })

    const { useCodeIntel } = await import('../useCodeIntel')
    const { result } = renderHook(() => useCodeIntel({ enabled: true, staged: false }))

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    const edits = await result.current.renameAt('src/a.ts', 1, 0, 'bar')
    expect(edits).toEqual({
      edits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          newText: 'bar',
        },
      ],
      otherEdits: 0,
      otherFiles: 0,
    })
  })

  it('returns a multi-file rename without applying it', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/capabilities')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ configured: true, extensions: ['ts'] }),
        })
      }
      const body = JSON.parse(String(init?.body)) as { op?: string }
      if (body.op === 'rename') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              available: true,
              op: 'rename',
              edits: { edits: [], otherEdits: 12, otherFiles: 4 },
            }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ available: true, op: 'hover', hover: 'test' }),
      })
    })

    const { useCodeIntel } = await import('../useCodeIntel')
    const { result } = renderHook(() => useCodeIntel({ enabled: true, staged: false }))

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    const edits = await result.current.renameAt('src/a.ts', 1, 0, 'bar')
    expect(edits).toEqual({ edits: [], otherEdits: 12, otherFiles: 4 })
  })
})
