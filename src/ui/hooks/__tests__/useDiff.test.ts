import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useDiff } from '../useDiff.js'

const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const diffData = {
  patch: 'diff --git a/src/index.ts b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n',
  repoName: 'test-repo',
  branch: 'feature',
  customMode: false,
  binaryFiles: [],
  tabSizeMap: { 'src/index.ts': 2 },
  untrackedFiles: [],
}

describe('useDiff', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('starts in loading state', () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useDiff({ staged: true, untracked: true }))
    expect(result.current.loading).toBe(true)
    expect(result.current.error).toBeNull()
    expect(result.current.patch).toBeNull()
  })

  it('returns diff data on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(diffData),
    })

    const { result } = renderHook(() => useDiff({ staged: true, untracked: true }))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.patch).toBe(diffData.patch)
    expect(result.current.repoName).toBe('test-repo')
    expect(result.current.branch).toBe('feature')
    expect(result.current.customMode).toBe(false)
    expect(result.current.binaryFiles).toEqual([])
    expect(result.current.tabSizeMap).toEqual({ 'src/index.ts': 2 })
    expect(result.current.untrackedFiles).toEqual([])
    expect(result.current.complete).toBe(true)
    expect(result.current.omittedPaths).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('surfaces incomplete payloads', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ...diffData,
          complete: false,
          omittedPaths: ['outside-symlink.ts'],
        }),
    })

    const { result } = renderHook(() => useDiff({ staged: true, untracked: true }))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.complete).toBe(false)
    expect(result.current.omittedPaths).toEqual(['outside-symlink.ts'])
    expect(result.current.patch).toBe(diffData.patch)
  })

  it('sets error when fetch fails', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    })

    const { result } = renderHook(() => useDiff({ staged: true, untracked: true }))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('HTTP 500')
    expect(result.current.patch).toBeNull()
  })

  it('sets error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useDiff({ staged: true, untracked: true }))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('Network error')
  })

  it('re-fetches when options change', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(diffData),
    })

    const { result, rerender } = renderHook(
      (opts: { staged: boolean; untracked: boolean }) => useDiff(opts),
      { initialProps: { staged: true, untracked: true } },
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockFetch).toHaveBeenCalledWith('/api/diff?staged=true&untracked=true')

    mockFetch.mockClear()
    rerender({ staged: false, untracked: true })

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/diff?staged=false&untracked=true'))
  })

  it('returns default values for partial data', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ patch: 'diff' }),
    })

    const { result } = renderHook(() => useDiff({ staged: true, untracked: true }))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.repoName).toBe('')
    expect(result.current.branch).toBe('')
    expect(result.current.binaryFiles).toEqual([])
    expect(result.current.tabSizeMap).toEqual({})
    expect(result.current.untrackedFiles).toEqual([])
  })
})
