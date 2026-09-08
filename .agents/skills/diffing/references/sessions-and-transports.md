# Sessions and transports

Use this reference to attach, select scope, or recover a connection. Use [the router](../SKILL.md) to choose a workflow and [Headless API](headless-api.md) for exact operations.

## 1. Identify the consumer repository

The consumer is the Git repository the human wants reviewed or changed. A tool being hosted by the diffing product checkout does not make that checkout the consumer.

- MCP: call `review_session_status({})`; check `repository`, `mode`, `serverState`, `diffArgs`, and `nextAction`.
- CLI: run commands from the consumer repository. `diffing sessions --json` gives safe session summaries, not credentials.
- Global MCP configuration: launch `diffing mcp --repo /absolute/consumer/path` through the host's MCP configuration. It is a stdio server, not an ordinary request command.
- If MCP points at the wrong repository, use the CLI in the consumer or ask the host to rebind. Never `cd` into the product to submit a foreign plan.

## 2. Select a matching session

```bash
diffing sessions --json
diffing sessions use SESSION_ID
diffing sessions open SESSION_ID --no-open
```

Replace uppercase placeholders with verified values. Match **both mode and scope**, not just newest/active. For PR mode, also confirm owner/repository/number with `gh_overview({})`. Unique ID prefixes are accepted. `use` retargets CLI commands; `open` selects and opens the UI unless `--no-open` is supplied.

MCP has no session list/use/stop tools. A connection that starts/reuses a web session or begins a wait can be pinned to it. After CLI selection, reconnect MCP intentionally and verify status; do not assume `sessions use` retargets an in-flight MCP workflow.

Session launches normally reuse the newest matching mode/scope; otherwise they create a concurrent active session. Other sessions remain running.

| Launch flag | Intent |
| --- | --- |
| `--new-session` | Deliberately duplicate even a matching session |
| `--reuse-session` | Reuse the active session regardless of scope; only when that is intended |
| `--replace-session` | Replace the active session; obtain explicit permission |

`diffing sessions stop SESSION_ID` stops that session. `stop active` and `stop all` exist; `kill` is an alias. Treat lifecycle changes as user-owned actions, not connection troubleshooting shortcuts. Stopping the active session selects a remaining live one, so recheck scope afterward.

## 3. Start only when needed

Preferred local-web MCP request:

```js
start_review_session({ diffArgs: ["--staged"] })
```

Omit `diffArgs` for the default working-tree review. The tool returns URL, scope and a started/reused result; use that result instead of rediscovering the URL. It never launches TUI or PR mode.

CLI equivalents, run from the consumer:

```bash
diffing --web --no-open
diffing --web --no-open --staged
diffing --web --no-open main...HEAD -- src/
diffing show HEAD~2..HEAD
diffing --gh-pr owner/repo#123 --no-open
```

These are **foreground server launches**, not self-detaching commands. Use the host's persistent process facility or an explicitly backgrounded process with logs outside the consumer tree. Confirm startup before handing over a URL. Do not let a shell timeout kill the server. A native TUI (`diffing --tui`) belongs in the human's terminal, not a headless agent job.

`start_review_session.diffArgs` accepts safe line-oriented Git diff arguments, not shell strings. Runtime flags, external drivers, output files and non-patch formats are rejected. Modifiers need a revision/pathspec anchor; baseline mode only accepts staged/cached selection. Use the CLI for PR/show/runtime launch options.

## Capability boundaries

| Mode | Supported agent workflow | Do not assume |
| --- | --- | --- |
| `none` | Start a compatible session | A valid review URL already exists |
| `web` | Bounded diffs, local comments/await, plans, mockups/design, progress/history, file APIs | Every comparison is writable |
| `tui` | Bounded diffs; list/create/edit/delete comment; reply; resolve/unresolve; await/status | Full-patch API, plans/mockups, progress/history, bulk resolve, suggestion application or reply edit/delete |
| `gh-pr` | PR overview, bounded diffs, discussion, local drafts, authorized GitHub actions | Local Send-to-agent or plan workflow; writable local PR preview |

For unsupported operations, select/start a compatible concurrent web session. Do not stop a TUI or PR just to submit a plan. A TUI API capability URL is **not** a human review URL; never share it.

## Transport choice and authentication

1. Registered diffing integration/MCP tools: use the host-exposed names and current schemas. Names may be prefixed. Prefer typed `structuredContent` over re-parsing readable text.
2. CLI: port-agnostic discovery and credential attachment are built in.
3. HTTP: for API-only operations or embedding; see the authenticated [request helper](headless-api.md#authenticated-json-requests).
4. Offline XML: permits discussion of a supplied handoff, not live writes or a new verified server state.

`diffing url` returns the selected web/PR review URL. Use its **origin** for `/api/` requests; a PR URL includes `/gh/pr`. Never hard-code a port or request credentials in the URL.

CLI/MCP attach `x-diffing-token` for web/PR and `X-Diffing-Capability` for TUI as appropriate. HTTP integrations need the selected session's credential supplied securely by their host, held in memory. There is no cookbook command that exports a token. Do not dump lockfiles or bootstrap HTML into logs to extract one; prefer CLI/MCP if the host cannot supply it safely.

Browser requests use a same-origin header or HttpOnly session cookie. Token query parameters are honored only for `/api/live` SSE, not ordinary API calls. Loopback Host checks protect HTML as well as API routes. Origin must match the request URL, except a loopback-bound API also accepts another loopback http(s) origin so the Vite client (`localhost:5173`) can proxy `/api` to the backend. Off-loopback Origins still have to match. Non-loopback authenticated HTML also requires credentials; there is no automatic LAN login flow. Do not bypass a 401/403 with `--insecure-no-auth` or expose a server on a wildcard host for convenience.

## CLI discovery map

This is command notation, not one script. `--help` and registered schemas settle version differences.

| Need | Command family |
| --- | --- |
| Setup/install skills | `diffing setup`, `diffing setup skills` (`init`/`onboard` aliases) |
| Diagnostics/update | `diffing doctor`, `diffing update`, `diffing completion bash\|zsh\|fish` |
| Preferred human mode | `diffing mode [web\|tui]` |
| Sessions | `diffing sessions [list] [--json]`, `use`, `open`, `stop` |
| Local launch | `diffing [--web\|--tui\|--terminal] [--no-open] [--skip-setup] [Git diff args] [-- paths]` |
| Commit series/PR launch | `diffing show REVSPEC`, `diffing --gh-pr REF --no-open` |
| Bounded diff | `diffing inspect summary\|files\|hunks\|slice\|search` |
| Local handoff | `diffing await-review`, `diffing comments [--open] [--format xml\|json\|md]` |
| Comment actions | `diffing reply`, `resolve`, `unresolve`, `comment edit\|delete` |
| Progress | `diffing progress --message TEXT [--pct N] [--comment-id ID] [--agent-id ID]` |
| Plans | `diffing plan submit\|await\|list\|show\|versions\|reply\|resolve` |
| Mockups | `diffing mockup submit\|await\|list\|show\|versions\|inspect\|screen\|threads\|apply-suggestion\|handoff` |
| Design system | `diffing design show\|list\|extract\|propose\|publish` |
| Evidence (read-only) | `diffing evidence list\|map\|read\|search\|symbols\|verify\|history\|discussion` |
| Notebook (writes) | `diffing evidence notebook\|decide` |
| PR reads/drafts | `diffing gh status\|overview\|threads\|reviews\|timeline\|pending\|pr-fetch\|pr-list-comments` |
| Authorized PR writes | `diffing gh pr-review\|pr-update\|pr-close\|pr-reopen\|pr-merge` |

Install the complete skill set for sibling workflow links. The router's `references/` directory must travel with it; copying only `SKILL.md` loses the cookbook. No consumer checkout of the diffing source is needed to use these recipes.

## Input, waiting and exit codes

Prefer inline MCP bodies or CLI stdin for long Markdown/HTML. Plan/mockup submission supports `-`; reply commands accept stdin when `--body` is omitted. Do not infer stdin support for every subcommand. Keep scratch under `~/.diffing/`, never in the consumer tree. `--model` records provenance, not inference or authorization.

CLI review/plan/mockup await budgets default to **570 seconds**; `--timeout` is positive seconds. MCP uses its own `timeoutSeconds` schema. HTTP long-poll `timeoutMs` is milliseconds, capped at 50,000 per request. Do not mix units.

Agent command exit conventions: **0** success, **2** await timeout, **3** no server/connection failure, **4** missing resource, **5** usage. Some operations return other failure codes; retain stderr/status rather than classifying every failure from the number alone.

Share the returned URL and end the turn by default. Resume once the human says ready; use a synchronous await only when requested or reviewing now. A timeout is a park signal, not approval or a reason for an endless retry loop. See [Recovery and safety](recovery-and-safety.md).

Source provenance: `src/cli-agent.ts`, `src/cli-gh.ts`, `src/mcp.ts`, `src/lib/server-auth.ts`, `src/lib/session-url.ts`, `src/lib/session-manager.ts`, `crates/diffing-tui/src/agent_api.rs`.
