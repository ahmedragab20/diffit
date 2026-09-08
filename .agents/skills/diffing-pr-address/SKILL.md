---
name: diffing-pr-address
description: Turn GitHub PR feedback into local code changes through a diffing plan and review cycle. Use to address reviewer requests, map unresolved threads to fixes, or plan the work a PR review asked for; remote replies, resolution and pushes stay separate.
license: MIT
metadata:
  author: ahmedragab20
  version: "0.20.1"
user_invocable: true
---

# Address PR feedback locally

## Use this when

The human wants code changes based on PR feedback. The default shape is a local checkout plus a plan and review cycle. "Fix this feedback" authorizes local work; a push, a published reply, a thread resolution or a merge each need their own yes.

## Before you start

Follow [PR reads](../diffing-pr-read/SKILL.md) first: confirm PR identity and head, inspect the relevant diff, page the unresolved threads and their nested replies, and read the overall review verdicts. Keep the comment IDs, `threadId`s, paths, outdated flags and the PR session ID.

Then verify the local checkout, **before proposing any file edit**:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
```

Compare branch and HEAD against the PR head from overview, and check fork identity rather than trusting a matching branch name. Use a redacted host summary to verify the remote; credential-bearing URLs stay out of chat.

Unrelated dirty work stays as it is. If the right checkout is missing, ask for authorization to create or use an isolated one.

## Recipe

### 1. Map feedback to a plan

For each relevant open thread, record the request, the affected source, the proposed fix and the focused check that proves it. Separate questions and outdated requests from actionable changes, and read the thread rather than inferring the fix from a line number.

Keep `PR_SESSION_ID` and its identity. Select or start a compatible local web session for the same consumer, reconnect MCP and verify scope — PR mode does not host plans.

```js
submit_plan({ title: 'Address PR feedback', body: planMarkdown })
```

```bash
printf '%s' "$PLAN" | diffing plan submit - --title 'Address PR feedback'
```

Share the returned plan URL and park. [Plan review](../diffing-plan-review/SKILL.md) covers verdicts and same-ID revisions. `comment-only` allows discussion; implementation follows the approved current plan.

### 2. Implement and verify locally

Apply the scoped changes, run the planned checks, and read your own diff for anything unrelated that crept in. Keep the mapping:

| Feedback | Outcome |
| --- | --- |
| Comment/thread ID | Changed file/behavior, verification, or remaining question |

Open the local implementation through [Start review](../diffing-start-review/SKILL.md) and share its URL. Questions stay unresolved. Local plan and comment resolutions are local — GitHub threads stay open until GitHub is told otherwise.

### 3. Remote follow-up, once authorized

Restore `PR_SESSION_ID`, reconnect MCP and re-verify `gh_overview({})` before refreshing. If the head moved, reconcile before publishing anything.

For an explicitly requested publication:

```js
gh_submit_review({ decision: 'comment', body: 'Summary of the verified changes.', dryRun: true })
```

```bash
diffing gh pr-review --decision comment --body 'Summary of the verified changes.' --dry-run
```

Read the proposed payload, then publish exactly the verdict, body and drafts you were authorized to publish. A dry run shows intent, not GitHub's acceptance. Replies to published comments, their edits and deletes, and thread resolve/reopen are HTTP-only operations in [Headless API](../diffing/references/headless-api.md) — there is no `gh_reply` tool. Authorize each kind of external effect separately, and use `dryRun` on the operations that support it.

`gh pending submit/discard/resume` acts on a GitHub pending review, which is a different thing from diffing's local drafts. Merging, suggestion commits and pushing code are each their own action, separate from review publication.

## Recovery

When the checkout or PR identity is uncertain, stop and say so. If source or head changed, reread the affected feedback and adjust the plan before applying work built on the old state. After a network failure, inspect remote state and publication results before retrying — an error can follow a successful write. See [Recovery and safety](../diffing/references/recovery-and-safety.md).

## Done

Report the verified local changes mapped to their feedback, the implementation review URL and the remaining questions. Name the actual outcome of any authorized remote action; otherwise state plainly that GitHub is unchanged.

[Router](../diffing/SKILL.md) · [PR reads](../diffing-pr-read/SKILL.md) · [Plan review](../diffing-plan-review/SKILL.md) · [Start review](../diffing-start-review/SKILL.md) · [Sessions](../diffing/references/sessions-and-transports.md)
