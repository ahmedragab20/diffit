---
name: diffing-plan-review
description: Submit an implementation plan to diffing for human approval and follow the verdict before writing any code. Use for design sign-off, risky or ambiguous work, plan revisions, or any request to have the approach reviewed first.
license: MIT
metadata:
  author: ahmedragab20
  version: "0.20.1"
user_invocable: true
---

# Review an implementation plan

## Use this when

A human decision is needed on a plan before implementation. This workflow submits and revises the plan; the verdict comes from them.

## Before you start

```js
review_session_status({})  // must be the consumer's local web session
```

Plans are a local-web workflow — TUI and PR sessions do not host them. Select or start a compatible concurrent web session for the consumer and reconnect MCP deliberately, leaving existing PR and TUI sessions running.

Write the plan Markdown first: scope, proposed changes, verification, non-goals. Pass it inline or on stdin; if a scratch file is unavoidable, put it under `~/.diffing/` rather than the consumer tree.

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

`PLAN` is the complete Markdown body. Optional `source`/`model` (CLI `--source`/`--model`) record provenance; `--save-source` copies a CLI submission into diffing's source storage.

Read the returned plan ID, version and URL. Share the URL and **end the turn**. Refetching the plan you just submitted adds nothing, and `--wait` is for a human who is reviewing right now.

### 2. Receive the human decision

When the human says ready, or asks for a synchronous wait:

```js
await_plan_review({ timeoutSeconds: 60 })
```

```bash
diffing plan await --timeout 60
```

Use the returned handoff rather than a second fetch. Waits are session-global, so verify `planId` and the reviewed content/version before acting. `sinceRound`/`timeoutMs` are HTTP-only fields; MCP takes `timeoutSeconds`.

| Decision | Next action |
| --- | --- |
| `approved` | Implement the reviewed content, minding open requests |
| `changes-requested` | Revise and resubmit under the same ID; implementation waits |
| `rejected` | Stop and rethink with the human |
| `comment-only` | Reply and discuss; leave the plan body and product alone |
| Pending/timeout | Park |

### 3. Revise without losing history

```js
reply_to_plan_comment({ commentId: 'COMMENT_ID', body: 'The revised plan adds the migration check.' })
submit_plan({ planId: 'PLAN_ID', title: 'Validate import inputs', body: revisedMarkdown })
resolve_plan_comment({ commentId: 'COMMENT_ID' })
```

```bash
printf '%s' "$PLAN" | diffing plan submit - --id PLAN_ID --title 'Validate import inputs'
diffing plan reply COMMENT_ID --body 'The revised plan adds the migration check.'
diffing plan resolve COMMENT_ID
```

Resubmit first, then reply and resolve only the change requests you actually incorporated; questions stay open. Line ranges are inclusive and comments may be version-anchored. Share the new version's URL and park again.

### Targeted reads

| Need | MCP | CLI |
| --- | --- | --- |
| List | `list_plans({})` | `diffing plan list --json` |
| Current body | `get_plan({planId:'PLAN_ID'})` | `diffing plan show PLAN_ID --json` |
| Version metadata | `get_plan_versions({planId:'PLAN_ID'})` | `diffing plan versions PLAN_ID --json` |
| One old version | `get_plan_version({planId:'PLAN_ID',version:2})` | `diffing plan show PLAN_ID --version 2 --json` |

MCP submit and read tools name the identifier `planId`; HTTP POST uses `id`. [Headless API](../diffing/references/headless-api.md) has the comment CRUD and reply edits that MCP and CLI do not expose.

## Recovery

A timeout is a park signal. If a different plan was released, keep it but apply its verdict only to that plan. A human live edit can change a body without bumping the version, so refresh and confirm if the content moved after approval. Change plans through the API rather than by editing `plans.json` or its source mirrors. See [Recovery and safety](../diffing/references/recovery-and-safety.md).

## Done

The plan is parked with its URL, returned for revision or discussion, or approved with the reviewed content identified. Implementation starts only for the approved scope.

[Router](../diffing/SKILL.md) · [Start review](../diffing-start-review/SKILL.md) · [Sessions](../diffing/references/sessions-and-transports.md) · [Headless API](../diffing/references/headless-api.md) · [Recovery](../diffing/references/recovery-and-safety.md)
