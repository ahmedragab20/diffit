---
name: diffing-pr-read
description: Read or summarize a GitHub pull request through diffing using slim overview, bounded diff pages and paginated discussion. Use for PR context gathering without full-patch dumps, unsolicited draft creation or remote publication.
---

# Read a GitHub PR

## Use this when

The user wants PR context or a summary. This is read-only by default; use [Review changes](../diffing-review/SKILL.md) to create local findings or [Address feedback](../diffing-pr-address/SKILL.md) to implement fixes.

## Before you start

Identify the requested PR, not an old conversation's PR. `<ref>` may be a number, `owner/repo#N`, or full URL. From the consumer repository, list sessions and reuse a matching `gh-pr` entry:

```bash
diffing sessions --json
diffing sessions use PR_SESSION_ID
```

If none matches, launch `diffing --gh-pr owner/repo#123 --no-open` as a persistent process. It coexists with local/other PR sessions. Reconnect MCP after selection; call `review_session_status({})`, then `gh_overview({})` and verify identity. MCP `start_review_session` is local-web only.

## Recipe

### Identity and patch

```js
gh_overview({})
diff_summary({})
diff_files({ cursor: 0, limit: 50 })
diff_hunks({ path: 'src/app.ts', generation: G })
diff_slice({ path: 'src/app.ts', start: 0, maxLines: 120, generation: G })
```

Use the returned numeric `G`; page files/hunks with `nextCursor`, slices with `nextRow`, search with both `nextFile` and `nextRow`. Do not call overview/status between unchanged pages. Filters are useful for a requested subset, not proof of whole-PR coverage.

```bash
diffing gh overview --json
diffing inspect summary
diffing inspect files --limit 50
diffing inspect slice --path src/app.ts --start 0 --max-lines 120 --generation G
```

`complete:false`, `omittedPaths`, binary files or other incomplete PR metadata must appear as limitations in your summary. Do not repeatedly request the summary to make it complete. Use full patch/session JSON only as an explicit fallback.

### Discussion and verdicts

```js
gh_list_threads({ unresolvedOnly: true, cursor: 0, limit: 20, replyCursor: 0, replyLimit: 20 })
gh_list_reviews({ cursor: 0, limit: 20 })
```

```bash
diffing gh threads --unresolved --cursor 0 --limit 20 --reply-cursor 0 --reply-limit 20 --format json
diffing gh reviews --cursor 0 --limit 20 --format json
```

MCP wraps the page under `result`. Follow outer `nextCursor`. Each thread also has `repliesNextCursor`: retain the same outer page/filter and advance `replyCursor` for missing replies before moving on. That offset applies to every thread returned on the page; deduplicate by reply ID. Do not mistake a root comment with 20 returned replies for a complete thread.

Bodies are truncated by default (`bodyTruncated`). Use `fullBody:true` / `--full-body` only for relevant pages, narrowing with `path`/`author` where useful. Read review verdict bodies too; requirements may be outside inline threads. Keep numeric comment IDs separate from GraphQL `threadId` used for resolution.

For draft awareness, `gh_list_draft_comments({})` / `diffing gh pr-list-comments` reads local findings. Timeline and checks have separate [HTTP routes](../diffing/references/headless-api.md); `diffing gh timeline` is available, but `diffing gh checks` is not.

## Recovery

On stale generation, refresh summary and restart the affected traversal. If the PR head changed, verify identity before `gh_refresh({})` / `diffing gh pr-fetch REF`; then reread affected diff/discussion. Do not replace a mismatched user session or infer that an outdated thread is resolved. See [Recovery and safety](../diffing/references/recovery-and-safety.md).

## Done

Summarize the requested PR scope, material changes and actionable discussion. State pagination/body/patch limitations. Do not create drafts, reply, resolve, submit reviews or mutate PR state merely to read it.

[Sessions and transports](../diffing/references/sessions-and-transports.md)
