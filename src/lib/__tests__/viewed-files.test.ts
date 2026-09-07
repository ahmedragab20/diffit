import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileViewedStore,
  unviewChangedFiles,
  visibleViewedPaths,
  viewedScopeKey,
} from '../viewed-files.js'
import { fingerprintDiffFiles } from '../diff-fingerprint.js'

describe('viewed-files', () => {
  it('keys PR identity separately from local', () => {
    expect(
      viewedScopeKey({ owner: 'acme', repo: 'widget', pullNumber: 7 }, true),
    ).toBe('pr:github.com::acme::widget::7')
    expect(viewedScopeKey(null, false)).toBe('local')
  })

  it('hides viewed files whose fingerprint no longer matches', () => {
    const files = { 'a.ts': 'aaaa', 'b.ts': 'bbbb' }
    expect(visibleViewedPaths(files, { 'a.ts': 'aaaa', 'b.ts': 'cccc' })).toEqual(['a.ts'])
  })

  it('unviews files that changed or were added on a new head', () => {
    const previous = { 'a.ts': 'old-a', 'b.ts': 'same-b' }
    const current = { 'a.ts': 'new-a', 'b.ts': 'same-b', 'c.ts': 'new-c' }
    const next = unviewChangedFiles({ 'a.ts': 'old-a', 'b.ts': 'same-b' }, previous, current)
    expect(next).toEqual({ 'b.ts': 'same-b' })
  })

  it('persists per-key viewed files and reconciles a new head', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'diffing-viewed-'))
    try {
      const store = new FileViewedStore(dir)
      const patch1 = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1,2 @@
 line
+added
`
      const fps1 = fingerprintDiffFiles(patch1)
      await store.toggle('pr:acme', 'a.ts', true, fps1['a.ts'], 'aaa', fps1)
      expect(await store.list('pr:acme', fps1)).toEqual(['a.ts'])

      const patch2 = `diff --git a/a.ts b/a.ts
index 111..333 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1,2 @@
 line
+changed
`
      const fps2 = fingerprintDiffFiles(patch2)
      const visible = await store.reconcile('pr:acme', 'bbb', fps2)
      expect(visible).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
