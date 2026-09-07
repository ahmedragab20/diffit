---
name: diffing-mockup-review
description: Submit HTML screens to diffing, inspect human feedback, and make version-guarded mockup revisions. Use after authoring a requested mockup, to process visual review comments or receive an approved implementation handoff.
---

# Review an HTML mockup

## Use this when

HTML is ready for visual review, or the human returned feedback. Follow [Mockup authoring](../diffing-mockup-author/SKILL.md) for product styles and state structure; this skill handles the review loop.

## Before you start

Select the correct consumer's local web session. Keep HTML inline/stdin or under `~/.diffing/`, never in the consumer tree. Use stable screen IDs, at most 24 screens, and one distinct state per screen. Viewport changes alone do not need duplicate screens.

## Recipe

### 1. Submit and park

```js
submit_mockup({ title: 'Import empty state', html: emptyHtml, mode: 'fragment' })
```

```bash
printf '%s' "$HTML" | diffing mockup submit - --title 'Import empty state' --mode fragment
```

For several states use `screens:[{id,label,html}, ...]` in one MCP submission. For a full replacement, reuse `mockupId` (CLI `--id`); do not create a second conversation. `--screen id=path` can submit existing staged files, but those paths must be outside the consumer tree.

Use the returned ID/version/URL and inspect advisory `hints`. Share the URL and end the turn. `model`/`--model` records provenance; submission does not invoke AI.

### 2. Receive a verdict

When ready or explicitly asked to wait:

```js
await_mockup_review({ timeoutSeconds: 60 })
```

```bash
diffing mockup await --timeout 60
```

Validate the released artifact ID and version: waits are session-global. MCP takes `timeoutSeconds`; only HTTP uses `sinceRound`/`timeoutMs`. Handoff XML is compact and open-only for the current version, with `screen`, `mockup-version`, and `viewport` scope.

`approved` permits implementation of the reviewed mockup. `changes-requested` calls for a revision. `rejected` stops that approach. `comment-only` permits replies only, not markup/product edits. Timeout/pending means park. Never submit the human decision endpoint yourself.

### 3. Inspect only the needed source

If the handoff already includes actionable comments, use them directly. For a targeted refresh:

```js
inspect_mockup({ mockupId: 'MOCKUP_ID', view: 'comments', status: 'open', cursor: 0, limit: 20 })
inspect_mockup({ mockupId: 'MOCKUP_ID', view: 'screen', screenId: 'imports-empty', context: 'source' })
```

```bash
diffing mockup inspect comments MOCKUP_ID --status open --limit 20
diffing mockup inspect screen MOCKUP_ID --screen imports-empty --context source
```

Page `nextCursor`. Narrow by `version`, `screenId`/`--screen`, and `viewport`. `context` is `none`, `anchor` or `source`; source/preview output may be bounded. `view:'preview'` reads available layout/screenshot metadata without starting AI. Fetch one historical/current full record only if bounded source is insufficient.

Section comments use a `data-diffing` target, block comments a selector/fingerprint/source, and point comments coordinates. Read source before changing markup; a pin alone is not enough context.

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

`op:'patch'` uses `expectedText` plus `replacement` in MCP/HTTP; CLI uses `--text`/`--replacement`. `upsert` adds/replaces one screen; `remove` cannot remove the last screen. Every successful screen operation already creates the next version. Do not submit again afterward. A 409 requires rereading the current version/target and reconciling the change.

`apply_mockup_suggestion({commentId:'COMMENT_ID',expectedVersion:3})` / `diffing mockup apply-suggestion COMMENT_ID --expected-version 3` applies the suggestion but **does not resolve** the thread. Check the revised result first.

### 5. Synchronize feedback

After verifying the revision:

```js
update_mockup_threads({ mockupId: 'MOCKUP_ID', operations: [
  { op: 'reply', commentId: 'COMMENT_ID', body: 'Updated the empty-state instructions.', role: 'agent' },
  { op: 'resolve', commentId: 'COMMENT_ID' },
] })
```

The batch validates all operations before applying any and does not bump the version. CLI `mockup threads reply` followed by `resolve` is two separate calls, **not atomic**. Questions stay open. Individual `reply_to_mockup_comment`, `resolve_mockup_comment` and `unresolve_mockup_comment` are available for one-off updates.

## Recovery

On conflict, verify scope/version and exact region/text; do not replay stale patches. On timeout, park. Never delete threads to clear feedback or invoke the human Ask AI UI as an agent inference loop. See [Recovery and safety](../diffing/references/recovery-and-safety.md).

## Done

Share the current URL and verdict, with unanswered questions left open. After approval use `get_mockup_handoff({mockupId:'MOCKUP_ID'})` or `diffing mockup handoff MOCKUP_ID` for compact tokens/screen intent before implementation.

[Sessions and transports](../diffing/references/sessions-and-transports.md) · [Headless API](../diffing/references/headless-api.md)
