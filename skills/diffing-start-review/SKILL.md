---
name: diffing-start-review
description: Open or reopen a diffing review UI for local changes or a GitHub pull request and hand the URL to the human. Use when asked to open diffing, start a review, or send changes for someone to look at, without reviewing or editing them yourself.
license: MIT
metadata:
  author: ahmedragab20
  version: "0.20.1"
user_invocable: true
---

# Start a review

## Use this when

The human wants the changes in front of them. Open the requested review and hand it over. Findings, edits and GitHub publication are separate asks — see [Review changes](../diffing-review/SKILL.md) and [Finish review](../diffing-finish-review/SKILL.md).

## Before you start

```js
review_session_status({})  // repository, mode, scope
gh_overview({})            // gh-pr mode only: confirms owner/repo/number
```

- Name the consumer repository and the requested scope before launching anything.
- With several sessions live, `diffing sessions --json` gives safe summaries; reuse one only when mode **and** scope match.
- PR identity comes from `gh_overview({})`, not from an active-session flag.
- MCP `start_review_session` starts or reuses a **local web** session only. TUI and PR launches are CLI. [Sessions and transports](../diffing/references/sessions-and-transports.md) covers persistence, binding and selection.

## Recipe

### Reuse an existing matching session

```bash
diffing sessions use SESSION_ID
diffing sessions open SESSION_ID --no-open
```

After changing CLI selection, reconnect MCP if you are using it and re-verify its target — a pinned connection does not follow the CLI.

### Start a new local web review

```js
start_review_session({ diffArgs: ['--staged'] })
```

Use `{}` for the default working-tree scope. Pass argument arrays, never shell-expanded user text. Hand back the URL and scope it returns.

CLI launches, from the consumer repository:

| Requested scope | Foreground launch |
| --- | --- |
| Working tree | `diffing --web --no-open` |
| Staged | `diffing --web --no-open --staged` |
| Branch comparison | `diffing --web --no-open main...HEAD` |
| Selected paths | `diffing --web --no-open -- src/` |
| Commit series | `diffing show HEAD~2..HEAD --web --no-open` |
| PR | `diffing --gh-pr owner/repo#123 --no-open` |

These commands hold the terminal — keep them alive through the host's persistent process facility, and wait for startup to succeed before returning a URL. New distinct scopes coexist, so leave other reviews running.

### Hand it to the human

- **Web:** share the verified session URL. Local code comes back through **Send to agent**; a plan comes back through **Submit review** at its `/plan/ID` URL.
- **PR:** confirm identity, then share the verified `/gh/pr` URL. Drafting is local; **Submit to GitHub** is a separate authorized action. PR mode has no Send-to-agent loop.
- **TUI:** say it is open in their terminal. Its agent API URL carries a capability — keep it out of chat. Inspect a live TUI diff through TUI-supported reads rather than starting a web session for it.

## Recovery

If MCP is bound to another repository, drive the CLI from the consumer or ask the host to rebind. If the host cannot keep a server alive, ask the human to start it and wait for a real URL. `diffing doctor` handles installation and availability problems; session replacement is the human's call.

## Done

The selected session is reachable, its mode and scope are stated, and its safe human URL is shared (or TUI status reported). Park unless the user asked for a synchronous loop; then continue with [Finish review](../diffing-finish-review/SKILL.md).

[Router](../diffing/SKILL.md) · [Review changes](../diffing-review/SKILL.md) · [Finish review](../diffing-finish-review/SKILL.md) · [Headless API](../diffing/references/headless-api.md) · [Recovery](../diffing/references/recovery-and-safety.md)
