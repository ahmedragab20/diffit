---
name: diffing-start-review
description: Start or reopen a diffing UI for local changes or a GitHub pull request and hand it to the human. Use when the user asks to open diffing, start a review, or send changes for human review without reviewing or editing them yourself.
---

# Start a review

## Use this when

Open the requested review and hand it to the human. Do not create findings, edit files or publish a GitHub review unless separately asked.

## Before you start

Identify the consumer repository and requested scope. Call `review_session_status({})` when MCP is available. If several sessions exist, `diffing sessions --json` lists safe summaries; reuse only a matching mode/scope. PR identity needs `gh_overview({})`, not just an active-session flag.

MCP `start_review_session` starts/reuses only a local web session. It does not start TUI or PR mode. See [Sessions and transports](../diffing/references/sessions-and-transports.md) for persistence, binding and selection.

## Recipe

### Existing matching session

```bash
diffing sessions use SESSION_ID
diffing sessions open SESSION_ID --no-open
```

After changing CLI selection, reconnect MCP if used and verify its target. Do not assume a pinned connection follows the CLI.

### New local web review

```js
start_review_session({ diffArgs: ['--staged'] })
```

Use `{}` for default working-tree scope. Pass argument arrays, never shell-expanded user text. Use the returned URL/scope directly.

CLI launch recipes:

| Requested scope | Foreground launch |
| --- | --- |
| Working tree | `diffing --web --no-open` |
| Staged | `diffing --web --no-open --staged` |
| Branch comparison | `diffing --web --no-open main...HEAD` |
| Selected paths | `diffing --web --no-open -- src/` |
| Commit series | `diffing show HEAD~2..HEAD --web --no-open` |
| PR | `diffing --gh-pr owner/repo#123 --no-open` |

Keep launches alive through the host's persistent process facility. These commands do not detach themselves. Wait for startup success before returning a URL. New distinct scopes coexist; never stop another review merely to open this one.

### Human handoff

- **Web:** share the verified session URL. Local code uses **Send to agent**; a plan uses **Submit review** at its returned `/plan/ID` URL.
- **PR:** confirm identity, then share the verified `/gh/pr` URL. Drafting is local; **Submit to GitHub** is a separate authorized external action. There is no local Send-to-agent PR loop.
- **TUI:** say it is open in the human's terminal. Never share its capability-bearing agent API URL. Do not start web merely to inspect a live TUI diff.

## Recovery

If MCP is bound to another repository, use CLI from the consumer or ask the host to rebind. Never change into the diffing product checkout for foreign work. If the host cannot keep a server alive, ask the human to start it; do not invent a URL. Use `diffing doctor` for installation/availability problems, not destructive session replacement.

## Done

The selected session is reachable, its mode/scope is stated, and its safe human URL is shared (or TUI status reported). Park unless the user requested a synchronous loop; then use [Finish review](../diffing-finish-review/SKILL.md).

[Headless API](../diffing/references/headless-api.md) · [Recovery and safety](../diffing/references/recovery-and-safety.md)
