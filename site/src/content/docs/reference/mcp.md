---
title: MCP tools
description: All 55 Model Context Protocol tools exposed by diffing mcp.
summary: Session, bounded diff inspect, comments, plan review, mockup review, and GitHub PR tools over stdio MCP.
order: 2
section: reference
---

Launch:

```bash
diffing mcp
diffing mcp --repo /absolute/path/to/repository
```

Client snippet:

```json
{
  "mcpServers": {
    "diffing": {
      "command": "diffing",
      "args": ["mcp"]
    }
  }
}
```

Successful calls return readable text plus schema-validated `structuredContent`. Count verified against `src/mcp.ts` `registerTool` (**55** tools).

## Session

| Tool | Purpose |
|------|---------|
| `review_session_status` | Inspect repo binding and active session; use `nextAction` first |
| `start_review_session` | Idempotently start/reuse loopback web session; never replaces user sessions |

## Diff inspection

Prefer bounded tools over `get_diff` for large trees.

| Tool | Purpose |
| ------ | --------- |
| `get_diff` | Full patch (use sparingly). Includes `complete` and optional `omittedPaths` when untracked reads were skipped. |
| `diff_summary` | High-level change summary (optional `exclude: ["lockfiles"]`). `complete` is false when the snapshot omitted files. |
| `diff_files` | Paged file list (optional `path` glob; `nextCursor` is filtered) |
| `diff_hunks` | Hunks for a file (`path` XOR `file`) |
| `diff_slice` | Exact row window with budgets (`path` XOR `file`) |
| `diff_search` | Search within the diff (optional `path` glob) |

## Comments & handoff

| Tool | Purpose |
| ------ | --------- |
| `create_comment` | Inline finding (path, side, line/range, body, optional severity) |
| `await_review` | Sync wait for human Send to agent |
| `list_comments` | Snapshot threads |
| `reply_to_comment` | Agent reply |
| `resolve_comment` / `unresolve_comment` | Lifecycle |
| `edit_comment` / `delete_comment` | Mutate thread |
| `edit_reply` / `delete_reply` | Mutate reply |
| `apply_suggestion` | Apply ```` ```suggestion ```` fence |
| `resolve_all_comments` | Bulk resolve |
| `report_progress` | Live toast |
| `get_review_history` | Multi-round history |

## Plan review

| Tool | Purpose |
| ------ | --------- |
| `submit_plan` | Submit markdown (async park default) |
| `await_plan_review` | Sync wait for verdict |
| `list_plans` | All plans |
| `get_plan` | Current plan + comments as XML/data |
| `get_plan_versions` | Version metadata |
| `get_plan_version` | Historical body |
| `reply_to_plan_comment` | Reply |
| `resolve_plan_comment` | Resolve thread |

## Mockup review

| Tool | Purpose |
| ------ | --------- |
| `submit_mockup` | Submit HTML screen(s) (async park default) |
| `await_mockup_review` | Sync wait for verdict |
| `list_mockups` | All mockups (compact summaries) |
| `get_mockup` | One mockup + comments/screens (full body — prefer `inspect_mockup`) |
| `get_mockup_versions` | Version metadata |
| `get_mockup_version` | Historical version body |
| `inspect_mockup` | **Bounded reads** — `view=summary/comments/comment/screen/preview`, filters by `status`/`screenId`/`viewport` (`desktop`\|`tablet`\|`mobile`)/`version`, `context=none\|anchor\|source`, `cursor`/`limit` |
| `revise_mockup` | One-screen revision — `op=upsert/remove/patch/replace-region` with `expectedVersion` guard (409 on conflict) |
| `update_mockup_threads` | **Atomic thread batch** — reply/edit/delete/resolve/unresolve in one all-or-nothing call; never bumps the version |
| `reply_to_mockup_comment` | Reply (single op) |
| `resolve_mockup_comment` | Resolve thread (single op) |
| `unresolve_mockup_comment` | Re-open a resolved thread |
| `apply_mockup_suggestion` | Apply a ` ```suggestion ` fence to that comment's screen |
| `get_mockup_handoff` | Compact implementation packet after `approved` |
| `get_design_system` | Read published/draft tokens before authoring |
| `extract_design_system` | Scan the repo into a draft (does not publish) |
| `propose_design_system` | Update the draft |
| `publish_design_system` | Publish — human action unless asked |

Comment scope = version + screen + viewport: pass `viewport`/`version` filters to `inspect_mockup`, and expect `mockup-version=`/`viewport=` on handoff comments.

## GitHub PR

| Tool | Purpose |
| ------ | --------- |
| `gh_overview` | PR overview |
| `gh_list_threads` | Threads |
| `gh_list_reviews` | Reviews |
| `gh_list_draft_comments` | Local drafts |
| `gh_create_draft_comment` | Create draft |
| `gh_refresh` | Re-fetch remote state |
| `gh_submit_review` | Publish review (**explicit user auth**) |

## Await semantics

`await_review` / `await_plan_review` / `await_mockup_review` return `status: "released" | "timeout"`. Timeout includes `disposition: "park"` and `nextAction` — **end the turn**, do not silent-loop.

| Mode | When | Action |
|------|------|--------|
| Async (default) | Human may take a while | Share URL; park |
| Sync | Human reviewing now | One await (~570s); on timeout park |

## Prompts & resource

- Prompt `review_local_changes`
- Prompt `submit_plan_for_review`
- Resource `diffing://agent-guide`

## Related

- [Agent handoff](/docs/guides/agent-handoff/)
- [Setup & MCP](/docs/guides/setup-and-mcp/)
