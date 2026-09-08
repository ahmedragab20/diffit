# Code intel (LSP) — working notes

Internal working notes for the `feat/code-intel-lsp` branch. Not user documentation.
If you are an agent picking this up mid-flight, read this file first, then `git log --oneline main..HEAD`.

Plan (approved, v2): `http://127.0.0.1:54670/plan/80b51560-2396-49dd-9814-73e687495357`

## What this is

Turn the diff page into an editor-first review surface: hover for types and docs,
go to declaration, real compiler diagnostics while editing in place, and act on them.

Three stages, each independently shippable, landing as separate commits on one PR.

## Why so little new machinery is needed

Almost everything is already in the repo; this is mostly wiring.

| Piece | Where |
| --- | --- |
| Bounded LSP client (definitions, references) | `src/lib/ai/lsp.ts` |
| Server pool, max 4, 5-min idle shutdown | `src/lib/ai/language-servers.ts` |
| Pool already constructed in the web server | `src/server.ts:605` |
| Token hooks on the diff renderer (`onTokenEnter/Leave/Click`) | `FileDiffOptions extends InteractionManagerBaseOptions<'diff'>` — unused today |
| In-place edit sessions, `setMarkers`, 300ms debounce | `src/ui/hooks/useEditSessions.ts` |
| `applyEdits(TextEdit[])`, LSP-shaped `Position`/`Range`/`TextEdit` | `@pierre/diffs/edit` |
| SSE push channel with named events | `/api/live`, `src/server.ts:706`; client `src/ui/live.ts:76` |
| Settings + toolbar toggle precedent | `editDiagnostics` in `useSettings.ts`, `Toolbar.tsx`, `App.tsx` |

`@pierre/diffs` 1.4.1 gives the *surface* (editor, markers, popovers, keymap, selection
actions, edit prediction hook). It has no language intelligence at all. That half is ours.

## Decisions locked at approval

1. **Server owns availability.** A lookup is available only when all hold: `!prMode`,
   `!customMode`, `!staged`, `side === 'additions'`, a configured server for the
   extension, and the path resolves inside the repo root. Anything else returns
   `{ available: false, reason }` — never an empty result dressed as "no matches".
2. **Capability probe gates the client.** When unconfigured or the setting is off, the
   token callbacks are never attached; the default render path is unchanged.
3. **Named `code-intel`, not `ai`.** Route `/api/code-intel`, module
   `src/lib/code-intel.ts`, setting `codeIntel`.
4. **Hover/code-action content is untrusted** — `react-markdown` + `rehype-sanitize`,
   no raw HTML, no auto-followed links.
5. **The language server never gains authority.** No `workspace/applyEdit`, no
   `workspace/executeCommand`. Server→client *requests* keep getting "Method not found".
   Stage 2 accepts exactly one inbound notification (`textDocument/publishDiagnostics`,
   URI-scoped to documents we opened). Asserted in `adversarial.test.ts`.
6. **Version-guard diagnostics.** A `publishDiagnostics` batch is dropped unless its
   version matches the current draft. Otherwise squiggles land on moved lines.
7. **Stage 3 edits are confined to the open file.** A rename spilling into other files
   is reported, not applied.

Open questions were approved as recommended:

- `codeIntel` **off by default**, toolbar toggle beside Edit diagnostics.
- Accept a `languageServers` **alias** in `sanitizeLanguageServers`; `aiLanguageServers`
  keeps working.
- **Build the peek panel** in stage 1.
- **Open-file-only** edits in stage 3.
- **Separate commits**, reviewed in order, one PR.

## Progress

Legend: `[ ]` not started · `[~]` in progress · `[x]` done and verified

### Stage 1 — hover, go-to-declaration, peek

- [x] 1.1 `src/lib/ai/lsp.ts` — `hover()`, `hoverBytes` limit, hover capability
- [x] 1.2 `src/lib/code-intel.ts` — availability rule, URI mapping, result shaping
- [x] 1.3 `src/server.ts` — `GET /api/code-intel/capabilities`, `POST /api/code-intel`
- [x] 1.4 `src/ui/hooks/useCodeIntel.ts` — capability query, debounce, abort, LRU
- [x] 1.5 `src/ui/components/CodeIntelPopover.tsx`
- [x] 1.6 `src/ui/components/DefinitionPeek.tsx` (+ `src/ui/lib/definitionPeek.ts`)
- [x] 1.7 `src/ui/components/FileDiffCard.tsx` — wire the three token callbacks
- [x] 1.8 Settings + toolbar toggle

### Stage 2 — diagnostics while editing

- [x] 2.1 `src/lib/ai/lsp.ts` — document sync, accept `publishDiagnostics`
- [x] 2.2 `src/lib/code-intel.ts` — draft registry, `Diagnostic` → marker
- [x] 2.3 `src/server.ts` — `POST /api/code-intel/document`, SSE broadcast
- [~] 2.4 `src/ui/hooks/useEditSessions.ts` — push versions, consume diagnostics
- [x] 2.5 `src/ui/lib/mergeMarkers.ts` — merge, dedupe, cap at 500
- [x] 2.6 Status affordance (see the note below on what this became)

### Stage 3 — act on the code

- [ ] 3.1 `src/lib/ai/lsp.ts` — rename, format, code actions, signature help, highlights
- [ ] 3.2 `src/lib/code-intel.ts` — `WorkspaceEdit` → open-file `TextEdit[]` + spill count
- [ ] 3.3 `src/server.ts` — extend the op union
- [ ] 3.4 `src/ui/components/FileDiffCard.tsx` — selection actions, keymap bindings
- [ ] 3.5 `src/ui/hooks/useCodeIntel.ts` — action fetchers and the apply path
- [ ] 3.6 Edit prediction provider behind its own setting

### Wrap-up

- [ ] User-facing docs (`docs/code-intel.md`)
- [ ] Full suite green (`pnpm test:ts`)
- [ ] Manual end-to-end pass with a real `typescript-language-server`

## Gotchas found along the way

- **The capability probe runs regardless of the setting.** The plan said nothing
  would be probed until `codeIntel` was on, but then the settings toggle cannot
  explain why switching it on does nothing. One small `GET` per session is the
  better trade. The promise that matters — *no token listener is attached* until
  the setting is on **and** a server is configured — is unchanged.
- **Dirty-file suppression is client-side.** The server has no idea a browser
  holds an unsaved draft (`/api/edit-save` only writes), so `useCodeIntel` skips
  lookups for a file with `editSession.dirty`. Covered by the hook test, not the
  server availability matrix as the plan sketched.
- **`isCustomMode` is a private local in `server.ts:305`**, not an export from
  `diff-engine.ts`. `code-intel.ts` takes plain booleans instead of `DiffOptions`
  so it stays pure and trivially testable.
- **Indentation is per file.** `server.ts`, `App.tsx`, `Toolbar.tsx`,
  `useSettings.ts` and `ReviewSettingsPopover.tsx` use tabs; `DiffViewer.tsx`,
  `FileDiffCard.tsx`, `file-schema.ts` and the `src/ui/hooks` files use two
  spaces. There is no formatter in this repo — no biome, prettier or eslint
  config, and no lint script. Match the file you are in.
- **Token hooks live inside the `options` prop**, not as top-level props:
  `FileDiffOptions extends InteractionManagerBaseOptions<'diff'>`. There are
  three `options` objects in `FileDiffCard.tsx` (edit, read, virtualized
  fallback) and all three need them.
- **`PrReviewApp.tsx` renders `ReviewSettingsPopover` directly**, so any new
  required prop on that component has to be passed there too.
- **A language server answers nothing about a file it was not given.** Probed
  directly against `typescript-language-server`: hover without `didOpen` returns
  `{"contents":[]}`; with it, the full type and JSDoc. Document sync was planned
  for stage 2, but stage 1 does not work at all without it, so a minimal
  read-only version (open off disk, keep open, `didChange` when mtime/size
  moves) landed here. **This is also a live defect in the shipped AI symbol
  path** — `ai/symbols.ts` never opens documents, so its definition/reference
  lookups return empty against tsserver-family servers and report "no results".
  Out of scope for this branch; `LspSession` now has what it needs to fix it.
- **`LSP_LIMITS.totalBytes` was a lifetime cap, not a memory cap.** The decoder
  added every received byte to a running total and failed the session past 16
  MB. Harmless for short AI lookups; fatal once a session stays open and streams
  diagnostics. Now bounds *buffered* bytes and is named `bufferedBytes`.
- **`useTokenTransformer` is a worker-pool render option, not a per-file one.**
  This is the one that cost the most time. Passing it in a card's `options` type
  checks, reaches `DiffHunksRenderer`, and does nothing: the worker pool holds
  its own `renderOptions`, so the flag has to go through
  `poolManager.setRenderOptions(...)` in `App.tsx`. Without it the renderer emits
  whole-line `data-diff-span` markup, no `data-char` token elements exist, and
  `onTokenEnter` can never fire. Symptom: everything wired correctly, zero
  requests, no errors anywhere.
- **Diff code lives in a shadow root** (`<diffs-container>`). Fine for
  `getBoundingClientRect` and for portalling a popover to `document.body`, but
  DOM queries from outside must hop `shadowRoot` explicitly.
- **`scrollIntoView` drags the horizontal axis too.** In the peek panel that hid
  the start of every line; the fix resets `scrollLeft` after the scroll settles.
- **`typescript-language-server` publishes diagnostics with no `version`.**
  Verified against the real binary. The plan leaned on the version to drop a
  stale batch, and the mechanism is implemented and honoured when a server does
  send one — but it cannot be relied on. Two guards carry the weight instead:
  a version-less batch is only accepted while the draft still equals the text
  that was pushed, and **every push drops the markers already held**, so between
  a keystroke settling and the server answering, the file shows only the
  built-in checks rather than squiggles describing text that has moved. The
  residual window is a batch for push N arriving after push N+1 went out; the
  next batch corrects it.
- **Drafts and disk must not fight over one document.** A document opened from a
  browser draft is stamped `draft:` and the disk-sync path leaves it alone —
  otherwise a hover lookup would push disk contents over the text the reviewer
  is typing. `closeDraft` on exiting edit mode hands the file back to disk.
- **2.6 became a tooltip, not a widget.** The plan sketched a server
  connected/starting/unavailable indicator. In practice the settings toggle
  already carries the availability reason, and the markers themselves are the
  feedback that a server is answering. What was actually missing was that
  server diagnostics need **both** `codeIntel` and `editDiagnostics`, so the
  Code intel toggle now says so. A live status widget was deliberately not
  built rather than adding UI nobody asked for.

## Verification log

### Stage 2

`npx vitest run` — all green (see the run below).

Real diagnostics over the live channel, against `typescript-language-server`,
for a draft that exists only in memory (no such file on disk):

```
POST /api/code-intel/document
  {"op":"change","path":"src/lib/code-intel-draft-probe.ts","version":41,
   "text":"const n: number = \"not a number\";\nexport function f(a: string) { return a.nope() }\n"}
  → {"ok":true}

/api/live  event: code-intel-diagnostics
  → path src/lib/code-intel-draft-probe.ts, version undefined, 3 markers
      error typescript 0:6  Type 'string' is not assignable to type 'number'.
      error typescript 1:40 Property 'nope' does not exist on type 'string'.
      hint  typescript 0:6  'n' is declared but its value is never read.
```

### Stage 1

`npx vitest run` — 228 files, 2813 tests, all passing.
`npx tsc --noEmit -p tsconfig.json` — clean. `npx vite build` — clean.

End-to-end against a real `typescript-language-server`, with an isolated
`HOME` so the developer's own settings were untouched:

```
GET /api/code-intel/capabilities
  → {"configured":true,"extensions":["ts","tsx"]}

POST /api/code-intel {"op":"hover","path":"src/lib/code-intel.ts",
                      "side":"additions","line":239,"character":22}
  → "```typescript\nfunction codeIntel(servers: LanguageServers, …)\n```
     Look up a position in the review. Every refusal names its reason…"

POST /api/code-intel {"op":"definition","path":"src/lib/code-intel.ts",
                      "side":"additions","line":18,"character":20}
  → src/lib/ai/language-servers.ts:25, inRepository: true
```

In the browser: hovering `LanguageServers` in the diff shows the type popover;
⌘-click opens the peek panel at `src/lib/ai/language-servers.ts:25` on the
`export class LanguageServers {` line. The settings toggle renders under
Editing and reflects the stored value.
