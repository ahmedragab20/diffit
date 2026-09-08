# Operating the AI review surface

How to enable, configure, verify and roll back the AI evidence surface. This
covers operation only; it is not an acceptance record, and nothing here claims a
human-approved quality threshold.

## What ships

| Surface | Where | Authority |
| --- | --- | --- |
| Evidence navigation | `/api/ai/evidence*`, `ai_evidence_*` MCP tools, `diffing evidence …` | Read-only |
| Inference runs | `POST /api/ai/run` | Requires `trigger: "user"` |
| Model/connection listing | `/api/ai/models`, `/api/ai/connections` | Read-only |

Evidence navigation reads a review snapshot a run already captured. It reaches
no shell, network or filesystem of its own, and cannot widen the capture it was
given.

## Feature flags

| Setting | Default | Effect |
| --- | --- | --- |
| `aiEvidenceTools` | `true` | `false` answers every `/api/ai/evidence*` route `404`, which also disables the matching MCP tools since they call those routes. |
| `aiLanguageServers` | `{}` | Empty means definition/reference lookups report themselves unavailable. |

Both live in the settings file (`diffing config` or the settings UI). The
evidence flag is read per request, so **rollback takes effect immediately and
needs no restart**:

```jsonc
{ "aiEvidenceTools": false }
```

Disabling evidence navigation leaves the rest of the AI surface untouched —
model listing and runs continue to work. The flag gates the HTTP routes, so the
MCP tools and the `diffing evidence` CLI, which both call those routes, are
disabled with them.

## Configuring language servers

Definition and reference lookups need a language server per file extension.
Nothing is presumed, so the feature stays unavailable until one is configured:

```jsonc
{
  "aiLanguageServers": {
    "ts": { "command": "typescript-language-server", "args": ["--stdio"] },
    "rs": { "command": "rust-analyzer" }
  }
}
```

The command is resolved on `PATH` and never run through a shell. A malformed
entry is dropped on load rather than repaired, which disables that extension's
lookups instead of running something unintended. A server that is absent or
fails to start is reported as `unavailable` — which is **not** the same as
"no references", and the API says so explicitly.

A language server answers about the working tree, not about the capture. Any
location it returns that falls outside the captured snapshot is named but
marked out of scope and is never readable.

## Storage

AI turn state is an append-only journal at `ai-turns.jsonl` in the per-repo
storage directory under `~/.diffing`.

- **Rollback**: the journal is append-only and compaction preserves the prior
  file as `ai-turns.jsonl.bak`, so a bad compaction is recoverable by restoring
  that file.
- **Recovery**: a torn trailing line from a crash is discarded on load and
  reported by line number; every record before it is kept.
- **Migration**: a journal written by a newer version is refused and left byte
  for byte intact. Downgrading never rewrites data it does not understand.
- **Single writer**: one server owns a repository at a time, which the server
  lock already enforces. Do not point two servers at one storage directory.

### Why not SQLite

`node:sqlite` does not exist on Node 20, which `engines` still declares, and
`better-sqlite3` is a native module requiring a prebuild for each of the seven
packaged platforms. The journal is behind a narrow interface, so a SQLite
driver can replace it without touching callers once the Node floor moves.

## Providers

The five defaults are Codex, Claude Code, OpenCode, Cursor and direct Grok.
Direct OpenAI and Anthropic paths remain dormant and are not registered as
defaults; `src/__tests__/ai-release-gates.test.ts` fails if that drifts.

Provider secrets are never written to the settings file. Direct BYOK secrets
use the OS credential vault or session memory; OpenCode/Cursor-managed BYOK
stays in the owning runtime.

## Verifying a build

```sh
pnpm exec tsc --noEmit     # type gate
pnpm exec vitest run       # full suite
pnpm run build:ts          # bundle
pnpm --silent bench:ai     # offline context and retrieval baselines
pnpm --silent eval:ai      # offline replay corpus
```

`native-bundle.test.ts` requires `npm_execpath` and seven prebuilt native TUI
binaries, so run the suite through `pnpm test` in an environment where the
native build has run.

Exit status 0 from the baseline runners means the runner completed. It is not
an acceptance or quality gate: `humanApprovedThresholds` and
`qualityThresholdsApproved` both remain false until a human adjudicates them.

## Incident checklist

| Symptom | First step |
| --- | --- |
| Evidence routes 404 unexpectedly | Check `aiEvidenceTools`; `false` disables them by design. |
| Definitions/references always unavailable | Check `aiLanguageServers` has an entry for that extension and the command is on `PATH`. |
| A run reports stale evidence | The working tree or index moved after capture. Re-run; the capture is deliberately optimistic and re-checked before use. |
| Storage load reports `truncatedAtLine` | A crash tore the last write. Records before it are intact; compact to drop the tail, which keeps the original as `.bak`. |
| Storage refuses to load | The journal came from a newer version. Do not delete it — it is intact and readable by that version. |
