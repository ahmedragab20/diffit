---
name: diffing-plan-review
description: Submit an implementation plan to diffing for human approval and obey the verdict before writing code. Use for design sign-off, risky work, plan revisions, or any request to let the human review an implementation approach first.
---

# Review an implementation plan

## Use this when

Get a human decision on a plan before implementation. This workflow submits and revises the plan; it does not let an agent manufacture approval.

## Before you start

Verify the **consumer repository** and select a local web session. Plans are not a TUI/PR workflow. Keep existing PR/TUI sessions alive; select or start a compatible concurrent web session and reconnect MCP deliberately. Never submit a foreign plan from the diffing product checkout.

Prepare Markdown with scope, proposed changes, verification and non-goals. Use inline bodies/stdin; scratch files, if needed, belong under `~/.diffing/`, not the consumer tree.

## Recipe

### 1. Submit and park

```js
submit_plan({
  title: 'Validate import inputs',
  body: '## Changes\n- Validate before saving.\n## Verification\n- Run import tests.',
})
```

```bash
printf '%s' "$PLAN" | diffing plan submit - --title 'Validate import inputs'
```

`PLAN` is the complete Markdown body. Optional `source`/`model` (CLI `--source`/`--model`) record provenance. `--save-source` copies a CLI submission into diffing's source storage.

Read the returned plan ID/version/URL. Share the URL and **end the turn** by default. Do not immediately fetch the same plan or add `--wait` unless the human wants a synchronous wait.

### 2. Receive the human decision

When the human says ready, or requests a synchronous wait:

```js
await_plan_review({ timeoutSeconds: 60 })
```

```bash
diffing plan await --timeout 60
```

Use the returned handoff, not a duplicate fetch. Verify `planId` and reviewed content/version: the wait is session-global, not filtered to the plan you last submitted. HTTP alone uses `sinceRound`/`timeoutMs`; those are **not** MCP input fields.

| Decision | Next action |
| --- | --- |
| `approved` | Implement the actual reviewed content, accounting for open requests |
| `changes-requested` | Revise the plan, then resubmit the same ID; no implementation yet |
| `rejected` | Stop and rethink with the human |
| `comment-only` | Reply/discuss only; no plan-body or product edits |
| Pending/timeout | Park; do not infer approval |

### 3. Revise without losing history

```js
reply_to_plan_comment({ commentId: 'COMMENT_ID', body: 'The revised plan adds the migration check.' })
submit_plan({ planId: 'PLAN_ID', title: 'Validate import inputs', body: revisedMarkdown })
resolve_plan_comment({ commentId: 'COMMENT_ID' })
```

Reply/resolve only incorporated change requests; questions stay open. Resubmission must succeed before resolution. Line ranges are inclusive and comments may be version-anchored.

```bash
printf '%s' "$PLAN" | diffing plan submit - --id PLAN_ID --title 'Validate import inputs'
diffing plan reply COMMENT_ID --body 'The revised plan adds the migration check.'
diffing plan resolve COMMENT_ID
```

Share the new version's URL and park again. Do not POST the human decision endpoint to unblock yourself.

### Targeted reads

| Need | MCP | CLI |
| --- | --- | --- |
| List | `list_plans({})` | `diffing plan list --json` |
| Current body | `get_plan({planId:'PLAN_ID'})` | `diffing plan show PLAN_ID --json` |
| Version metadata | `get_plan_versions({planId:'PLAN_ID'})` | `diffing plan versions PLAN_ID --json` |
| One old version | `get_plan_version({planId:'PLAN_ID',version:2})` | `diffing plan show PLAN_ID --version 2 --json` |

MCP submit and read tools use `planId`; HTTP POST uses `id`. See [Headless API](../diffing/references/headless-api.md) for comment CRUD/reply edits not exposed by MCP/CLI.

## Recovery

A timeout is a park signal. If a different plan was released, preserve it but do not apply its verdict to this plan. Human live edits can change a body without a version bump: refresh/confirm if content changed after approval. Never edit `plans.json` or source mirrors to bypass the API. See [Recovery and safety](../diffing/references/recovery-and-safety.md).

## Done

The plan is either parked with its URL, returned for revision/discussion, or approved with the reviewed content identified. Implementation starts only for the approved scope.

[Sessions and transports](../diffing/references/sessions-and-transports.md)
