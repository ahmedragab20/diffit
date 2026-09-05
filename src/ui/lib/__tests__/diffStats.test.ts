import { describe, expect, it } from 'vitest'
import { parsePatchFiles } from '@pierre/diffs'
import type { FileDiffMetadata } from '@pierre/diffs'
import { countDiffChanges } from '../diffStats.js'

/**
 * Fixtures are real unified-diff patch strings, parsed with the production
 * parser (`parsePatchFiles`) so tests exercise actual `FileDiffMetadata`
 * shapes — no hand-rolled mocks or `as any` casts.
 */
function parse(patch: string): FileDiffMetadata[] {
  return parsePatchFiles(patch).flatMap((parsed) => parsed.files)
}

/** Replacement hunk: one changed line, plus four unchanged context lines. */
const replacementPatch = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,5 +1,5 @@
 context one
-const old = 1;
+const neu = 1;
 context two
 context three
 context four
`

/** Two files: first has two hunks (one replacement, one pure addition). */
const multiHunkMultiFilePatch = `diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,3 +1,3 @@
 keep
-old one
+new one
 keep
@@ -10,2 +10,3 @@
 still
+added late
 here
diff --git a/src/c.ts b/src/c.ts
index 5555555..6666666 100644
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,1 +1,2 @@
 ctx
+added
`

/** One newly added file and one deleted file. */
const addDeletePatch = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..7777777
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+fresh
+lines
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 8888888..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-removed
-lines
`

/** Replacement where both sides end without a trailing newline. */
const noNewlineMarkerPatch = `diff --git a/src/noeol.ts b/src/noeol.ts
index 9999999..aaaaaaa 100644
--- a/src/noeol.ts
+++ b/src/noeol.ts
@@ -1 +1 @@
-old value
\\ No newline at end of file
+new value
\\ No newline at end of file
`

/** Binary change: no textual hunks at all. */
const binaryOnlyPatch = `diff --git a/logo.png b/logo.png
index b57ed9c..0ea5d55 100644
Binary files a/logo.png and b/logo.png differ
`

describe('countDiffChanges', () => {
  it('counts a replacement hunk as exactly +1/-1, excluding context lines', () => {
    const files = parse(replacementPatch)
    // The hunk header spans 5 lines per side; only 1 line per side changed.
    // If the helper ever counted hunk.additionCount/deletionCount (context
    // included), this would be 5/5 instead of 1/1.
    expect(files[0]!.hunks[0]!.additionCount).toBe(5)
    expect(files[0]!.hunks[0]!.deletionCount).toBe(5)
    expect(countDiffChanges(files)).toEqual({ additions: 1, deletions: 1 })
  })

  it('sums changed lines only across multiple hunks and files', () => {
    const files = parse(multiHunkMultiFilePatch)
    // src/b.ts: hunk 1 is -1/+1, hunk 2 is +1/-0; src/c.ts: +1/-0.
    // Context lines ("keep", "still", "here", "ctx") are never counted.
    expect(countDiffChanges(files)).toEqual({ additions: 3, deletions: 1 })
  })

  it('counts only the files supplied (filtered subsets)', () => {
    const files = parse(multiHunkMultiFilePatch)
    const onlyC = files.filter((file) => file.name === 'src/c.ts')
    expect(countDiffChanges(onlyC)).toEqual({ additions: 1, deletions: 0 })
    const onlyB = files.filter((file) => file.name === 'src/b.ts')
    expect(countDiffChanges(onlyB)).toEqual({ additions: 2, deletions: 1 })
  })

  it('counts pure additions and pure deletions', () => {
    const files = parse(addDeletePatch)
    expect(countDiffChanges(files)).toEqual({ additions: 2, deletions: 2 })
    const added = files.filter((file) => file.type === 'new')
    expect(countDiffChanges(added)).toEqual({ additions: 2, deletions: 0 })
    const deleted = files.filter((file) => file.type === 'deleted')
    expect(countDiffChanges(deleted)).toEqual({ additions: 0, deletions: 2 })
  })

  it('does not count "\\ No newline at end of file" markers as changed lines', () => {
    const files = parse(noNewlineMarkerPatch)
    expect(files[0]!.hunks[0]!.noEOFCRDeletions).toBe(true)
    expect(files[0]!.hunks[0]!.noEOFCRAdditions).toBe(true)
    expect(countDiffChanges(files)).toEqual({ additions: 1, deletions: 1 })
  })

  it('returns 0/0 for an empty file list', () => {
    expect(countDiffChanges([])).toEqual({ additions: 0, deletions: 0 })
  })

  it('returns 0/0 for a binary-only diff', () => {
    const files = parse(binaryOnlyPatch)
    expect(files).toHaveLength(1)
    expect(files[0]!.hunks).toHaveLength(0)
    expect(countDiffChanges(files)).toEqual({ additions: 0, deletions: 0 })
  })
})
