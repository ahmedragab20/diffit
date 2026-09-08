---
name: diffing-review
description: Review code with diffing, inspect changed files and discussion, and post actionable inline findings. Use for working-tree, staged, commit, branch, or GitHub pull-request reviews; report incomplete coverage rather than claiming an exhaustive review.
license: MIT
metadata:
  author: ahmedragab20
  version: "0.20.0"
user_invocable: true
---

# Review changes with diffing

## Use this when

The user wants a code review, not implementation. Start a missing session with [Start review](../diffing-start-review/SKILL.md); apply existing human requests with [Finish review](../diffing-finish-review/SKILL.md).

## Before you start

Call `review_session_status({})`. Verify consumer repository, mode and scope; for `gh-pr`, confirm identity with `gh_overview({})`. Select/reconnect deliberately if mismatched. Web and TUI support local findings; PR mode uses local PR drafts, not local code comments.

Read open local comments with `list_comments({openOnly:true})`. In PR mode, read published threads/reviews and `gh_list_draft_comments({})` instead. Do not duplicate existing discussion.

## Recipe

### 1. Inspect with bounded reads

MCP request sequence (replace `G` with the returned numeric generation):

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

- Page **all** requested files and hunks via `nextCursor`; slices via `nextRow`. Repeat per file. Verify file-page generation matches your traversal.
- Carry generation into hunks/slices/search. On stale generation, restart from summary; do not mix snapshots.
- `complete: false` and `omittedPaths` disclose missing source coverage. Review the available patch and report omissions. Never keep polling for completeness or call that an exhaustive review.
- Use `diff_search({q:'literal', generation:G})` / `diffing inspect search 'literal' --generation G` for targeted discovery, not coverage. Continue search with both `nextFile` and `nextRow`.
- Read relevant surrounding source; account for binary/renamed/untracked content. Use full `get_diff` only when bounded inspection cannot serve the task and the mode supports it.

### 2. Post precise findings

After inspecting an actual row, use this shape with its real path/coordinates/content:

```js
create_comment({
  filePath: 'src/app.ts', side: 'additions', lineNumber: 42,
  lineContent: 'const value = read();',
  body: 'A missing value reaches the dereference below. Handle that case first.',
  severity: 'blocking',
})
```

For `add`/`context` rows use `newLineno` and `additions`; for `del` rows use `oldLineno` and `deletions`. `startLineNumber` through `lineNumber` is inclusive. File-level `lineNumber:0` has no start range. If the concern cannot be anchored honestly, summarize it rather than inventing a line.

Prioritize correctness, security, data loss and regressions. State the consequence and smallest viable correction. Severity is optional: `blocking`, `nit`, `question`, `praise`, or untriaged. Avoid speculative findings and generic praise.

In PR mode use **`gh_create_draft_comment`** with the same anchor shape. Follow [PR reads](../diffing-pr-read/SKILL.md) for nested discussion pagination. Drafts remain local. Publish only when explicitly authorized, first using `gh_submit_review({decision:'comment', dryRun:true})` or `diffing gh pr-review --decision comment --dry-run`, then the authorized submission without dry-run.

A fenced suggestion is proposed code, not permission to apply it during review. Applying it mutates files; this skill does not do that by default.

### 3. Cite a retained capture (optional)

If a review snapshot was retained, navigate it instead of dumping files:

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

`ai_evidence_search` returns positions only; read before citing. `ai_notebook` lists cited findings; `ai_notebook_add` and `ai_notebook_decide` write, and they are **not** `ai_evidence_*` tools. Do not start `POST /api/ai/run`.

## Recovery

A 409 can be a stale generation or an ambiguous path selector; inspect the error and narrow/restart accordingly. A failed or omitted read remains a coverage limitation. Never bypass denied file access or publish to GitHub to work around a local draft failure. See [Recovery and safety](../diffing/references/recovery-and-safety.md).

## Done

Report findings, inspected scope, omissions and the verified review URL. Do not claim every file was reviewed unless it was. Do not wait for another handoff unless requested.

[Router](../diffing/SKILL.md) · [Start review](../diffing-start-review/SKILL.md) · [Finish review](../diffing-finish-review/SKILL.md) · [Sessions](../diffing/references/sessions-and-transports.md) · [Headless API](../diffing/references/headless-api.md)
