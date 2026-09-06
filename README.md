# diffing

<p align="center">
  <img src="public/favicon.svg" alt="diffing brand icon" width="72" height="72" />
</p>

**Local-first CLI for reviewing git diffs with humans and AI agents.**

Open your changes in a GitHub-like web UI (or an experimental native TUI), leave inline comments, hand them to your coding agent over CLI/MCP, and review **implementation plans** the same way before any code is written. Everything binds to loopback by default — no account, no cloud.

**npm:** [npmjs.com/package/diffing](https://www.npmjs.com/package/diffing) · **Docs:** [ahmedragab20.github.io/diffing](https://ahmedragab20.github.io/diffing/) · **Agents:** [llms.txt](https://ahmedragab20.github.io/diffing/llms.txt)

---

## Quick start

**Requirements:** Node.js 20+, `git` on your PATH. Local working-tree previews, edits and uploaded-image operations also require the compiled native file helper, bundled on supported platforms; no Rust toolchain is needed for a packaged install. Missing/incompatible helpers deny those operations rather than falling back to Node file access. Basic Git diffs and comments remain available.

This is **not a complete repository sandbox**. See the [implemented guarantees, known limits and deferred-work handoff](./docs/hardening-status.md).

```bash
npm install -g diffing
# or: pnpm add -g diffing

diffing setup          # first-time wizard (skills, MCP, doctor)
cd your-repo
diffing                # preferred interactive UI (web by default)
```

Useful variants:

```bash
diffing --staged
diffing main..feature
diffing view           # read-only native diff browser
diffing --tui          # full native review TUI (experimental)
diffing mode tui       # make TUI the interactive default
diffing update
```

TTY opens the interactive UI. Pipe or redirect prints a unified patch like `git diff`.

---

## What you get

| Area | Highlights |
| ------ | ------------ |
| **Review UI** | Split/unified diffs, inline comments + severity, suggestions, image diffs, themes (52), search |
| **Agents** | `await-review`, reply/resolve, progress, MCP (**55** tools), skills via `npx skills add ahmedragab20/diffing` |
| **Plan review** | Submit markdown → human verdict → approved / changes-requested / rejected |
| **GitHub PR** | Local PR sessions (`--gh-pr`), bounded inspect, optional authorized publish |
| **Sessions** | Concurrent web/TUI/PR reviews; `diffing sessions` task manager |
| **Local-first** | `127.0.0.1`, random free port, state under `~/.diffing/` |

> **TUI is experimental.** Web is the supported production path. See [docs](https://ahmedragab20.github.io/diffing/docs/guides/tui/).

---

## Agent one-liners

```bash
diffing                          # human reviews in browser
diffing url                      # share link; async park by default
diffing await-review             # only when human is reviewing now
diffing comments --open
diffing reply <id> --body "…" --model "your-model"
diffing resolve <id>
diffing plan submit PLAN.md --model "your-model"
diffing mcp
```

Full agent protocol, exit codes, and MCP catalog: **[Documentation](https://ahmedragab20.github.io/diffing/docs/)** · in-repo [AGENTS.md](./AGENTS.md).

---

## Development checks

Source contributors need Rust for the file helper. Build it before running the TypeScript suite, which includes real-helper integration tests:

```bash
pnpm build:tui:debug
pnpm test:ts
cargo test --workspace
pnpm build
```

`pnpm exec tsc --noEmit` is a separate check; its remaining known failures are tracked in [the handoff](./docs/hardening-status.md). No passing-test claim implies a clean typecheck.

## Documentation

| | |
| -- | -- |
| Getting started | <https://ahmedragab20.github.io/diffing/docs/getting-started/> |
| Agent handoff | <https://ahmedragab20.github.io/diffing/docs/guides/agent-handoff/> |
| Plan review | <https://ahmedragab20.github.io/diffing/docs/guides/plan-review/> |
| CLI reference | <https://ahmedragab20.github.io/diffing/docs/reference/cli/> |
| MCP tools | <https://ahmedragab20.github.io/diffing/docs/reference/mcp/> |
| Keyboard | <https://ahmedragab20.github.io/diffing/docs/reference/keyboard/> |
| Design (Gridline) | <https://ahmedragab20.github.io/diffing/docs/design/gridline/> |
| llms.txt | <https://ahmedragab20.github.io/diffing/llms.txt> |

Local site preview (contributors):

```bash
pnpm --dir site install --ignore-workspace
pnpm docs:dev
```

---

## Links

- **npm:** <https://www.npmjs.com/package/diffing>
- **GitHub:** <https://github.com/ahmedragab20/diffing>
- **Docs:** <https://ahmedragab20.github.io/diffing/>

## License

MIT · [github.com/ahmedragab20/diffing](https://github.com/ahmedragab20/diffing)
