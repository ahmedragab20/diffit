---
name: diffing-pr-address
description: Turn GitHub PR feedback into a human-approved local implementation through diffing. Use to address reviewer requests, plan fixes or map unresolved threads to local changes; remote replies, resolution, pushes and publication require separate authorization.
---

# Address PR feedback locally

## Use this when

The human wants code changes based on PR feedback. Default to a local checkout plus plan/review cycle, not remote mutation. A request to fix feedback does not by itself authorize a push, published reply, thread resolution or merge.

## Before you start

Follow [PR reads](../diffing-pr-read/SKILL.md): verify PR identity/head, inspect the relevant diff, page unresolved threads and nested replies, and read overall review verdicts. Keep comment IDs, `threadId`, paths, outdated flags and the PR session ID.

Verify the local checkout **before proposing exact file edits**:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
```

Use a redacted host summary to verify remote identity; do not print credential-bearing remote URLs. Compare branch/HEAD with the PR head from overview; account for fork repository identity, not just a matching branch name.

Do not switch over unrelated dirty work, stash/reset it, or force checkout. If the right checkout is absent, ask for authorization to create/use an isolated checkout. No destructive cleanup is part of this recipe.

## Recipe

### 1. Map feedback to a plan

For each relevant open thread, record the request, affected source, proposed fix and focused check. Separate questions/outdated requests from actionable changes. Do not infer the fix from a line number alone.

Preserve `PR_SESSION_ID` and its identity. Select a compatible local web session (or start a concurrent one) for the same consumer, reconnect MCP, and verify scope. Plans cannot be hosted as the PR-mode workflow.

```js
submit_plan({ title: 'Address PR feedback', body: planMarkdown })
```

```bash
printf '%s' "$PLAN" | diffing plan submit - --title 'Address PR feedback'
```

Share the returned plan URL and park. Use [Plan review](../diffing-plan-review/SKILL.md) for verdicts and same-ID revisions. `comment-only` permits discussion, not file edits. Only implement the approved current plan.

### 2. Implement and verify locally

Apply the scoped changes, run the planned focused checks, and review the diff for unrelated edits. Maintain a mapping:

| Feedback | Outcome |
| --- | --- |
| Comment/thread ID | Changed file/behavior, verification, or remaining question |

Open the local implementation in [Start review](../diffing-start-review/SKILL.md) and share its URL. Keep questions unresolved. Local plan/comment resolutions do not resolve GitHub threads.

### 3. Remote follow-up only when authorized

Restore `PR_SESSION_ID`, reconnect MCP and verify `gh_overview({})` before refreshing. If the head changed, reconcile before publishing anything.

For an explicitly requested review publication:

```js
gh_submit_review({ decision: 'comment', body: 'Summary of the verified changes.', dryRun: true })
```

```bash
diffing gh pr-review --decision comment --body 'Summary of the verified changes.' --dry-run
```

Inspect the proposed payload and publish only the specifically authorized verdict/body/drafts. A dry-run is not proof GitHub accepted a write. Published-comment replies, edits/deletes and thread resolve/reopen are HTTP-only operations in [Headless API](../diffing/references/headless-api.md), not imaginary `gh_reply` tools. Authorize each type of external effect; use dry-run where supported, not where it does not exist.

`gh pending submit/discard/resume` acts on a GitHub pending review; it is not the same as editing diffing's local drafts. Merging, suggestion commits and pushing code are separate actions from review publication.

## Recovery

If checkout or PR identity is uncertain, stop instead of guessing. If source/head changed, reread affected feedback and adjust the plan before applying stale work. After a network failure, inspect remote state/publication results before retrying—an error can follow a successful write. See [Recovery and safety](../diffing/references/recovery-and-safety.md).

## Done

Report verified local changes mapped to feedback, the implementation review URL and remaining questions. If authorized remote actions were performed, name the actual outcome; otherwise explicitly leave GitHub unchanged.

[Sessions and transports](../diffing/references/sessions-and-transports.md)
