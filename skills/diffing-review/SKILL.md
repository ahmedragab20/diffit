---
name: diffing-review
description: Review code through diffing - bounded reads of the changed files, then inline findings anchored to real lines. Use for working-tree, staged, commit, branch or GitHub pull-request reviews where the user wants findings rather than implementation.
license: MIT
metadata:
  author: ahmedragab20
  version: "0.20.1"
user_invocable: true
---

# Review changes with diffing

## Use this when

The user wants a code review, not implementation. Start a missing session with [Start review](../diffing-start-review/SKILL.md); apply feedback the human already left with [Finish review](../diffing-finish-review/SKILL.md).

## Before you start

```js
review_session_status({})            // consumer repository, mode, scope
gh_overview({})                      // gh-pr mode only: confirm identity
list_comments({ openOnly: true })    // web/tui: what is already being discussed
gh_list_draft_comments({})           // gh-pr: existing local drafts
```

Select or reconnect deliberately if the session does not match. Web and TUI take local findings; PR mode takes local PR drafts instead of local code comments. Read the open discussion first so you add to it rather than repeat it.

## Recipe

### 1. Inspect with bounded reads

Replace `G` with the numeric generation the summary returns:

```js
diff_summary({})
diff_files({ cursor: 0, limit: 50 })
diff_hunks({ path: 'src/app.ts', cursor: 0, limit: 50, generation: G })
diff_slice({ path: 'src/app.ts', start: 0, maxLines: 120, generation: G })
```

CLI equivalent:

```bash
diffing inspect summary
diffing inspect files --cursor 0 --limit 50
diffing inspect hunks --path src/app.ts --cursor 0 --limit 50 --generation G
diffing inspect slice --path src/app.ts --start 0 --max-lines 120 --generation G
```

- Page **every** requested file and hunk through `nextCursor`, and slices through `nextRow`, repeating per file. Verify the file page's generation matches your traversal.
- Carry `G` into hunks, slices and search. A stale generation means restart from summary; snapshots do not mix.
- `complete: false` and `omittedPaths` disclose missing source coverage. Review the patch you have and name the omission in your report — asking again returns the same coverage, and a partial read is not an exhaustive review.
- `diff_search({q:'literal', generation:G})` / `diffing inspect search 'literal' --generation G` is for targeted discovery, not coverage. Continue it through both `nextFile` and `nextRow`.
- Read the surrounding source too, and account for binary, renamed and untracked content. Reach for full `get_diff` only when bounded inspection cannot serve the task and the mode supports it.

### 2. Post precise findings

Anchor to a row you actually read, with its real path, coordinates and content:

```js
create_comment({
  filePath: 'src/app.ts', side: 'additions', lineNumber: 42,
  lineContent: 'const value = read();',
  body: 'A missing value reaches the dereference below. Handle that case first.',
  severity: 'blocking',
})
```

`add` and `context` rows use `newLineno` with `additions`; `del` rows use `oldLineno` with `deletions`. `startLineNumber` through `lineNumber` is inclusive. File-level `lineNumber:0` takes no start range. When a concern has no honest anchor, summarize it instead of inventing a line.

Prioritize correctness, security, data loss and regressions. State the consequence and the smallest viable correction. Severity is optional: `blocking`, `nit`, `question`, `praise`, or untriaged. Skip speculative findings and generic praise.

PR mode uses **`gh_create_draft_comment`** with the same anchor shape; [PR reads](../diffing-pr-read/SKILL.md) covers nested discussion pagination. Drafts stay local. Publishing needs explicit authorization, and goes `gh_submit_review({decision:'comment', dryRun:true})` or `diffing gh pr-review --decision comment --dry-run` first, then the authorized submission.

A fenced suggestion is proposed code. Applying it writes to the working tree, which is a separate ask from reviewing.

### 3. Cite a retained capture (optional)

When a review snapshot was retained, navigate it instead of dumping files:

```js
ai_evidence_list({})
ai_evidence_map({ id: 'SNAPSHOT_ID' })
ai_evidence_read({ id: 'SNAPSHOT_ID', requests: [{ key: 'src/app.ts', startLine: 40, endLine: 48 }] })
ai_evidence_verify({ id: 'SNAPSHOT_ID', reference, revision: 'REV' })
```

```bash
diffing evidence list
diffing evidence map SNAPSHOT_ID
diffing evidence read SNAPSHOT_ID --range KEY:START:END
```

`ai_evidence_search` returns positions only — read the range before citing it. `ai_notebook` lists cited findings; `ai_notebook_add` and `ai_notebook_decide` are writes, not `ai_evidence_*` reads. `POST /api/ai/run` belongs to the human's rail.

## Recovery

A 409 is either a stale generation or an ambiguous path selector — read the error and restart or narrow accordingly. A failed or omitted read stays a coverage limitation in your report. Denied file access and a failed local draft both stand on their own; publishing to GitHub is not a workaround. See [Recovery and safety](../diffing/references/recovery-and-safety.md).

## Done

Report the findings, the scope you inspected, what was omitted, and the verified review URL. Say which files you covered rather than implying all of them. Park unless another handoff was requested.

[Router](../diffing/SKILL.md) · [Start review](../diffing-start-review/SKILL.md) · [Finish review](../diffing-finish-review/SKILL.md) · [Sessions](../diffing/references/sessions-and-transports.md) · [Headless API](../diffing/references/headless-api.md)
