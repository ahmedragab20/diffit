// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockHomedir = vi.fn()
const mockReadFileSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockRenameSync = vi.fn()

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: mockHomedir }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    renameSync: mockRenameSync,
  }
})

const DEFAULTS = {
  defaultMode: 'web' as const,
  staged: true,
  untracked: true,
  diffStyle: 'split' as const,
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
  density: 'comfortable' as const,
  autoCollapseLineThreshold: 400,
  requireViewAllBeforeSend: false,
  showStatusBar: true,
  savedReplies: [] as [],
  ignoreSpaceChange: false,
  ignoreAllSpace: false,
  aiModel: null,
  aiReasoningEffort: null,
  aiServiceTier: null,
  aiRailWidth: 360,
  aiPrivacyAcknowledged: false,
  aiSettingsExpanded: false,
  aiLanguageServers: {},
  aiEvidenceTools: true,
}

describe('settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHomedir.mockReturnValue('/home/test')
  })

  describe('loadSettings', () => {
    it('returns defaults when file missing', async () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
      const { loadSettings } = await import('../lib/settings.js')
      expect(loadSettings()).toEqual(DEFAULTS)
    })

    it('merges persisted values with defaults', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ staged: false, defaultTabSize: 2 }))
      const { loadSettings } = await import('../lib/settings.js')
      expect(loadSettings()).toEqual({ ...DEFAULTS, staged: false, defaultTabSize: 2 })
    })

    it('preserves browser setting', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ browser: 'firefox' }))
      const { loadSettings } = await import('../lib/settings.js')
      expect(loadSettings().browser).toBe('firefox')
    })

    it('falls back to web for an invalid default mode', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ defaultMode: 'terminal' }))
      const { loadSettings } = await import('../lib/settings.js')
      expect(loadSettings().defaultMode).toBe('web')
    })

    it('accepts languageServers as an alias for aiLanguageServers', async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          languageServers: {
            ts: { command: 'typescript-language-server', args: ['--stdio'] },
          },
        }),
      )
      const { loadSettings } = await import('../lib/settings.js')
      const settings = loadSettings()
      expect(settings.aiLanguageServers).toEqual({
        ts: { command: 'typescript-language-server', args: ['--stdio'] },
      })
      expect(settings.languageServers).toBeUndefined()
    })
  })

  describe('saveSettings', () => {
    it('merges partial and writes config', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify(DEFAULTS))
      const { saveSettings } = await import('../lib/settings.js')

      const result = saveSettings({ staged: false })
      expect(result.staged).toBe(false)
      expect(result.untracked).toBe(true)
      expect(mockMkdirSync).toHaveBeenCalledWith('/home/test/.config/diffing', { recursive: true })
      expect(mockWriteFileSync).toHaveBeenCalled()
    })

    it('preserves existing fields when merging', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ defaultTabSize: 8 }))
      const { saveSettings } = await import('../lib/settings.js')

      const result = saveSettings({ diffStyle: 'unified' })
      expect(result.defaultTabSize).toBe(8)
      expect(result.diffStyle).toBe('unified')
      expect(result.staged).toBe(true)
    })
  })
})
