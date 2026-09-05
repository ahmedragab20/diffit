---
title: CLI reference
description: Primary command, server flags, agent subcommands, and git-compatible options.
summary: diffing is a git-diff drop-in with review server flags plus agent, plan, sessions, gh, and inspect subcommands.
order: 1
section: reference
---

## Primary command

```bash
diffing [options] [<revision>...] [-- <path>...]
```

Drop-in for `git diff` revisions, options, and pathspecs. On a TTY, opens the preferred interactive UI; otherwise prints a unified patch.

### Server / session options

| Flag | Description |
| ------ | ------------- |
| `--port <port>` | Fixed port; default is a random free port |
| `--host <host>` | Bind address (default `127.0.0.1`) |
| `--insecure-no-auth` | Required with wildcard binds (`0.0.0.0`/`::`); disables API auth, including loopback tokens |
| `--no-open` | Do not auto-open browser |
| `--reuse-session` | Open active session and exit |
| `--replace-session` | Stop active, then start with current args |
| `--web` | Force web UI |
| `--terminal` | Force stdout patch |
| `--view` | Read-only native viewer |
| `--tui` | Full native review TUI (experimental) |
| `--gh-pr <ref>` | GitHub PR session |
| `--skip-setup` | Bypass first-run setup gate |
| `--staged` / other git flags | Same semantics as `git diff` |

### Git-compatible flag groups

Revisions/range · algorithms · whitespace · context · word-diff · renames/copies · output formats · filtering · output control — 60+ flags across 12 categories. Output-format flags force terminal mode.

Examples:

```bash
diffing --staged
diffing HEAD~3
diffing main..feature
diffing -w -- src/
diffing --stat              # terminal mode
```

## Subcommands

| Command | Role |
| --------- | ------ |
| `sessions …` | List / use / open / stop live sessions |
| `mode [web\|tui]` | Get/set default interactive mode |
| `await-review` | Sync wait for Send to agent |
| `comments` | Dump comments (XML/JSON/md) |
| `reply` / `resolve` / `unresolve` | Thread lifecycle |
| `comment edit` / `comment delete` | Mutate threads |
| `progress` | Live agent progress toast |
| `url` | Active base URL |
| `inspect …` | Bounded diff reads |
| `plan …` | Plan review loop |
| `mockup …` | Mockup review loop |
| `design …` | Per-repo design system |
| `gh …` | GitHub PR automation |
| `mcp` | Stdio MCP server |
| `setup` / `init` / `onboard` | First-time wizard |
| `doctor` | Environment self-check |
| `completion <shell>` | Shell completions |
| `update` | Self-upgrade via npm/pnpm |
| `view` | Read-only TUI viewer |

### sessions

```bash
diffing sessions
diffing sessions --json
diffing sessions use <id>
diffing sessions open [<id>|active]
diffing sessions stop <id>|active|all
```

### mode

```bash
diffing mode
diffing mode web
diffing mode tui
```

Stored as `defaultMode` in settings. Applies only on interactive TTY without an explicit mode flag.

### await-review

```bash
diffing await-review [-t|--timeout <seconds>]
```

Default timeout **570**. Exit `0` / `2` / `3` / `5`. Prefer async park when the human is not reviewing now.

### comments

```bash
diffing comments [--open] [--json] [--format xml|json|md|markdown]
```

### reply / resolve / unresolve

```bash
diffing reply <id> --body <text> [--model <name>]
diffing resolve <id>
diffing unresolve <id>
```

Body may be `-` or stdin for `reply`.

### progress

```bash
diffing progress --message "Working…" [--model M] [--pct 40]
```

### url

```bash
diffing url
```

### inspect

```bash
diffing inspect summary [--exclude lockfiles]
diffing inspect files [--path GLOB]
diffing inspect hunks --file <n> | --path GLOB
diffing inspect slice --file <n> | --path GLOB [--start R] …
diffing inspect search --query "…" [--path GLOB]
```

Token-efficient alternative to dumping the full patch. Mirrors MCP `diff_*` tools.

### plan

```bash
diffing plan submit [<file>|-] [--title T] [--source S] [--model M] [--id ID] [--wait] [--timeout N] [--save-source|-S]
diffing plan await [--timeout N]
diffing plan list [--json]
diffing plan show [<id>] [--version n] [--json]
diffing plan versions <id>
diffing plan reply <comment-id> --body <text> [--model M]
diffing plan resolve <comment-id>
```

### gh

```bash
diffing gh status
diffing gh overview
diffing gh threads
diffing gh reviews
# plus pr-fetch / pr-list-comments / pr-review (see deep CLI in repo docs/cli.md)
```

### mcp

```bash
diffing mcp [--repo /abs/path]
```

### setup / doctor / update

```bash
diffing setup [--yes] [--check] [--reset]
diffing doctor
diffing update
diffing completion zsh
```

## Exit codes

See [Exit codes](/docs/reference/exit-codes/).

## Source

Deep historical manual: repository `docs/cli.md` (superseded by this site for public docs; retained for cutover). Verified against CLI sources for v0.13.x.
