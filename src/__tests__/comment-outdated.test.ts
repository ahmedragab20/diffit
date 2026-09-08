// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  fileContentFromPatch,
  isCommentOutdated,
  markOutdatedComments,
  stripDiffMarkers,
} from '../lib/comment-outdated.js'
import type { ReviewComment } from '../lib/types.js'

function c(partial: Partial<ReviewComment> & { lineContent: string; lineNumber?: number }): ReviewComment {
  return {
    id: '1',
    filePath: 'a.ts',
    side: 'additions',
    lineNumber: partial.lineNumber ?? 1,
    body: 'x',
    status: 'open',
    createdAt: 1,
    replies: [],
    ...partial,
  }
}

describe('stripDiffMarkers', () => {
  it('strips leading +/- markers', () => {
    expect(stripDiffMarkers('+const x = 1\n-const y = 2')).toBe('const x = 1\nconst y = 2')
  })
})

describe('isCommentOutdated', () => {
  it('is false when snapshot is still in the file', () => {
    expect(isCommentOutdated(c({ lineContent: '+foo()' }), 'bar\nfoo()\nbaz')).toBe(false)
  })

  it('is true when snapshot is gone', () => {
    expect(isCommentOutdated(c({ lineContent: '+foo()' }), 'bar\nbaz')).toBe(true)
  })

  it('never flags file-level comments', () => {
    expect(isCommentOutdated(c({ lineContent: 'x', lineNumber: 0 }), 'nope')).toBe(false)
  })

  it('is false when haystack is missing', () => {
    expect(isCommentOutdated(c({ lineContent: '+foo()' }), null)).toBe(false)
  })
})

describe('markOutdatedComments', () => {
  it('sets outdated flags from the file map', () => {
    const comments = [
      c({ id: 'a', filePath: 'a.ts', lineContent: '+keep' }),
      c({ id: 'b', filePath: 'b.ts', lineContent: '+gone' }),
    ]
    const map = new Map([
      ['a.ts', 'keep\n'],
      ['b.ts', 'other\n'],
    ])
    const out = markOutdatedComments(comments, map)
    expect(out[0].outdated).toBe(false)
    expect(out[1].outdated).toBe(true)
  })

  it('keeps a fresh multi-line added comment NOT outdated against fileContentFromPatch output', () => {
    const patch = [
      'diff --git a/app/x.ts b/app/x.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/app/x.ts',
      '@@ -0,0 +1,2 @@',
      '+const a = 1',
      '+const b = 2',
    ].join('\n')
    const content = fileContentFromPatch(patch, 'app/x.ts')
    const comment = c({
      id: 'fresh-multi-line',
      filePath: 'app/x.ts',
      lineNumber: 1,
      lineContent: '+const a = 1\n+const b = 2',
    })
    const out = markOutdatedComments([comment], new Map([['app/x.ts', content!]]))
    expect(out[0].outdated).toBe(false)
  })
})

describe('fileContentFromPatch', () => {
  it('reconstructs an added file', () => {
    const patch = [
      'diff --git a/app/x.ts b/app/x.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/app/x.ts',
      '@@ -0,0 +1,2 @@',
      '+const a = 1',
      '+const b = 2',
    ].join('\n')
    expect(fileContentFromPatch(patch, 'app/x.ts')).toBe('const a = 1\nconst b = 2')
  })

  it('reconstructs a modified file keeping context and dropping removed lines', () => {
    const patch = [
      'diff --git a/lib/y.ts b/lib/y.ts',
      'index 1111111..2222222 100644',
      '--- a/lib/y.ts',
      '+++ b/lib/y.ts',
      '@@ -1,3 +1,3 @@',
      ' keep',
      '-old',
      '+new',
      ' trailing',
    ].join('\n')
    expect(fileContentFromPatch(patch, 'lib/y.ts')).toBe('keep\nnew\ntrailing')
  })

  it('slices a multi-file patch to only the requested file', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/a.ts',
      '@@ -0,0 +1,1 @@',
      '+aaa',
      'diff --git a/b.ts b/b.ts',
      'index 1111111..2222222 100644',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n')
    const aContent = fileContentFromPatch(patch, 'a.ts')
    const bContent = fileContentFromPatch(patch, 'b.ts')
    expect(aContent).toBe('aaa')
    expect(aContent).not.toContain('old')
    expect(aContent).not.toContain('new')
    expect(bContent).toBe('new')
    expect(bContent).not.toContain('aaa')
  })

  it('returns undefined for a file not in the patch', () => {
    const patch = [
      'diff --git a/app/x.ts b/app/x.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/app/x.ts',
      '@@ -0,0 +1,2 @@',
      '+const a = 1',
      '+const b = 2',
    ].join('\n')
    expect(fileContentFromPatch(patch, 'missing.ts')).toBeUndefined()
  })

  it("returns '' for a binary file", () => {
    const patch = [
      'diff --git a/z.png b/z.png',
      'index 1111111..2222222 100644',
      'Binary files a/z.png and b/z.png differ',
    ].join('\n')
    expect(fileContentFromPatch(patch, 'z.png')).toBe('')
  })

  it('strips one leading marker space from context lines, not all whitespace', () => {
    const patch = [
      'diff --git a/f.ts b/f.ts',
      'index 1111111..2222222 100644',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '  over-strip-guard',
    ].join('\n')
    const out = fileContentFromPatch(patch, 'f.ts')
    // `" keep"` → `"keep"` (marker stripped)
    expect(out!.split('\n')[0]).toBe('keep')
    // the second line's content-leading space is preserved — guards against
    // over-stripping (e.g. trimStart) that would eat real indentation
    expect(out).toBe('keep\n over-strip-guard')
  })

  it('strips the leading marker from a snapshot only once via markOutdatedComments', () => {
    const patch = [
      'diff --git a/app/x.ts b/app/x.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/app/x.ts',
      '@@ -0,0 +1,2 @@',
      '+const a = 1',
      '+const b = 2',
    ].join('\n')
    const content = fileContentFromPatch(patch, 'app/x.ts')!
    const comment = c({
      id: 'strip-once',
      filePath: 'app/x.ts',
      lineNumber: 1,
      lineContent: '+const a = 1\n+const b = 2',
    })
    const out = markOutdatedComments([comment], new Map([['app/x.ts', content]]))
    expect(out[0].outdated).toBe(false)
  })
})
