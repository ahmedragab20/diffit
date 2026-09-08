---
name: diffing-pr-read
description: Read or summarize a GitHub pull request through diffing - slim overview, bounded diff pages, and paginated threads and reviews. Use to gather PR context or answer questions about a PR without pulling the whole patch into context.
license: MIT
metadata:
  author: ahmedragab20
  version: "0.20.1"
user_invocable: true
---

# Read a GitHub PR

## Use this when

The user wants PR context or a summary. This is read-only: use [Review changes](../diffing-review/SKILL.md) to create local findings, or [Address feedback](../diffing-pr-address/SKILL.md) to implement fixes.

## Before you start

Pin down which PR they mean — a number, `owner/repo#N`, or a full URL — rather than the one from an earlier conversation. From the consumer repository, reuse a matching `gh-pr` session:

```bash
diffing sessions --json
diffing sessions use PR_SESSION_ID
```

With no match, launch `diffing --gh-pr owner/repo#123 --no-open` as a persistent process; it coexists with local and other PR sessions. MCP `start_review_session` is local-web only. Reconnect MCP after selecting, then confirm identity:

```js
review_session_status({})
gh_overview({})
```

## Recipe

### Identity and patch

```js
gh_overview({})
diff_summary({})
diff_files({ cursor: 0, limit: 50 })
diff_hunks({ path: 'src/app.ts', generation: G })
diff_slice({ path: 'src/app.ts', start: 0, maxLines: 120, generation: G })
```

```bash
diffing gh overview --json
diffing inspect summary
diffing inspect files --limit 50
diffing inspect slice --path src/app.ts --start 0 --max-lines 120 --generation G
```

Use the numeric `G` the summary returns. Page files and hunks with `nextCursor`, slices with `nextRow`, search with both `nextFile` and `nextRow`, and skip overview/status calls between unchanged pages. A filtered read covers the subset you asked for, not the whole PR.

`complete:false`, `omittedPaths`, binary files and other incomplete PR metadata belong in your summary as stated limitations — a repeat request returns the same coverage. Full patch and session JSON are explicit fallbacks.

### Discussion and verdicts

```js
gh_list_threads({ unresolvedOnly: true, cursor: 0, limit: 20, replyCursor: 0, replyLimit: 20 })
gh_list_reviews({ cursor: 0, limit: 20 })
```

```bash
diffing gh threads --unresolved --cursor 0 --limit 20 --reply-cursor 0 --reply-limit 20 --format json
diffing gh reviews --cursor 0 --limit 20 --format json
```

MCP wraps the page under `result`. Follow the outer `nextCursor`, and each thread's own `repliesNextCursor`: hold the same outer page and filter while advancing `replyCursor` for the missing replies, then move on. That offset applies to every thread on the page, so deduplicate by reply ID. A root comment with 20 returned replies may well have more.

Bodies are truncated by default (`bodyTruncated`); use `fullBody:true` / `--full-body` on the pages that matter, narrowing with `path`/`author`. Read the review verdict bodies too — requirements often sit outside inline threads. Keep numeric comment IDs distinct from the GraphQL `threadId` used for resolution.

`gh_list_draft_comments({})` / `diffing gh pr-list-comments` shows existing local findings. Timeline and checks have their own [HTTP routes](../diffing/references/headless-api.md); `diffing gh timeline` exists as a CLI command, `diffing gh checks` does not.

## Recovery

On a stale generation, refresh the summary and restart that traversal. If the PR head moved, confirm identity before `gh_refresh({})` / `diffing gh pr-fetch REF`, then reread the affected diff and discussion. Leave a mismatched user session in place and report the mismatch. An outdated thread is still open until GitHub says otherwise. See [Recovery and safety](../diffing/references/recovery-and-safety.md).

## Done

Summarize the requested scope, the material changes and the actionable discussion, with pagination, body and patch limitations stated. Reading a PR leaves GitHub untouched: drafts, replies, resolutions, reviews and state changes are separate asks.

[Router](../diffing/SKILL.md) · [Review changes](../diffing-review/SKILL.md) · [Address PR feedback](../diffing-pr-address/SKILL.md) · [Sessions](../diffing/references/sessions-and-transports.md) · [Headless API](../diffing/references/headless-api.md)
