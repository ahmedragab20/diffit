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

- [ ] 1.1 `src/lib/ai/lsp.ts` — `hover()`, `hoverBytes` limit, hover capability
- [ ] 1.2 `src/lib/code-intel.ts` — availability rule, URI mapping, result shaping
- [ ] 1.3 `src/server.ts` — `GET /api/code-intel/capabilities`, `POST /api/code-intel`
- [ ] 1.4 `src/ui/hooks/useCodeIntel.ts` — capability query, debounce, abort, LRU
- [ ] 1.5 `src/ui/components/CodeIntelPopover.tsx`
- [ ] 1.6 `src/ui/components/DefinitionPeek.tsx`
- [ ] 1.7 `src/ui/components/FileDiffCard.tsx` — wire the three token callbacks
- [ ] 1.8 Settings + toolbar toggle

### Stage 2 — diagnostics while editing

- [ ] 2.1 `src/lib/ai/lsp.ts` — document sync, accept `publishDiagnostics`
- [ ] 2.2 `src/lib/code-intel.ts` — open-document registry, `Diagnostic` → marker
- [ ] 2.3 `src/server.ts` — `POST /api/code-intel/document`, SSE broadcast
- [ ] 2.4 `src/ui/hooks/useEditSessions.ts` — push versions, consume diagnostics
- [ ] 2.5 `src/ui/lib/mergeMarkers.ts` — merge, dedupe, cap at 500
- [ ] 2.6 Status affordance in the toolbar

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

_(appended as they are hit)_

## Verification log

_(command output that actually ran, appended per stage)_
