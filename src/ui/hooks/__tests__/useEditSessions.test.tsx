import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useEditSessions } from '../useEditSessions.js'
import { computeEditMarkers } from '../../lib/editMarkers'
import type { ReviewComment } from '../../../lib/types.js'

// Hoisted editor class so the module mock factory can reference it.
const MockEditor = vi.hoisted(() =>
  class {
    setMarkers = vi.fn()
    focus = vi.fn()
  },
)

// Hoisted live handlers so tests can drive diagnostics.
const liveHandlers = vi.hoisted(() => new Map<string, (raw: string) => void>())
vi.mock('../../live', () => ({
  subscribeLive: (event: string, handler: (raw: string) => void) => {
    liveHandlers.set(event, handler)
    return () => liveHandlers.delete(event)
  },
}))

vi.mock('../../lib/editModule', () => ({
  ensureEditModuleLoaded: vi.fn(async () => {}),
  getEditorClass: () => MockEditor,
}))

const mockFetch = vi.fn()

const reviewComment: ReviewComment = {
  id: 'c1',
  filePath: 'a/b.ts',
  side: 'additions',
  lineNumber: 3,
  lineContent: 'x',
  body: 'body',
  status: 'open',
  createdAt: 1,
  replies: [],
}

/** Default /api/file-text + /api/edit-save + /api/code-intel/document routing. */
function mockApi({
  content = 'const x = 1',
  hash = 'abc123',
  saveResponse,
}: {
  content?: string
  hash?: string
  saveResponse?: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>
} = {}) {
  mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    if (u.startsWith('/api/file-text')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ content, missing: false, hash }) })
    }
    if (u === '/api/edit-save' && init?.method === 'POST') {
      return saveResponse
        ? saveResponse()
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, hash: 'saved123' }) })
    }
    if (u.includes('/api/code-intel/document')) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const hookProps = (diagnosticsEnabled: boolean, codeIntelEnabled = false) => ({
  diagnosticsEnabled,
  codeIntelEnabled,
})

const documentPosts = () =>
  mockFetch.mock.calls
    .filter(([url]) => String(url).includes('/api/code-intel/document'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)))

describe('useEditSessions', () => {
  it('enterEdit fetches file-text, seeds the session (draft/hash/dirty), and encodes the path', async () => {
    mockApi({ content: 'const x = 1', hash: 'abc123' })
    const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })

    await act(async () => {
      await result.current.enterEdit('a/b.ts')
    })

    expect(mockFetch).toHaveBeenCalledWith('/api/file-text?path=a%2Fb.ts&version=new')
    const session = result.current.sessions.get('a/b.ts')
    expect(session?.draft).toBe('const x = 1')
    expect(session?.seedContent).toBe('const x = 1')
    expect(session?.baseHash).toBe('abc123')
    expect(session?.dirty).toBe(false)
  })

  it('enterEdit is a no-op when a session already exists for the path', async () => {
    mockApi({ content: 'v1', hash: 'h1' })
    const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })

    await act(async () => {
      await result.current.enterEdit('a/b.ts')
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)

    mockFetch.mockClear()
    await act(async () => {
      await result.current.enterEdit('a/b.ts')
    })
    // No second file-text fetch and no change to baseHash.
    expect(mockFetch).not.toHaveBeenCalled()
    expect(result.current.sessions.get('a/b.ts')?.baseHash).toBe('h1')
  })

  it('enterEdit throws when file-text reports missing and when res.ok is false', async () => {
    // missing: true
    mockFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ missing: true }) }),
    )
    const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })
    await act(async () => {
      await expect(result.current.enterEdit('a/b.ts')).rejects.toThrow('File not found on disk')
    })

    // !res.ok
    mockFetch.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }),
    )
    await act(async () => {
      await expect(result.current.enterEdit('a/b.ts')).rejects.toThrow('boom')
    })

    // !res.ok with no error body → HTTP fallback message.
    mockFetch.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) }),
    )
    await act(async () => {
      await expect(result.current.enterEdit('a/b.ts')).rejects.toThrow('HTTP 500 loading a/b.ts')
    })
  })

  it('handleEditChange tracks draft+dirty; EOL-normalized identical content is not dirty', async () => {
    mockApi({ content: 'a\r\nb', hash: 'h1' })
    const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })
    await act(async () => {
      await result.current.enterEdit('a/b.ts')
    })

    // Different content → dirty.
    act(() => {
      result.current.handleEditChange('a/b.ts', { contents: 'a\nchanged' } as any)
    })
    expect(result.current.sessions.get('a/b.ts')?.draft).toBe('a\nchanged')
    expect(result.current.sessions.get('a/b.ts')?.dirty).toBe(true)

    // Identical after EOL normalization → not dirty.
    act(() => {
      result.current.handleEditChange('a/b.ts', { contents: 'a\nb' } as any)
    })
    expect(result.current.sessions.get('a/b.ts')?.draft).toBe('a\nb')
    expect(result.current.sessions.get('a/b.ts')?.dirty).toBe(false)
  })

  it('observes the latest remapped annotations without a version bump', async () => {
    mockApi({ content: 'const x = 1', hash: 'h1' })
    const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })
    await act(async () => {
      await result.current.enterEdit('a/b.ts')
    })

    const first = [{ side: 'additions', lineNumber: 10, metadata: reviewComment }]
    const latest = [{ side: 'additions', lineNumber: 11, metadata: reviewComment }]
    act(() => {
      result.current.handleEditChange('a/b.ts', { contents: 'aaa' } as any, first as any)
      result.current.handleEditChange('a/b.ts', { contents: 'aab' } as any, latest as any)
    })
    expect(result.current.sessions.get('a/b.ts')?.annotations).toEqual(latest)
    expect(result.current.sessions.get('a/b.ts')?.annotationsVersion).toBe(0)
  })

  it('saveEdit POSTs draft + baseHash + published anchors only (ReviewComment metadata, positive lines)', async () => {
    mockApi({ content: 'seed', hash: 'base-hash' })
    const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })
    await act(async () => {
      await result.current.enterEdit('a/b.ts')
    })

    const annotations = [
      // ReviewComment → included.
      { side: 'additions', lineNumber: 3, metadata: reviewComment },
      // lineNumber <= 0 → excluded.
      { side: 'additions', lineNumber: 0, metadata: { ...reviewComment, id: 'c0' } },
      // _pending → excluded.
      { side: 'deletions', lineNumber: 5, metadata: { _pending: true } },
      // _existingPr → excluded.
      { side: 'deletions', lineNumber: 6, metadata: { _existingPr: true, comment: { id: 1 } } },
    ]
    act(() => {
      result.current.handleEditChange('a/b.ts', { contents: 'edited content' } as any, annotations as any)
    })

    await act(async () => {
      await result.current.saveEdit('a/b.ts')
    })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/edit-save',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: 'a/b.ts',
          content: 'edited content',
          baseHash: 'base-hash',
          anchorUpdates: [{ id: 'c1', side: 'additions', lineNumber: 3 }],
        }),
      }),
    )
  })

  it('saveEdit 409 conflict sets error, keeps dirty, saving false', async () => {
    mockApi({
      content: 'seed',
      hash: 'base-hash',
      saveResponse: () =>
        Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ conflict: true, error: 'conflict' }) }),
    })
    const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })
    await act(async () => {
      await result.current.enterEdit('a/b.ts')
    })
    act(() => {
      result.current.handleEditChange('a/b.ts', { contents: 'edited' } as any)
    })

    await act(async () => {
      await result.current.saveEdit('a/b.ts')
    })

    const session = result.current.sessions.get('a/b.ts')
    expect(session?.error).toBe(
      'The file changed on disk since this edit session started. Reload or discard.',
    )
    expect(session?.dirty).toBe(true)
    expect(session?.saving).toBe(false)
  })

  it('saveEdit success updates seedContent + baseHash, clears dirty/error/saving', async () => {
    mockApi({ content: 'seed', hash: 'base-hash' })
    const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })
    await act(async () => {
      await result.current.enterEdit('a/b.ts')
    })
    act(() => {
      result.current.handleEditChange('a/b.ts', { contents: 'saved content' } as any)
    })

    await act(async () => {
      await result.current.saveEdit('a/b.ts')
    })

    const session = result.current.sessions.get('a/b.ts')
    expect(session?.seedContent).toBe('saved content')
    expect(session?.draft).toBe('saved content')
    expect(session?.dirty).toBe(false)
    expect(session?.baseHash).toBe('saved123')
    expect(session?.saving).toBe(false)
    expect(session?.error).toBe(null)
  })

  it('typing while save is pending preserves the later draft as dirty', async () => {
    let resolveSave!: () => void
    const saveDone = new Promise<void>((resolve) => { resolveSave = resolve })
    mockApi({
      content: 'seed',
      hash: 'base-hash',
      saveResponse: async () => {
        await saveDone
        return { ok: true, json: () => Promise.resolve({ ok: true, hash: 'saved123' }) }
      },
    })
    const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })
    await act(async () => { await result.current.enterEdit('a/b.ts') })
    act(() => { result.current.handleEditChange('a/b.ts', { contents: 'sent snapshot' } as any) })
    let save!: Promise<void>
    act(() => { save = result.current.saveEdit('a/b.ts') })
    await waitFor(() => expect(result.current.sessions.get('a/b.ts')?.saving).toBe(true))
    act(() => { result.current.handleEditChange('a/b.ts', { contents: 'typed while saving' } as any) })
    resolveSave()
    await act(async () => { await save })
    const session = result.current.sessions.get('a/b.ts')
    expect(session?.seedContent).toBe('sent snapshot')
    expect(session?.draft).toBe('typed while saving')
    expect(session?.dirty).toBe(true)
  })

  it('discardEdit restores seed, clears dirty, bumps sessionKey, nulls annotations', async () => {
    mockApi({ content: 'original', hash: 'h1' })
    const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })
    await act(async () => {
      await result.current.enterEdit('a/b.ts')
    })
    const before = result.current.sessions.get('a/b.ts')
    act(() => {
      result.current.handleEditChange('a/b.ts', { contents: 'unsaved edit' } as any, [
        { side: 'additions', lineNumber: 3, metadata: reviewComment },
      ] as any)
    })

    act(() => {
      result.current.discardEdit('a/b.ts')
    })

    const session = result.current.sessions.get('a/b.ts')
    expect(session?.draft).toBe('original')
    expect(session?.seedContent).toBe('original')
    expect(session?.dirty).toBe(false)
    expect(session?.annotations).toBe(null)
    expect(session?.sessionKey).toBe((before?.sessionKey ?? 0) + 1)
  })

  it('exitEdit removes the session from the map', async () => {
    mockApi({ content: 'seed', hash: 'h1' })
    const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })
    await act(async () => {
      await result.current.enterEdit('a/b.ts')
    })
    expect(result.current.sessions.has('a/b.ts')).toBe(true)

    act(() => {
      result.current.exitEdit('a/b.ts')
    })
    expect(result.current.sessions.has('a/b.ts')).toBe(false)
  })

  it('dirtyCount counts only dirty sessions across multiple paths', async () => {
    mockApi({ content: 'seed', hash: 'h1' })
    const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })
    await act(async () => {
      await result.current.enterEdit('a/b.ts')
      await result.current.enterEdit('c/d.ts')
    })
    expect(result.current.dirtyCount).toBe(0)

    act(() => {
      result.current.handleEditChange('a/b.ts', { contents: 'CHANGED' } as any)
      // c/d.ts untouched → stays clean.
    })
    expect(result.current.dirtyCount).toBe(1)

    act(() => {
      result.current.handleEditChange('c/d.ts', { contents: 'ALSO CHANGED' } as any)
    })
    expect(result.current.dirtyCount).toBe(2)
  })

  it('saveAllDirty saves only dirty paths', async () => {
    mockApi({ content: 'seed', hash: 'h1' })
    const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })
    await act(async () => {
      await result.current.enterEdit('a/b.ts')
      await result.current.enterEdit('c/d.ts')
    })

    act(() => {
      result.current.handleEditChange('a/b.ts', { contents: 'CHANGED' } as any)
    })

    const saveSpy = vi.spyOn(result.current, 'saveEdit')
    await act(async () => {
      await result.current.saveAllDirty()
    })

    const calls = mockFetch.mock.calls.filter(([u]) => String(u) === '/api/edit-save')
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0][1].body)
    expect(body.filePath).toBe('a/b.ts')
    saveSpy.mockRestore()
  })

  it('markers clear when diagnostics disabled on attach; recompute non-empty after flow', async () => {
    mockApi({ content: 'const x = 1', hash: 'h1' })
    const { result, rerender } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false) })
    await act(async () => {
      await result.current.enterEdit('a/b.ts')
    })

    const editor = new MockEditor()
    act(() => {
      result.current.handleEditAttach('a/b.ts', editor as any)
    })
    expect(editor.focus).toHaveBeenCalled()
    // Attach defers the marker refresh to the next macrotask (setTimeout 0);
    // wait for it instead of asserting synchronously.
    await waitFor(() => {
      expect(editor.setMarkers).toHaveBeenCalledWith([])
    })

    // Re-enable diagnostics, then modify the draft (adds trailing whitespace).
    rerender(hookProps(true))
    editor.setMarkers.mockClear()
    act(() => {
      result.current.handleEditChange('a/b.ts', { contents: 'const x = 1  \n' } as any)
    })

    const expected = computeEditMarkers('const x = 1  \n', 'a/b.ts')
    expect(expected.length).toBeGreaterThan(0)
    await waitFor(
      () => {
        expect(editor.setMarkers).toHaveBeenLastCalledWith(expected)
      },
      { timeout: 1000 },
    )
  })

  it('toggling diagnosticsEnabled immediately recomputes/clears markers for attached editors without content change', async () => {
    // Seed the draft with trailing whitespace so the diagnostics-ON payload is
    // non-empty and distinguishable from the cleared OFF state.
    mockApi({ content: 'const x = 1  \n', hash: 'h1' })
    const { result, rerender } = renderHook((p) => useEditSessions(p), {
      initialProps: hookProps(false),
    })
    await act(async () => {
      await result.current.enterEdit('a/b.ts')
    })

    const editor = new MockEditor()
    act(() => {
      result.current.handleEditAttach('a/b.ts', editor as any)
    })
    await waitFor(() => {
      expect(editor.setMarkers).toHaveBeenCalledWith([])
    })

    // Toggle diagnostics ON → markers recomputed immediately, no content edit.
    rerender(hookProps(true))
    const expected = computeEditMarkers('const x = 1  \n', 'a/b.ts')
    expect(expected.length).toBeGreaterThan(0)
    expect(editor.setMarkers).toHaveBeenLastCalledWith(expected)

    // Toggle diagnostics OFF → markers cleared immediately.
    rerender(hookProps(false))
    expect(editor.setMarkers).toHaveBeenLastCalledWith([])
  })

  it('attach with diagnostics enabled eventually sets non-empty markers for a trailing-whitespace seed', async () => {
    mockApi({ content: 'const x = 1  \n', hash: 'h1' })
    const { result } = renderHook((p) => useEditSessions(p), {
      initialProps: hookProps(true),
    })
    await act(async () => {
      await result.current.enterEdit('a/b.ts')
    })

    const editor = new MockEditor()
    act(() => {
      result.current.handleEditAttach('a/b.ts', editor as any)
    })
    expect(editor.focus).toHaveBeenCalled()
    expect(editor.setMarkers).not.toHaveBeenCalled()

    const expected = computeEditMarkers('const x = 1  \n', 'a/b.ts')
    expect(expected.length).toBeGreaterThan(0)
    await waitFor(() => {
      expect(editor.setMarkers).toHaveBeenCalledWith(expected)
    })
  })

  describe('useEditSessions code intel', () => {
    it('pushes the draft to the language server on attach', async () => {
      mockApi()
      const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(true, true) })
      await act(async () => {
        await result.current.enterEdit('a/b.ts')
      })

      const editor = new MockEditor()
      act(() => {
        result.current.handleEditAttach('a/b.ts', editor as any)
      })

      await waitFor(() => expect(documentPosts()).toHaveLength(1))
      const post = documentPosts()[0]
      expect(post.op).toBe('change')
      expect(post.path).toBe('a/b.ts')
      expect(typeof post.version).toBe('number')
    })

    it('pushes nothing when code intel is off', async () => {
      mockApi()
      const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(true, false) })
      await act(async () => {
        await result.current.enterEdit('a/b.ts')
      })

      const editor = new MockEditor()
      act(() => {
        result.current.handleEditAttach('a/b.ts', editor as any)
      })

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400))
      })

      expect(documentPosts()).toHaveLength(0)
    })

    it('pushes nothing when edit diagnostics are off', async () => {
      mockApi()
      const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(false, true) })
      await act(async () => {
        await result.current.enterEdit('a/b.ts')
      })

      const editor = new MockEditor()
      act(() => {
        result.current.handleEditAttach('a/b.ts', editor as any)
      })

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400))
      })

      expect(documentPosts()).toHaveLength(0)
    })

    it('merges server markers into the built-in ones', async () => {
      mockApi()
      const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(true, true) })
      await act(async () => {
        await result.current.enterEdit('a/b.ts')
      })

      const editor = new MockEditor()
      act(() => {
        result.current.handleEditAttach('a/b.ts', editor as any)
      })

      await waitFor(() => expect(documentPosts()).toHaveLength(1))

      act(() => {
        liveHandlers.get('code-intel-diagnostics')!(
          JSON.stringify({
            path: 'a/b.ts',
            markers: [
              {
                severity: 'error',
                message: 'boom',
                source: 'typescript',
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
            ],
          }),
        )
      })

      await waitFor(() => {
        const calls = editor.setMarkers.mock.calls
        expect(calls.length).toBeGreaterThan(0)
        const lastCall = calls[calls.length - 1][0]
        expect(lastCall).toContainEqual(expect.objectContaining({ message: 'boom' }))
      })
    })

    it('drops a batch that names a different version', async () => {
      mockApi()
      const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(true, true) })
      await act(async () => {
        await result.current.enterEdit('a/b.ts')
      })

      const editor = new MockEditor()
      act(() => {
        result.current.handleEditAttach('a/b.ts', editor as any)
      })

      await waitFor(() => expect(documentPosts()).toHaveLength(1))

      act(() => {
        liveHandlers.get('code-intel-diagnostics')!(
          JSON.stringify({
            path: 'a/b.ts',
            version: 9999,
            markers: [
              {
                severity: 'error',
                message: 'boom',
                source: 'typescript',
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
            ],
          }),
        )
      })

      // A rejected batch still refreshes the markers; what matters is that the
      // server's marker is not among them.
      const lastCall =
        editor.setMarkers.mock.calls[editor.setMarkers.mock.calls.length - 1][0]
      expect(lastCall).not.toContainEqual(
        expect.objectContaining({ message: 'boom' }),
      )
    })

    it('ignores a batch for a file with no open draft', async () => {
      mockApi()
      const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(true, true) })
      await act(async () => {
        await result.current.enterEdit('a/b.ts')
      })

      const editor = new MockEditor()
      act(() => {
        result.current.handleEditAttach('a/b.ts', editor as any)
      })

      await waitFor(() => expect(documentPosts()).toHaveLength(1))

      const initialCalls = editor.setMarkers.mock.calls.length
      act(() => {
        liveHandlers.get('code-intel-diagnostics')!(
          JSON.stringify({
            path: 'other/file.ts',
            markers: [
              {
                severity: 'error',
                message: 'boom',
                source: 'typescript',
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
            ],
          }),
        )
      })

      // Wait a bit to ensure no async state changes happen
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
      })

      // setMarkers should not have been called for the other file; check that no boom exists
      for (const call of editor.setMarkers.mock.calls) {
        expect(call[0]).not.toContainEqual(expect.objectContaining({ message: 'boom' }))
      }
    })

    it('drops held server markers when the next draft is pushed', async () => {
      mockApi()
      const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(true, true) })
      await act(async () => {
        await result.current.enterEdit('a/b.ts')
      })

      const editor = new MockEditor()
      act(() => {
        result.current.handleEditAttach('a/b.ts', editor as any)
      })

      await waitFor(() => expect(documentPosts()).toHaveLength(1))

      act(() => {
        liveHandlers.get('code-intel-diagnostics')!(
          JSON.stringify({
            path: 'a/b.ts',
            markers: [
              {
                severity: 'error',
                message: 'boom',
                source: 'typescript',
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
            ],
          }),
        )
      })

      await waitFor(() => {
        const lastCall = editor.setMarkers.mock.calls[editor.setMarkers.mock.calls.length - 1][0]
        expect(lastCall).toContainEqual(expect.objectContaining({ message: 'boom' }))
      })

      act(() => {
        result.current.handleEditChange('a/b.ts', { contents: 'const x = 2' } as any)
      })

      await waitFor(() => expect(documentPosts().length).toBeGreaterThan(1), { timeout: 1500 })

      const lastCall = editor.setMarkers.mock.calls[editor.setMarkers.mock.calls.length - 1][0]
      expect(lastCall).not.toContainEqual(expect.objectContaining({ message: 'boom' }))
    })

    it('closes the document when the edit session ends', async () => {
      mockApi()
      const { result } = renderHook((p) => useEditSessions(p), { initialProps: hookProps(true, true) })
      await act(async () => {
        await result.current.enterEdit('a/b.ts')
      })

      const editor = new MockEditor()
      act(() => {
        result.current.handleEditAttach('a/b.ts', editor as any)
      })

      await waitFor(() => expect(documentPosts()).toHaveLength(1))

      act(() => {
        result.current.exitEdit('a/b.ts')
      })

      const posts = documentPosts()
      expect(posts).toContainEqual(expect.objectContaining({ op: 'close', path: 'a/b.ts' }))
    })
  })
})