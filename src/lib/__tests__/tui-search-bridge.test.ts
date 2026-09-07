import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getFileContent } = vi.hoisted(() => ({
  getFileContent: vi.fn(),
}))

vi.mock('../git.js', () => ({ getFileContent }))

import { loadTuiPreview } from '../tui-search-bridge.js'

describe('TUI search preview bridge', () => {
  beforeEach(() => {
    getFileContent.mockReset()
  })

  it('returns UTF-8 working-tree text', async () => {
    getFileContent.mockResolvedValue(Buffer.from('const answer = 42\n'))

    expect(await loadTuiPreview({ path: 'src/answer.ts' })).toEqual({
      path: 'src/answer.ts',
      content: 'const answer = 42\n',
      missing: false,
      binary: false,
      truncated: false,
    })
    expect(getFileContent).toHaveBeenCalledWith('src/answer.ts', 'new')
  })

  it('distinguishes missing and binary files', async () => {
    getFileContent.mockResolvedValueOnce(null)
    expect(await loadTuiPreview({ path: 'deleted.ts' })).toMatchObject({
      missing: true,
      binary: false,
    })

    getFileContent.mockResolvedValueOnce(Buffer.from([0x66, 0x6f, 0x00, 0x6f]))
    expect(await loadTuiPreview({ path: 'image.bin' })).toMatchObject({
      missing: false,
      binary: true,
    })
  })

  it('propagates getFileContent rejection', async () => {
    getFileContent.mockRejectedValue(new Error('native fs permission denied'))
    await expect(loadTuiPreview({ path: 'guarded.ts' })).rejects.toThrow('native fs permission denied')
  })

  it('rejects an empty path', async () => {
    await expect(loadTuiPreview({})).rejects.toThrow('preview path is required')
  })
})
