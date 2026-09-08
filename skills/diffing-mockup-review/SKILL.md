---
name: diffing-mockup-review
description: Submit HTML screens to diffing, read the human's visual feedback, and make version-guarded revisions. Use after authoring a requested mockup, to process visual review comments, or to pick up an approved mockup for implementation.
license: MIT
metadata:
  author: ahmedragab20
  version: "0.20.1"
user_invocable: true
---

# Review an HTML mockup

## Use this when

HTML is ready for visual review, or the human sent feedback back. [Mockup authoring](../diffing-mockup-author/SKILL.md) covers product styles and state structure; this skill runs the review loop.

## Before you start

```js
review_session_status({})  // the consumer's local web session
```

Keep the HTML inline or on stdin, or under `~/.diffing/` — out of the consumer tree. Use stable screen IDs, at most 24 screens, one distinct state per screen. Viewport differences alone need no duplicate screen.

## Recipe

### 1. Submit and park

```js
submit_mockup({ title: 'Import empty state', html: emptyHtml, mode: 'fragment' })
```

```bash
printf '%s' "$HTML" | diffing mockup submit - --title 'Import empty state' --mode fragment
```

Several states go in one MCP submission as `screens:[{id,label,html}, ...]`. A full replacement reuses `mockupId` (CLI `--id`) so the conversation stays in one place. `--screen id=path` submits staged files from outside the consumer tree.

Use the returned ID, version and URL, and read the advisory `hints`. Share the URL and end the turn. `model`/`--model` records provenance; submission runs no inference.

### 2. Receive a verdict

When the human is ready or asks you to wait:

```js
await_mockup_review({ timeoutSeconds: 60 })
```

```bash
diffing mockup await --timeout 60
```

Waits are session-global, so validate the released artifact ID and version. MCP takes `timeoutSeconds`; `sinceRound`/`timeoutMs` are HTTP-only. The handoff XML is compact and open-only for the current version, scoped by `screen`, `mockup-version` and `viewport`.

| Verdict | Next action |
| --- | --- |
| `approved` | Implement the reviewed mockup |
| `changes-requested` | Revise the screens |
| `rejected` | Stop on that approach |
| `comment-only` | Reply only; markup and product stay as they are |
| Pending/timeout | Park |

The decision endpoint is the human's to call.

### 3. Inspect only the source you need

When the handoff already carries actionable comments, work from those. For a targeted refresh:

```js
inspect_mockup({ mockupId: 'MOCKUP_ID', view: 'comments', status: 'open', cursor: 0, limit: 20 })
inspect_mockup({ mockupId: 'MOCKUP_ID', view: 'screen', screenId: 'imports-empty', context: 'source' })
```

```bash
diffing mockup inspect comments MOCKUP_ID --status open --limit 20
diffing mockup inspect screen MOCKUP_ID --screen imports-empty --context source
```

Page `nextCursor`, and narrow by `version`, `screenId`/`--screen` and `viewport`. `context` is `none`, `anchor` or `source`, and source/preview output may be bounded. `view:'preview'` reads available layout and screenshot metadata. Fetch a full historical or current record only when bounded source falls short.

Section comments carry a `data-diffing` target, block comments a selector/fingerprint/source, and point comments coordinates. Read the source behind the anchor before changing markup — a pin alone is not context.

### 4. Revise once, guarded by version

```js
revise_mockup({
  mockupId: 'MOCKUP_ID', screenId: 'imports-empty', op: 'replace-region',
  region: 'imports-empty', replacement: '<h2>No imports yet</h2><p>Choose a file to start.</p>',
  expectedVersion: 3,
})
```

```bash
diffing mockup screen replace-region MOCKUP_ID imports-empty --region imports-empty --replacement '<h2>No imports yet</h2><p>Choose a file to start.</p>' --expected-version 3
```

`op:'patch'` takes `expectedText` plus `replacement` in MCP/HTTP, `--text`/`--replacement` in the CLI. `upsert` adds or replaces one screen; `remove` keeps the last screen in place. Every successful screen operation already creates the next version, so it needs no resubmission. A 409 means reread the current version and target, then reconcile.

`apply_mockup_suggestion({commentId:'COMMENT_ID',expectedVersion:3})` / `diffing mockup apply-suggestion COMMENT_ID --expected-version 3` revises the screen and leaves the thread open. Check the revised result, then reply and resolve yourself.

### 5. Synchronize feedback

Once the revision is verified:

```js
update_mockup_threads({ mockupId: 'MOCKUP_ID', operations: [
  { op: 'reply', commentId: 'COMMENT_ID', body: 'Updated the empty-state instructions.', role: 'agent' },
  { op: 'resolve', commentId: 'COMMENT_ID' },
] })
```

The batch validates every operation before applying any, and bumps no version. CLI `mockup threads reply` then `resolve` is two calls and **not atomic**. Questions stay open. `reply_to_mockup_comment`, `resolve_mockup_comment` and `unresolve_mockup_comment` handle one-off updates.

## Recovery

On a conflict, verify the scope, version and exact region or text before revising again rather than replaying a stale patch. On timeout, park. Threads are the human's record of their feedback: clear them by addressing and resolving them, never by deleting them. The Ask AI UI stays theirs to trigger. See [Recovery and safety](../diffing/references/recovery-and-safety.md).

## Done

Share the current URL and verdict, leaving unanswered questions open. After approval, `get_mockup_handoff({mockupId:'MOCKUP_ID'})` or `diffing mockup handoff MOCKUP_ID` gives the compact tokens and screen intent to implement from.

[Router](../diffing/SKILL.md) · [Mockup authoring](../diffing-mockup-author/SKILL.md) · [Sessions](../diffing/references/sessions-and-transports.md) · [Headless API](../diffing/references/headless-api.md)
