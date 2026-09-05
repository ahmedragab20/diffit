// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildMinimapSegments } from '../../components/DiffMinimap.js'
import { parsePatchFiles } from '@pierre/diffs'
import type { FileDiffMetadata } from '@pierre/diffs'

function file(hunks: Array<{
  additionStart?: number
  deletionStart?: number
  additionCount?: number
  deletionCount?: number
}>): FileDiffMetadata {
  return {
    name: 'x.ts',
    type: 'change',
    hunks: hunks as FileDiffMetadata['hunks'],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: false,
    deletionLines: [],
    additionLines: [],
  } as FileDiffMetadata
}

describe('buildMinimapSegments', () => {
  it('returns empty for no hunks', () => {
    expect(buildMinimapSegments(file([]))).toEqual([])
  })

  it('marks pure additions as add with range label', () => {
    const segs = buildMinimapSegments(
      file([{ additionStart: 10, additionCount: 5, deletionCount: 0 }]),
    )
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe('add')
    expect(segs[0].line).toBe(10)
    expect(segs[0].index).toBe(1)
    expect(segs[0].additions).toBe(5)
    expect(segs[0].deletions).toBe(0)
    expect(segs[0].rangeLabel).toBe('L10–14')
    expect(segs[0].start).toBe(0)
    expect(segs[0].height).toBeCloseTo(1)
  })

  it('marks pure deletions as del', () => {
    const segs = buildMinimapSegments(
      file([{ deletionStart: 3, deletionCount: 2, additionCount: 0 }]),
    )
    expect(segs[0].kind).toBe('del')
    expect(segs[0].line).toBe(3)
    expect(segs[0].rangeLabel).toBe('L3–4')
  })

  it('weights multiple hunks by size', () => {
    const segs = buildMinimapSegments(
      file([
        { additionStart: 1, additionCount: 1, deletionCount: 0 },
        { additionStart: 20, additionCount: 9, deletionCount: 0 },
      ]),
    )
    expect(segs).toHaveLength(2)
    expect(segs[0].height).toBeLessThan(segs[1].height)
    expect(segs[0].height + segs[1].height).toBeCloseTo(1)
    expect(segs[0].index).toBe(1)
    expect(segs[1].index).toBe(2)
  })

  describe('with real parsed patches', () => {
    async function parsed(patch: string): Promise<FileDiffMetadata> {
      const parsed_ = await parsePatchFiles(patch)
      return parsed_.flatMap((p) => p.files)[0]
    }

    it('counts additions excluding context for a pure-add hunk', async () => {
      const fileDiff = await parsed(`diff --git a/x.ts b/x.ts
index 1111111..2222222 100644
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,3 @@
 line1
+added
 line2
`)
      const segs = buildMinimapSegments(fileDiff)
      expect(segs).toHaveLength(1)
      expect(segs[0].additions).toBe(1)
      expect(segs[0].deletions).toBe(0)
      expect(segs[0].kind).toBe('add')
      expect(segs[0].rangeLabel).toBe('L1–3')
    })

    it('counts deletions excluding context for a pure-delete hunk', async () => {
      const fileDiff = await parsed(`diff --git a/y.ts b/y.ts
index 3333333..4444444 100644
--- a/y.ts
+++ b/y.ts
@@ -1,3 +1,2 @@
 line1
-removed
 line3
`)
      const segs = buildMinimapSegments(fileDiff)
      expect(segs).toHaveLength(1)
      expect(segs[0].additions).toBe(0)
      expect(segs[0].deletions).toBe(1)
      expect(segs[0].kind).toBe('del')
      expect(segs[0].rangeLabel).toBe('L1–2')
    })

    it('counts both sides excluding context for a replacement hunk', async () => {
      const fileDiff = await parsed(`diff --git a/z.ts b/z.ts
index 5555555..6666666 100644
--- a/z.ts
+++ b/z.ts
@@ -1,3 +1,3 @@
 line1
-old
+new
 line3
`)
      const segs = buildMinimapSegments(fileDiff)
      expect(segs).toHaveLength(1)
      expect(segs[0].additions).toBe(1)
      expect(segs[0].deletions).toBe(1)
      expect(segs[0].kind).toBe('change')
      expect(segs[0].rangeLabel).toBe('L1–3')
    })
  })
})
