import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useSettings } from '../useSettings.js'

const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const defaultSettings = {
  defaultMode: 'web',
  staged: true,
  untracked: true,
  diffStyle: 'split',
  defaultTabSize: 4,
  theme: 'rose-pine',
  editorIDE: 'default',
  lineDiffType: 'word',
  lineWrap: false,
  diffIndicators: 'classic',
  showLineNumbers: true,
  hunkSeparators: 'line-info',
  lineHoverHighlight: 'both',
  fontSize: 14,
  expandContextByDefault: false,
  collapsedContextThreshold: 10,
  expansionLineCount: 20,
  haptics: true,
  sounds: true,
  uiFont: null,
  monoFont: null,
  density: 'comfortable',
  autoCollapseLineThreshold: 400,
  requireViewAllBeforeSend: false,
  showStatusBar: true,
  savedReplies: [],
  ignoreSpaceChange: false,
  ignoreAllSpace: false,
  editDiagnostics: false,
  codeIntel: false,
  editPrediction: false,
  aiModel: null,
  aiReasoningEffort: null,
  aiServiceTier: null,
  aiRailWidth: 360,
  aiPrivacyAcknowledged: false,
  aiSettingsExpanded: false,
}

describe('useSettings', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('uses defaults initially and loads from API', async () => {
    const apiSettings = { staged: false, untracked: true, diffStyle: 'unified', defaultTabSize: 2 }
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve(apiSettings),
    })

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings).toEqual(defaultSettings)
    expect(result.current.loaded).toBe(false)

    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.settings).toEqual({ ...defaultSettings, ...apiSettings })
  })

  it('marks as loaded even on fetch error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useSettings())

    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.settings).toEqual(defaultSettings)
  })

  it('updateSettings merges and persists', async () => {
    const apiSettings = { ...defaultSettings }
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve(apiSettings),
    })

    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.loaded).toBe(true))

    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ...apiSettings, staged: false, defaultTabSize: 8 }),
    })

    await act(async () => {
      result.current.updateSettings({ staged: false, defaultTabSize: 8 })
    })

    expect(result.current.settings.staged).toBe(false)
    expect(result.current.settings.defaultTabSize).toBe(8)
    expect(result.current.settings.untracked).toBe(true)

    // Persistence is debounced and runs out of the state updater, so the PUT
    // lands shortly after the state change rather than synchronously.
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...apiSettings, staged: false, defaultTabSize: 8 }),
      }),
    )
  })

  it('mirrors global AI preferences into the surface settings copy', async () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve(defaultSettings) })
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => {
      window.dispatchEvent(new CustomEvent('diffing-ai-settings', {
        detail: { aiModel: 'cursor/runtime-key/cursor/sonnet' },
      }))
    })

    expect(result.current.settings.aiModel).toBe('cursor/runtime-key/cursor/sonnet')
  })
})
