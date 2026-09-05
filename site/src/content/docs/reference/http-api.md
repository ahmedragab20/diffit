---
title: HTTP API
description: Loopback REST and SSE endpoints used by the UI, CLI, and agents.
summary: Review await/send, comments CRUD, plans, mockups, AI assistant, progress, live SSE, search, and attachments on the local server.
order: 3
section: reference
---

Use the session base URL from `diffing url`. CLI and MCP clients target loopback sessions. Authenticate with the session cookie (browser) or `x-diffing-token` header.

## Authentication and browser boundaries

Loopback binds reject non-loopback `Host` headers on HTML and API routes. Any supplied `Origin` must match the request origin; mismatches return `403`. Responses set `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.

Loopback browsers can still bootstrap from the review page. When authentication is enabled on a non-loopback bind, HTML and deep links also require the session header or cookie; unauthenticated requests return `401` without disclosing the credential in their body or cookies. The browser fetch wrapper attaches its token only to same-origin `/api/` requests and preserves existing request headers.

`--insecure-no-auth` explicitly disables authentication, including on loopback. The CLI requires it for wildcard binds (`0.0.0.0`/`::`). It does not disable Host/Origin checks. Prefer loopback; there is no automatic authenticated LAN login flow.

## Handoff

| Method | Path | Role |
|--------|------|------|
| `POST` | `/api/review/send` | Human releases waiters; increments round |
| `GET` | `/api/review/await` | Long-poll (`sinceRound`, `timeoutMs` ≤ 50000) |
| `GET` | `/api/review/status` | Round / waiters snapshot |
| `GET` | `/api/review/history` | In-memory round history; resets on server restart |

### send body

```json
{ "generalComment": "Optional markdown summary" }
```

### await response (released)

```json
{
  "status": "released",
  "payload": {
    "round": 4,
    "sentAt": 1782782782782,
    "commentXml": "<code-review-comments>…</code-review-comments>",
    "openCount": 0,
    "comments": [],
    "mode": "standard"
  }
}
```

## Bounded diff inspect

| Method | Path | Role |
|--------|------|------|
| `GET` | `/api/diff/summary?exclude` | Totals, kind counts, top-level directories. `exclude=lockfiles` drops lock/generated basenames from counts only |
| `GET` | `/api/diff/files?path&cursor&limit` | Paged file metadata. `path` is a git pathspec-ish glob; `nextCursor` indexes the filtered list |
| `GET` | `/api/diff/hunks?file\|path&cursor&limit&generation` | Hunk metadata. `path` XOR `file`; 0 matches → 404, many → 409 |
| `GET` | `/api/diff/slice?file\|path&start&maxLines&maxBytes&generation` | Bounded logical rows |
| `GET` | `/api/diff/search?q&path&file&row&limit&maxBytes&generation` | Literal search; optional `path` limits files |

## Comments

| Method | Path | Role |
|--------|------|------|
| `GET` | `/api/comments` | List threads |
| `POST` | `/api/comments` | Create (filePath, side, lineNumber, body, optional startLineNumber, severity) |
| `PUT` | `/api/comments/:id` | Edit body or `{ status }` |
| `DELETE` | `/api/comments/:id` | Delete |
| `POST` | `/api/comments/resolve-all` | Resolve all open |
| `POST` | `/api/comments/:id/replies` | Reply |
| `PUT` | `/api/comments/:id/replies/:replyId` | Edit reply |
| `DELETE` | `/api/comments/:id/replies/:replyId` | Delete reply |
| `POST` | `/api/comments/:id/apply-suggestion` | Apply suggestion fence |

### Comment validation

Creates require a nonempty string `filePath` (at most 4096 UTF-16 code units, no NUL), `side: "additions" | "deletions"`, nonnegative integer `lineNumber`, and nonblank string `body`. `lineNumber: 0` is file-level. Optional `startLineNumber` must be positive, no greater than `lineNumber`, and absent for file-level comments. Missing `lineContent` defaults to `""`; supplied context must be a string. Optional severity is `blocking`, `nit`, `question`, `praise`, or `none`.

Body limit: 65,536 UTF-16 code units. Context limit: 262,144. Requests under `/api/comments` and its child routes are limited to 1,048,576 bytes. Invalid fields or malformed JSON return `400`; oversized requests return `413`. Rejected requests leave the comment store unchanged.

Comment updates require a valid `body` or `status: "open" | "resolved"`. Reply creation and editing require a nonblank body within the same limit. Replies accept optional `role: "user" | "agent"` and a nonempty string `model` of at most 256 UTF-16 code units. Without an explicit role, a model implies `agent`; otherwise the role is `user`.

## Agent progress

| Method | Path |
|--------|------|
| `POST` | `/api/agent/progress` |
| `GET` | `/api/agent/progress` |

```json
{ "message": "Working…", "model": "…", "pct": 40 }
```

## Live SSE

`GET /api/live` — events: `heartbeat`, `change`, `comments`, `plans`, `mockups`, `agent-status`, `plan-review-status`, `mockup-review-status`.

## Search

`POST /api/search` — `{ scope, query, limit, regex, changedPaths? }`  
`POST /api/search/track` — frecency update

## Attachments

`POST /api/attachments` (multipart) · `GET /api/attachments/:filename`  
Stored under per-repo `attachments/`. Image-only for AI/composer use (PNG, JPEG, WebP, GIF; ≤ 10 MB).

## AI assistance

Loopback-only review assistant used by the web UI. Inference requires `trigger: "user"` — clients must not call `/api/ai/run` from lifecycle, hover, selection, refresh, or navigation events.

| Method | Path | Role |
|--------|------|------|
| `GET` | `/api/ai/connections` | Connection status for Codex, Claude, OpenCode, Cursor, Grok |
| `GET` | `/api/ai/models` | Models from connected sources |
| `POST` | `/api/ai/connections/:source/key` | Store direct API key (`apiKey`, optional `remember`) |
| `POST` | `/api/ai/connections/:source/login` | Return CLI setup command (`route`: `subscription` \| …) |
| `POST` | `/api/ai/connections/:source/configure-runtime-key` | Return runtime BYOK setup command |
| `DELETE` | `/api/ai/connections/:source` | Disconnect / clear stored key |
| `GET` | `/api/ai/conversations?surface&scopeKey` | List conversation summaries |
| `POST` | `/api/ai/conversations` | Create (`surface`, `scopeKey`, optional `title` / `modelId`) |
| `GET` / `PUT` / `DELETE` | `/api/ai/conversations/:id` | Read / update (title, draft, modelId, turns) / delete |
| `POST` | `/api/ai/run` | Start inference; streams SSE events (`start`, `text-delta`, `warning`, `error`, `complete`) |
| `POST` | `/api/ai/runs/:id/cancel` | Cancel an in-flight run |

### `/api/ai/run` body (required fields)

```json
{
  "trigger": "user",
  "conversationId": "…",
  "modelId": "…",
  "surface": "diff",
  "action": "ask",
  "prompt": "optional",
  "context": { "kind": "diff", "patch": "…" }
}
```

`surface` is `diff` | `pr-diff` | `plan`. Context attachments: ≤ 8 `@` files / 64 KB; ≤ 8 line ranges / 64 KB; ≤ 4 images. Conversations live in per-repo `ai-conversations.json`.

## Plans

Plan CRUD and comments live under `/api/plans…` (list, get, versions, submit, comments, review status). Prefer CLI/MCP for agents; use HTTP when embedding or debugging.

## Mockups

Comment scope = **version + screen + viewport** (`desktop|tablet|mobile`); `viewport` is part of every posted comment and every inspect filter. Prefer CLI/MCP for agents; use HTTP when embedding or debugging.

| Method | Path | Role |
|--------|------|------|
| `GET` | `/api/mockups[?include=comments\|full]` | Compact summaries by default; `include=comments` adds threads (single-op lookup helpers); `include=full` returns raw records (compatibility) |
| `POST` | `/api/mockups` | Submit (`html` or `screens[]`; `id` resubmits → version++) |
| `GET` | `/api/mockups/:id` | One mockup (screens + comments) |
| `PUT` / `DELETE` | `/api/mockups/:id` | Update / delete |
| `GET` | `/api/mockups/:id/versions` · `/versions/:n` | Version metadata / historical body |
| `GET` | `/api/mockups/:id/inspect?view&status&screen&viewport&version&id&cursor&limit&context` | Bounded reads — `view=summary\|comments\|comment\|screen`, `context=none\|anchor\|source` (default `anchor`), bodies truncate at 400 chars, `nextCursor` pagination |
| `GET` | `/api/mockups/:id/screens/:screenId/document?version&viewport` | Served screen (injected probe; nonce echoed back on comment posts) |
| `PUT` | `/api/mockups/:id/screens/:screenId` | One-screen upsert (`html`, optional `label`, `expectedVersion`) |
| `PATCH` | `/api/mockups/:id/screens/:screenId` | Exact-text patch (`expectedText`, `replacement`) or region replace (`region`, `replacement`); `expectedVersion` optional; 0 matches → 409 `exact-text-not-found` / `region-not-found` |
| `DELETE` | `/api/mockups/:id/screens/:screenId[?expectedVersion]` | One-screen remove (refuses last screen) |
| `POST` | `/api/mockups/:id/threads/batch` | **Atomic** thread batch `{ operations: [{ op: reply\|edit\|delete\|resolve\|unresolve, commentId, replyId?, body?, role?, model? }] }` — all validated before any applies; thread ops never bump the version |
| `POST` | `/api/mockups/:id/comments` | Create comment (`kind`, `screenId`, `body`, `viewport`, anchor fields, optional `nonce`) |
| `PUT` / `DELETE` | `/api/mockups/:id/comments/:commentId` | Edit body/status / delete |
| `POST` / `PUT` / `DELETE` | `/api/mockups/:id/comments/:commentId/replies[/:replyId]` | Reply / edit / delete reply |
| `POST` | `/api/mockups/:id/decision` | Submit review (`decision`, optional `decisionComment`, `mode`, focused `screen`/`viewport`); releases waiters |
| `GET` | `/api/mockup-review/await` · `/status` | Long-poll verdict / round snapshot |

Screen ops return the updated mockup; `expectedVersion` mismatch aborts with **409** (`version-mismatch`, nothing applied). Verdicts release waiters via `GET /api/mockup-review/await` and `GET /api/mockup-review/status`.

## Other

| Path | Role |
|------|------|
| `POST /api/open-file` | Launch editor (vscode/zed/vim/neovim/default) |
| Git/IDE helpers | Diff options, settings persistence, etc. |

Deep endpoint catalog remains in repository `docs/cli.md` §11 for rare routes.

## Related

- [AI assistance](/docs/guides/ai-assistance/)
- [Comments XML](/docs/reference/comments-xml/)
- [Architecture](/docs/concepts/architecture/)
