# Hardening status and continuation handoff

This is an implemented safety slice, not a completed hardening roadmap. Remaining work was explicitly deferred by the project owner to a later release or another agent. A pull request is authorized; merging and publishing a release are not.

## Implemented scope

- HTML/API Host and Origin checks, protected non-loopback bootstrap, no-store/nosniff/no-referrer headers, and same-origin browser credentials.
- Bounded code-comment/reply validation and safe TypeScript/Rust XML serialization.
- Hunk-based changed-line totals in the header and minimap.
- A Rust directory-capability filesystem core and bounded JSON-lines helper, with a strict Node client. Selected local previews, saves, edits, suggestions and uploaded-image operations use it. TUI preview/image readers and LSP document-content loading use capability reads too.
- Explicit native access errors, optimistic hash checks for edit-save/suggestions, partial-write reporting, sandboxed raw previews, and captured image data URLs for Codex.

**This is not a complete repository sandbox.** Untracked-file and EditorConfig reads still bypass this provider. Git, editors, LSP servers and the native search backend are not sandboxed. Do not treat the selected-route protections as permission to run arbitrary untrusted repositories or tools.

## Operational contract and known limits

- Supported packaged installs supply a compiled native helper. Source contributors need Rust and must run `pnpm build:tui:debug` before the native integration tests in `pnpm test:ts`.
- File-helper discovery only probes verified installation/source-local candidates; it never searches PATH. The helper and its probes receive no application environment variables except Windows `SystemRoot` where needed. See `src/lib/find-tui-binary.ts`.
- `src/lib/native-fs.ts` uses one helper per root, strict protocol/hash/size checks, 50 MiB native file and 70 MiB frame limits, and bounded in-flight requests. A failed transport stays failed until explicit reset/restart. There is no Node filesystem fallback or automatic write retry.
- Missing/incompatible helpers return `503` for affected local file operations. Basic Git diff review and comments remain available. This does not make the remaining legacy readers contained.
- `baseHash` on edit-save is optional and must be 64 lowercase hex characters. Suggestions pass the hash of their just-read bytes. These are optimistic pre-write checks, **not cross-process compare-and-swap**. `save-file` has no hash precondition.
- A reported comment-store failure after a successful file write returns `500` with `fileSaved: true`; edit-save also returns the saved `hash`. Resolve/reconcile metadata separately rather than reapplying the file change. A failed optional Git stage returns `200`, `ok: true`, and `gitAddError` because the file was already saved.
- Native write errors with `outcomeUnknown: true` require inspecting current file state before retrying. Never blindly replay them.
- Local preview selection is still legacy: `new` reads the working tree and `old` reads `HEAD`. It does not yet reproduce staged/revision/commit-series sides exactly. PR previews use the session's base/head SHAs. Some legacy Git errors still appear as missing content. A03/A07 remain open.

## Verification checkpoint

The final full-suite run passed **1,747 tests across 167 TypeScript test files**. After the executable-permissions fix, the native bundle suite passed all five tests, including a real seven-target fixture tarball. Rust workspace tests passed: core 45, capability filesystem 13, TUI units 230, filesystem RPC 6, handoff XML 11, PTY smoke 1.

The final focused regression group passed **53 tests**, including real-helper edit-save, symlink denial, conflicts, SSE refresh, raw-preview CSP, partial writes and mocked Codex image transport. No live inference was run.

The last full compiler check returned **47 diagnostics across 18 files**. None were in the scoped native-integration files. Remaining issues include test/mock typing, pi extension import/rootDir configuration and `src/ui/hooks/useSubmitPanelSize.ts`'s nullable-ref return type. A passing test suite is not a passing typecheck.

`pnpm build` passed (TypeScript/client plus the host release binary); bundle verification passed 18 tests; `pnpm docs:build` built 25 pages. A real packed-layout smoke passed 14 API checks, including reads/writes, stale hashes, CSP, literal percent paths, symlink/traversal denial and missing-helper denial while tracked diffs/comments remain available. This exposed and fixed pnpm stripping executable bits: `publishConfig.executableFiles` now declares the seven native paths. No fixture chmod workaround was used.

The built UI rendered the saved synthetic file and persisted comment. It also reproduced the deferred legacy untracked-reader gap: an outside-symlink sentinel appeared in the untracked diff despite the protected file API denying it. UI preferences can override the CLI untracked setting, and legacy untracked newline handling can add a blank line. Full browser inline-edit workflow verification was stopped at the owner's request; do not claim it passed. Cross-platform runtime verification remains deferred.

## Original acceptance criteria

“Deferred” means work remains; it does not mean an existing feature is absent. “Partial” means only the implemented subset above is covered.

| ID | Status | Remaining contract / implemented evidence |
| --- | --- | --- |
| A01 | Complete | Bootstrap/API auth boundaries and same-origin credential attachment are tested. |
| A02 | Partial | Capability core and selected callers are tested; finish all repository readers/writers and cross-platform coverage. |
| A03 | Deferred | Resolve exact old/new snapshot sides for every supported scope. |
| A04 | Partial | Edit/suggestion hash checks and read-only scope restrictions exist; require current evidence for every mutation. |
| A05 | Complete | Runtime validation, line/range rules, request/content limits and HTTP errors for code comments/replies. |
| A06 | Complete | Escaped attributes, CDATA termination, invalid Unicode and instruction-text serialization in TS/Rust handoffs. |
| A07 | Partial | Native errors and reported post-write metadata failures are explicit; eliminate silent legacy Git/storage/parse failures. |
| A08 | Deferred | Distinguish repository, worktree, session, review and snapshot identities. |
| A09 | Deferred | Prove concurrent sessions cannot replace scope or lose review state. |
| A10 | Deferred | Transactional persistence, revision checks and idempotent mutation IDs. |
| A11 | Deferred | Lossless legacy-state migration with explicit ambiguity. |
| A12 | Deferred | Durable rounds, decisions, cursors/history and replay parity. |
| A13 | Deferred | Invalidate review evidence on changes; preserve original anchor context. |
| A14 | Deferred | Shared operation catalog, schemas, capabilities, OpenAPI and generated references. |
| A15 | Deferred | Intentional parity across REST, CLI, MCP and supported TUI operations. |
| A16 | Deferred | Asset-independent headless startup and honest bounded inspection metadata. |
| A17 | Deferred | Shared success/error/stale/unavailable/retry contract fixtures. |
| A18 | Partial | Change totals are corrected; scope, freshness and reviewed-state clarity remain. |
| A19 | Deferred | Browser keyboard/focus/conflict/accessibility E2E coverage. |
| A20 | Deferred | Ordering and rename/repeated-path/binary/submodule/quoted/Unicode/CRLF edge cases. |
| A21 | Deferred | Full human-to-agent-to-human re-review workflow coverage. |
| A22 | Deferred | Stable navigation, annotation batches and inspected/skipped/unavailable coverage. |
| A23 | Deferred | Explicit operation authority, provenance and resume/context-budget semantics. |
| A24 | Deferred | PR publication revalidation, dry-run and ambiguous-outcome reconciliation. |
| A25 | Deferred | Central secret/egress policy across review content and AI context. |
| A26 | Deferred | Versioned performance fixtures and enforced memory/latency/output/concurrency budgets. |
| A27 | Deferred | Measured Git/index/refresh optimization and watcher recovery. |
| A28 | Deferred | Verified standalone-patch/direct-file inputs. |
| A29 | Deferred by owner | Worktree/stack, notebook/structured-file, Jujutsu and narrow extensions are future work, not shipped additions. |
| A30 | Partial | Suites pass at the checkpoint; fix compiler failures and make all quality checks required CI gates. |
| A31 | Partial | Native disconnect/protocol/hash/path fixtures exist; expand concurrency, restart, disk-failure and parser cases. |
| A32 | Deferred | Verify packaging/install/provenance on the full supported platform matrix. |
| A33 | Partial | Implemented-slice references are reconciled here; future contracts and generated catalog checks remain. |
| A34 | Partial | Lead verification and final PR handoff cover this slice, not every deferred criterion. |

## Next-agent work, in order

1. **Finish containment and report incomplete results honestly (A02/A07/A16/A22).** Start at `src/lib/git.ts`'s untracked-file and EditorConfig readers. Use capability-read bytes, NUL-delimited Git paths and in-memory config parsing bounded to the repo. Preserve tracked review when optional reads are unavailable, without representing omitted files as complete. `src/lib/diff-engine.ts` and `/api/diff` rebuild metadata; `resolveAgentPatch` in `src/server.ts` discards it; `src/lib/agent-diff-index.ts` hard-codes `complete: true` and caches by patch only; MCP `get_diff` in `src/mcp.ts` rebuilds its output; `src/ui/hooks/useDiff.ts` selects fields. Carry availability through all of them. Check helper-unavailable, denied symlink, literal percent/quoted/newline path, cache-generation and CLI/MCP/UI agreement cases.
2. **Audit remaining access and launch boundaries (A02/A23/A32).** Trace Git stage/revert, `/api/open-file`, `src/lib/editor-launcher.ts`, `src/lib/search.ts` and `@ff-labs/fff-node`, plus remaining Rust callers. Distinguish capability-owned operations from trusted external programs. Prove outside sentinels remain untouched and run the supported OS matrix.
3. **Snapshot-correct reads and guarded mutations (A03/A04/A07/A13).** Start at `resolveFileVersion` in `src/server.ts`, `getFileContent`/revert helpers in `src/lib/git.ts`, and suggestion/edit routes. Test staged-vs-working content, revisions, renames, repeated commit paths, stale hashes and no-write/no-comment-change on rejection. Do not call optimistic checks transactional CAS.
4. **Durable isolated state (A08–A13/A31).** Review `src/lib/comments.ts`, `review-session.ts`, `pr-session.ts`, `session-manager.ts` and atomic JSON helpers. Design migration and transactional storage before changing formats. Test two processes, restarts, replay, disk failures and preserved originals.
5. **Headless contract and human workflow (A14–A22/A28).** Reconcile `src/mcp.ts`, `src/cli-agent.ts`, server routes, TUI APIs and UI consumers. Add shared contract fixtures and actual browser inspect/comment/handoff/reply/edit/re-review tests. Do not overload pagination truncation to mean source completeness.
6. **Publishing and egress (A23–A25).** Trace PR publication and `src/lib/ai/` context/adapters. Require reviewed identity/head, explicit authority and idempotent reconciliation. Test dry-run, head changes and ambiguous network outcomes using mocks; never publish or run paid inference without authorization.
7. **Quality and performance (A26/A27/A30–A33).** Begin with `pnpm exec tsc --noEmit`; fix its 47 known diagnostics without weakening compiler settings or assertions. Add required CI gates, platform packaging checks and measured large-diff/output/memory/watcher fixtures. Reconcile docs against the resulting code and mechanically check the operation catalog.
8. **Expansion (A29).** Keep the owner-approved deferral until a separate scoped proposal is accepted; do not imply notebook/Jujutsu/extension additions shipped with this slice.
