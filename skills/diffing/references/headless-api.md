# Headless API cookbook

Use registered MCP tools first, CLI second, HTTP for gaps or embedding. [Sessions and transports](sessions-and-transports.md) covers discovery and credentials. [Recovery and safety](recovery-and-safety.md) covers errors, limits and authority. This catalog describes the shipped server; it does not promise parity across modes.

## Authenticated JSON requests

The following is JavaScript for a **host integration**, not a new diffing tool. The host supplies a verified `sessionBaseUrl` and its credential in memory; never ask the agent to print a token or dump a lockfile. If that facility is unavailable, use CLI/MCP instead. This helper targets web/PR JSON endpoints, not TUI, raw bytes, multipart or SSE.

```js
function createDiffingApi(sessionBaseUrl, sessionToken) {
  const base = new URL(sessionBaseUrl);
  if (base.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
      base.username || base.password || base.search || base.hash) {
    throw new Error('Expected a verified loopback review URL');
  }
  if (typeof sessionToken !== 'string' || !sessionToken) {
    throw new Error('Host must provide the session credential');
  }
  return async function api(path, { method = 'GET', body } = {}) {
    const url = new URL(path, base.origin);
    if (url.origin !== base.origin || !url.pathname.startsWith('/api/') ||
        url.username || url.password || url.hash || url.searchParams.has('token')) {
      throw new Error('Refusing a different origin or non-API path');
    }
    const response = await fetch(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
      headers: {
        'x-diffing-token': sessionToken,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    return { ok: response.ok, status: response.status, data };
  };
}
// const api = createDiffingApi(hostSelectedUrl, hostHeldCredential);
```

Do not log credentials, follow redirects or automatically replay mutations. A fetch/JSON error after a write leaves its outcome uncertain. In the examples below, `api` is this bound helper; uppercase IDs and source strings are placeholders. URL-encode IDs and use `URLSearchParams` for query values.

## Complete MCP discovery map

Read the current input schema before a call. MCP returns `structuredContent` where provided; HTTP often returns the underlying record rather than the MCP wrapper. Workflow examples show typical arguments, not an SDK you must import.

| Area | Registered tools | CLI mirror or gap |
| --- | --- | --- |
| Session | `review_session_status`, `start_review_session` | `sessions`, `url`, local launch; list/select/stop are CLI-only |
| Diff | `get_diff`, `diff_summary`, `diff_files`, `diff_hunks`, `diff_slice`, `diff_search` | `inspect`; full-patch `get_diff` is an escape hatch, not TUI parity |
| Local comments | `create_comment`, `list_comments`, `reply_to_comment`, `resolve_comment`, `unresolve_comment`, `edit_comment`, `delete_comment` | `comments`, `reply`, `resolve`, `unresolve`, `comment edit/delete`; create via MCP/HTTP |
| Local extras | `edit_reply`, `delete_reply`, `apply_suggestion`, `resolve_all_comments` | MCP/HTTP; no corresponding local CLI action |
| Review loop | `await_review`, `get_review_history`, `report_progress` | `await-review`, `progress`; history via MCP/HTTP |
| Plans | `submit_plan`, `await_plan_review`, `list_plans`, `get_plan`, `get_plan_versions`, `get_plan_version`, `reply_to_plan_comment`, `resolve_plan_comment` | `plan submit/await/list/show/versions/reply/resolve` |
| Mockups | `submit_mockup`, `await_mockup_review`, `list_mockups`, `get_mockup`, `get_mockup_versions`, `get_mockup_version`, `inspect_mockup`, `revise_mockup`, `update_mockup_threads`, `get_mockup_handoff` | `mockup submit/await/list/show/versions/inspect/screen/threads/handoff` |
| Mockup threads | `reply_to_mockup_comment`, `resolve_mockup_comment`, `unresolve_mockup_comment`, `apply_mockup_suggestion` | `mockup reply/resolve/unresolve/apply-suggestion` |
| Design | `get_design_system`, `extract_design_system`, `propose_design_system`, `publish_design_system` | `design show/extract/propose/publish`; `design list` is CLI/HTTP |
| PR reads/drafts | `gh_overview`, `gh_list_threads`, `gh_list_reviews`, `gh_list_draft_comments`, `gh_create_draft_comment`, `gh_refresh` | `gh overview/threads/reviews/pr-list-comments/pr-fetch`; create draft via MCP/HTTP |
| AI evidence | `ai_evidence_list`, `ai_evidence_map`, `ai_evidence_read`, `ai_evidence_search`, `ai_evidence_symbols`, `ai_evidence_verify`, `ai_evidence_history`, `ai_evidence_discussion` | `diffing evidence list/map/read/search/symbols/verify/history/discussion`; read-only navigation of a retained capture |
| AI notebook | `ai_notebook`, `ai_notebook_add`, `ai_notebook_decide` | `diffing evidence notebook/decide`; authoring and deciding are writes, not `ai_evidence_*` |
| Authorized GitHub writes | `gh_submit_review`, `gh_submit_pending_review`, `gh_discard_pending_review`, `gh_update_pr`, `gh_set_pr_state`, `gh_merge_pr` | `gh pr-review`, `gh pending submit/discard`, `gh pr-update/pr-close/pr-reopen/pr-merge` |

MCP also advertises prompts `review_local_changes` and `submit_plan_for_review`, plus resource `diffing://agent-guide`. These help discovery; they do not replace schemas or grant authority. File editing/search, attachments, UI state, AI runs and published-comment CRUD have HTTP-only surfaces described below; AI evidence navigation is the one AI surface with registered MCP tools.

## Bounded diff inspection

| Method | Route | Input/result contract |
| --- | --- | --- |
| GET | `/api/diff/summary` | `exclude=lockfiles` optional; totals, `generation`, `complete`, optional `omittedPaths` |
| GET | `/api/diff/files` | `path`, `cursor`, `limit`; page via `nextCursor` |
| GET | `/api/diff/hunks` | `path` XOR `file`, `cursor`, `limit`, `generation`; page via `nextCursor` |
| GET | `/api/diff/slice` | `path` XOR `file`, `start`, `maxLines`, `maxBytes`, `generation`; page via `nextRow` |
| GET | `/api/diff/search` | `q`, optional `path`, `file`, `row`, `limit`, `maxBytes`, `generation`; continue both returned cursors |
| GET | `/api/diff` | Full patch and metadata; escape hatch, not the default read |

```js
const summary = await api('/api/diff/summary');
if (!summary.ok) throw new Error(`Summary failed: ${summary.status}`);
const query = new URLSearchParams({
  path: 'src/app.ts', start: '0', maxLines: '120',
  generation: String(summary.data.generation),
});
const slice = await api(`/api/diff/slice?${query}`);
```

A slice contains file/hunk headers and line rows; line rows provide `kind`, `oldLineno`, `newLineno`, `content` for anchoring. Use the exact file path and correct side for comments. File-list cursors index the filtered list, while each returned numeric `file` is global. Summary completeness is source coverage, not cursor exhaustion.

## Local comments and handoff

| Method | Route | Input/result contract |
| --- | --- | --- |
| GET | `/api/comments` | All stored comments; filter open status in the client (MCP `openOnly`, CLI `--open`) |
| POST | `/api/comments` | `{filePath, side, lineNumber, lineContent?, startLineNumber?, body, severity?}` |
| PUT | `/api/comments/:id` | `{body?}` and/or `{status:"open"}` / `{status:"resolved"}` |
| DELETE | `/api/comments/:id` | Delete one thread; explicit intent required |
| POST | `/api/comments/:id/replies` | `{body, role?, model?}`; set `role:"agent"` explicitly |
| PUT | `/api/comments/:id/replies/:replyId` | `{body}` |
| DELETE | `/api/comments/:id/replies/:replyId` | Delete one reply |
| POST | `/api/comments/:id/apply-suggestion` | Authorized working-tree write; resolves on success |
| POST | `/api/comments/resolve-all` | Bulk mutation; never a substitute for addressing feedback |
| GET | `/api/review/await` | `sinceRound?`, `timeoutMs?`; released payload or timeout |
| GET | `/api/review/status` | Round/waiter snapshot |
| GET | `/api/review/history` | `{rounds}`; in memory, reset on restart |
| GET | `/api/review/since-last` | Changes against last handoff's fingerprint baseline, if present |
| POST | `/api/review/send` | **Human handoff**, `{generalComment?, decision?, mode?}`; agents do not self-approve |

Example after inspecting an actual anchor and being asked to post findings:

```js
const created = await api('/api/comments', { method: 'POST', body: {
  filePath: 'src/app.ts', side: 'additions', lineNumber: 42,
  lineContent: 'const value = read();',
  body: 'Handle the missing value before dereferencing it.', severity: 'blocking',
}});
if (!created.ok) throw new Error(`Comment rejected: ${created.status}`);
```

`lineNumber: 0` is file-level, without `startLineNumber`. Ranges are inclusive. Use the [local validation limits](recovery-and-safety.md#validation-limits), not an assumed shared schema for all artifact types.

HTTP awaits use milliseconds, capped at 50,000 per request. MCP uses `timeoutSeconds`, CLI `--timeout` seconds. A released result includes payload/round and comments or review XML; consume it once. Human decision routes are listed for integration completeness, not as an agent approval shortcut. Do not bypass a secret warning with a force flag.

## Plans (local web)

| Method | Route | Input/result contract |
| --- | --- | --- |
| GET | `/api/plans` | Plan list |
| POST | `/api/plans` | `{title?, body, id?, source?, model?}`; same `id` creates the next version; returns plan |
| GET | `/api/plans/:id` | Current plan and comments |
| PUT | `/api/plans/:id` | `{title?, body?, source?, model?}`; same-version live edit, not a reviewed new submission |
| DELETE | `/api/plans/:id` | Destructive deletion |
| GET | `/api/plans/:id/versions` | Version metadata |
| GET | `/api/plans/:id/versions/:n` | Historical body/comments |
| POST | `/api/plans/:id/comments` | Plan anchor/body; not a code `filePath`/`side` payload |
| PUT | `/api/plans/:id/comments/:commentId` | Body/status update |
| DELETE | `/api/plans/:id/comments/:commentId` | Delete thread |
| POST | `/api/plans/:id/comments/:commentId/replies` | `{body, role?, model?}` |
| PUT | `/api/plans/:id/comments/:commentId/replies/:replyId` | `{body}` |
| DELETE | `/api/plans/:id/comments/:commentId/replies/:replyId` | Delete reply |
| POST | `/api/plans/:id/decision` | **Human verdict**, `{decision, decisionComment?, mode?}` |
| GET | `/api/plan-review/await` | `sinceRound?`, `timeoutMs?`; validate released `planId` |
| GET | `/api/plan-review/status` | Session-global review state |

```js
const submitted = await api('/api/plans', { method: 'POST', body: {
  title: 'Validate import inputs', body: '## Changes\n- Validate before saving.\n## Check\n- Run import tests.',
}});
// Revisions POST to the same collection with id: submitted.data.id.
// MCP submit_plan and get_plan both name the identifier planId.
```

Plan comment creation/edit/delete and reply edit/delete are HTTP-only; agents normally use MCP/CLI reply/resolve after a human comment. For creation, use `{lineNumber, body}` with optional `startLineNumber`, `lineContent`, `sectionTitle`, `selectedQuote`, `severity`, `createdAtPlanVersion`; do not substitute XML's `line` attribute for the HTTP field. Read the [plan workflow](../../diffing-plan-review/SKILL.md) before implementation.

## Mockups and design (local web)

| Method | Route | Input/result contract |
| --- | --- | --- |
| GET | `/api/mockups` | Compact summaries; `include=comments` or `include=full` only when needed |
| POST | `/api/mockups` | `{title?, html? or screens?, id?, source?, model?, mode?, designSystemId?, planId?}`; submission/version bump |
| GET | `/api/mockups/:id` | Full current record, including HTML |
| PUT | `/api/mockups/:id` | Same-record metadata/content update; prefer guarded screen revisions |
| DELETE | `/api/mockups/:id` | Delete artifact |
| GET | `/api/mockups/:id/versions` | Version metadata |
| GET | `/api/mockups/:id/versions/:n` | Historical record |
| GET | `/api/mockups/:id/inspect` | `view` (summary/comments/comment/screen/preview), `status`, `screen`, `viewport`, `version`, `id` (comment), `cursor`, `limit`, `context` (none/anchor/source) |
| GET | `/api/mockups/:id/screens/:screenId/document` | Served screen with review probe; `version`, `viewport` |
| PUT | `/api/mockups/:id/screens/:screenId` | `{html, label?, expectedVersion?}`; upsert/version bump |
| PATCH | `/api/mockups/:id/screens/:screenId` | `{expectedText, replacement, expectedVersion?}` or `{region, replacement, expectedVersion?}` |
| DELETE | `/api/mockups/:id/screens/:screenId` | Query `expectedVersion`; refuses removal of last screen |
| POST | `/api/mockups/:id/threads/batch` | `{operations:[{op, commentId, replyId?, body?, role?, model?}]}`; atomic validation/application, no version bump |
| POST | `/api/mockups/:id/comments` | `{kind, screenId, body, viewport, ...anchor}`; version/screen/viewport scoped |
| PUT | `/api/mockups/:id/comments/:commentId` | Body/status update |
| DELETE | `/api/mockups/:id/comments/:commentId` | Delete thread |
| POST | `/api/mockups/:id/comments/:commentId/replies` | `{body, role?, model?}` |
| PUT | `/api/mockups/:id/comments/:commentId/replies/:replyId` | `{body}` |
| DELETE | `/api/mockups/:id/comments/:commentId/replies/:replyId` | Delete reply |
| POST | `/api/mockups/:id/comments/:commentId/apply-suggestion` | `{expectedVersion?}`; revises screen, does not resolve thread |
| GET | `/api/mockups/:id/handoff` | Compact implementation handoff |
| POST | `/api/mockups/:id/decision` | **Human verdict**, not agent approval |
| GET | `/api/mockup-review/await` | `sinceRound?`, `timeoutMs?`; validate artifact ID/version |
| GET | `/api/mockup-review/status` | Session-global review state |

MCP `inspect_mockup` uses `screenId`/`commentId`; HTTP uses query `screen`/`id`. MCP and HTTP patch both use **`expectedText`**; CLI uses **`--text`**. Region replacement changes the inner HTML of the first matching `data-diffing` region. Inspect `occurrences` if a target is duplicated.

```js
const revised = await api('/api/mockups/MOCKUP_ID/screens/main', {
  method: 'PATCH', body: {
    region: 'empty', replacement: '<p>No imports yet.</p>', expectedVersion: 3,
  },
});
// Check revised.ok. A success already created a new version; do not resubmit it.
```

Thread batch `op` is `reply|edit|delete|resolve|unresolve`. Sequential CLI `threads` calls are not atomic. Section anchors use `target`; block anchors use selector/fingerprint/source; point anchors use viewport coordinates. Prefer scoped inspect to understand the anchor; never derive markup from a pin alone.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/design-systems` | List systems |
| GET | `/api/design-systems/default` | Default system, possibly draft |
| GET | `/api/design-systems/:id` | One system |
| POST | `/api/design-systems` | Create draft |
| PUT | `/api/design-systems/:id` | Propose draft fields (`title`, `guidelines`, `tokens`) |
| POST | `/api/design-systems/:id/extract` | `{from:"css", title?}`; scan consumer into draft |
| POST | `/api/design-systems/:id/publish` | Explicitly authorized publication of draft revision |
| POST | `/api/design-systems/:id/components` | Propose component snippet |
| POST | `/api/design-systems/:id/comments` | Design discussion |
| PUT | `/api/design-systems/:id/comments/:commentId` | Update discussion |

Only published design revisions wrap fragment mockups. Extraction/proposal is a mutation but not publication. UI Ask AI is a separate human-triggered feature, not part of submission/inspection.

## GitHub PR mode

Read identity with `gh_overview`; do not fetch the full UI session to learn the PR number. Local drafts are editable review artifacts. Pending reviews and published conversations belong to GitHub even when a route calls them drafts/pending.

| Method | Route | Purpose/authority |
| --- | --- | --- |
| GET | `/api/gh/overview` | Slim identity/counts |
| GET | `/api/gh/threads` | `unresolvedOnly`, `path`, `author`, `cursor`, `limit`, `replyCursor`, `replyLimit`, `bodyMaxChars`, `fullBody`, `format` |
| GET | `/api/gh/reviews` | `state`, `cursor`, `limit`, `bodyMaxChars`, `fullBody`, `format` |
| GET | `/api/gh/timeline` | `cursor`, `limit`; discussion/activity |
| GET | `/api/gh/checks` | CI check status; no `gh checks` CLI subcommand |
| GET | `/api/gh/session` | Full UI payload; escape hatch only |
| GET | `/api/gh/avatar` | UI avatar proxy using `url` |
| POST | `/api/gh/pr/init` | `{ref}`; changes session PR identity, confirm intent |
| POST | `/api/gh/pr/refresh` | Refresh current PR; verify identity first |
| GET | `/api/gh/pr-session/comments` | Local draft findings |
| POST | `/api/gh/pr-session/comments` | Draft anchor/body, same usual code-comment coordinates |
| PUT | `/api/gh/pr-session/comments/:id` | Local draft body/status |
| DELETE | `/api/gh/pr-session/comments/:id` | Delete local draft |
| POST | `/api/gh/pr-session/comments/:id/replies` | Local draft discussion |
| PUT | `/api/gh/pr-session/review-draft` | Local composer fields, not publication |
| POST | `/api/gh/submit` | `{decision, body?, dryRun?}`; authorize publication; dry-run first |
| POST | `/api/gh/reviews/:id/submit` | Submit remote pending review; `{event, body?, dryRun?}` |
| DELETE | `/api/gh/reviews/:id` | Discard remote pending review; authorize |
| POST | `/api/gh/reviews/:id/comments` | Attach local draft findings to a remote pending review; authorize |
| POST | `/api/gh/comments/sync` | Reconcile local optimistic/pending state |
| POST | `/api/gh/existing-comments/:id/replies` | `{body}`; remote reply, authorize |
| PATCH | `/api/gh/existing-comments/:id` | `{body}`; remote edit, authorize |
| DELETE | `/api/gh/existing-comments/:id` | Remote deletion, authorize |
| POST | `/api/gh/existing-comments/:id/apply-suggestion` | Authorized suggestion commit workflow, not a local draft edit |
| PUT | `/api/gh/review-threads/:threadId` | `{resolved}`; remote resolve/reopen, authorize |
| PATCH | `/api/gh/pr` | `{title?, body?, dryRun?}`; authorize metadata change |
| POST | `/api/gh/pr/close` | `{dryRun?}`; authorize state change |
| POST | `/api/gh/pr/reopen` | `{dryRun?}`; authorize state change |
| POST | `/api/gh/pr/merge` | `{method?, expectedHeadSha?, commitTitle?, commitMessage?, dryRun?}`; authorize merge separately |

There is no `/api/gh/pending` endpoint. `diffing gh pending submit/discard/resume --id REVIEW_ID` mutates an existing GitHub pending review through the review routes; it is not a read/list command. Published-comment reply/edit/delete and thread resolution have HTTP routes, not dedicated MCP tools. Preserve IDs and inspect outcomes after uncertain network failures; never blindly repeat a remote mutation.

## Files, search, images and UI-only operations

These HTTP surfaces have no general-purpose MCP/CLI mirror. Check authority before any write, staging, revert, editor launch or persistent preference change.

| Method | Route | Contract |
| --- | --- | --- |
| GET | `/api/file-text` | Required `path`, `version` (old/new); `{content, missing, hash?}`; binary text returns 415 |
| GET | `/api/file-content` | Same query; raw bytes with sandbox CSP, not JSON |
| POST | `/api/edit-predict` | `{path, excerptText, cursorOffsetInExcerpt, excerptStartLine}`; ghost-text suggestion from the configured AI model, confined to this file |
| POST | `/api/edit-save` | `{filePath, content, baseHash?, anchorUpdates?}`; optimistic guard, writable local scope only |
| POST | `/api/save-file` | `{filePath, content, gitAdd?}`; no hash guard; staging is separate authority |
| POST | `/api/open-file` | `{filePath, editor?}`; launches trusted external editor |
| GET | `/api/repo-files` | Repository file list |
| POST | `/api/search` | `{scope, query, limit?, regex?, changedPaths?}`; surrounding source, not just diff rows |
| GET | `/api/code-intel/capabilities` | `{configured, extensions, unavailable?}`; says whether this review can answer a lookup at all |
| POST | `/api/code-intel` | `{op, path, side, line, character, includeDeclaration?, newName?, endLine?, endCharacter?, tabSize?, insertSpaces?, staged?}`; hover, definition, references, rename, format, code-actions, signature, highlights over the working tree; refusals name their reason |
| POST | `/api/code-intel/document` | `{op: open\|change\|close, path, text?, version?}`; hands an open editor's draft to the language server; diagnostics return on `/api/live` |
| GET | `/api/search/status` | Search backend status |
| POST | `/api/search/track` | Search frecency update |
| GET | `/api/merge-status` | Merge/conflict state |
| POST | `/api/revert-hunk` | `{filePath, hunkIndex}`; destructive working-tree mutation |
| GET | `/api/hunk-history` | `filePath`, `deletionStart`, `deletionCount`; blame/history context |
| POST | `/api/attachments` | Multipart `file`; validated image upload, not JSON |
| GET | `/api/attachments/:filename` | Validated image bytes, not JSON |
| GET | `/api/settings` | Preferences |
| PUT | `/api/settings` | Persistent preferences; do not send secrets |
| GET | `/api/diff-options` | Current diff options |
| PUT | `/api/diff-options` | Change scope/options; invalidates earlier review assumptions |
| GET | `/api/ui-state` | UI state |
| PUT | `/api/ui-state` | UI state update |
| GET | `/api/viewed` | Viewed-file state |
| PUT | `/api/viewed` | Viewed-file state update; do not mark unreviewed files reviewed |
| GET | `/api/agent/progress` | Current progress |
| POST | `/api/agent/progress` | `{message, model?, pct?, commentId?, agentId?}`; human-visible status |
| POST | `/api/agent/register` | Waiter/agent registration |
| DELETE | `/api/agent/register/:id` | Agent registration removal |
| GET | `/api/live` | SSE, not JSON; events include change/comments/plans/mockups and status updates |

Authorized optimistic editing recipe (use a writable working-tree session, not a historical preview):

```js
const query = new URLSearchParams({ path: 'src/app.ts', version: 'new' });
const before = await api(`/api/file-text?${query}`);
if (!before.ok || before.data.missing || !before.data.hash) {
  throw new Error('No editable file snapshot');
}
// Produce nextText from before.data.content after inspecting the requested change.
const saved = await api('/api/edit-save', { method: 'POST', body: {
  filePath: 'src/app.ts', content: nextText, baseHash: before.data.hash,
}});
// Check status AND fileSaved/outcomeUnknown before resolving or retrying.
```

Do not bypass native path denial/helper failures. Read [file recovery](recovery-and-safety.md#file-reads-and-writes) before retrying a write.

## Opt-in AI integration (not an agent inference loop)

These routes support the human UI. Their presence does not authorize inference, uploading repository context to a provider, credential changes or conversation deletion. Never put actual credentials into cookbook examples. `trigger:"user"` is an input requirement, **not proof of human consent**. Submission/reply `model` fields merely record provenance.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/ai/connections` | Connection status |
| GET | `/api/ai/models` | Connected model choices |
| GET | `/api/ai/evidence` | Review snapshots a recent run retained; ids and revisions, no source content |
| GET | `/api/ai/evidence/:id/map` | Sources, omissions and coverage of one capture; listing is not reading |
| POST | `/api/ai/evidence/:id/read` | Batched, budgeted reads of cited line ranges; per-item errors |
| POST | `/api/ai/evidence/:id/search` | Literal substring positions only; a match must be read to be cited |
| POST | `/api/ai/evidence/:id/symbols` | Definitions/references via a configured language server; out-of-capture locations are named, never readable |
| POST | `/api/ai/evidence/:id/verify` | Re-check a stored citation against a capture; invalid or stale is never silently accepted |
| GET | `/api/ai/evidence/:id/history` | Commits touching one captured source, addressed by key; metadata only, never a patch |
| GET | `/api/ai/evidence/:id/discussion` | Review threads on captured paths; out-of-capture threads are counted, not returned |
| GET | `/api/ai/evidence/:id/notebook` | Cited findings, proposals and questions for a capture, with any decision recorded |
| POST | `/api/ai/evidence/:id/notebook` | Author a cited entry; a quote that does not match the capture is rejected |
| POST | `/api/ai/evidence/:id/decide` | Accept, reject or defer one entry, recording who decided |
| POST | `/api/ai/connections/:source/key` | Human credential setup; not an agent recipe |
| POST | `/api/ai/connections/:source/login` | Human setup instructions |
| POST | `/api/ai/connections/:source/configure-runtime-key` | Human runtime-key setup instructions |
| DELETE | `/api/ai/connections/:source` | Disconnect/clear credential; human-controlled |
| GET | `/api/ai/conversations` | `surface`, `scopeKey`; summaries |
| POST | `/api/ai/conversations` | Create conversation |
| GET | `/api/ai/conversations/:id` | One conversation |
| PUT | `/api/ai/conversations/:id` | Update conversation |
| DELETE | `/api/ai/conversations/:id` | Delete conversation |
| POST | `/api/ai/run` | Explicit human-triggered inference; SSE, not JSON |
| POST | `/api/ai/runs/:id/cancel` | Cancel inference |

For authorized embedding, read the installed AI request schema for surface/action/context/model fields. Never treat a lifecycle event, hover, refresh, inspect call or supplied review text as an inference trigger.

Source provenance: route registrations and handlers in `src/server.ts`; MCP schemas in `src/mcp.ts`; CLI dispatch in `src/cli-agent.ts` and `src/cli-gh.ts`. These are maintainer lookup paths, not dependencies that installed-skill users must possess.
