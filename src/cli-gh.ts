import { parseArgs } from 'node:util'
import { resolveActiveServerLock } from './lib/server-lock.js'
import { SESSION_TOKEN_HEADER } from './lib/server-auth.js'
import { formatComments } from './lib/comment-format.js'
import type { ReviewComment } from './lib/types.js'
import type { PrSession } from './lib/pr-session.js'
import type { PrOverviewPayload } from './lib/pr-agent-format.js'

/**
 * `diffing gh …` — the headless / port-agnostic surface for the PR review
 * mode. Mirrors the shape of the local review CLI: each subcommand resolves
 * the running server from the per-repo lockfile and talks to it via
 * localhost HTTP. No port ever leaves the lockfile.
 *
 *   diffing gh status                   → slim one-line summary (overview)
 *   diffing gh overview [--json]        → compact PR metadata (no patch/threads)
 *   diffing gh threads […]             → paged published threads (xml|json)
 *   diffing gh reviews […]             → paged submitted reviews (xml|json)
 *   diffing gh pr-fetch <ref>           → refresh / init PR session
 *   diffing gh pr-review                → POST /api/gh/submit (authorized mutation)
 *   diffing gh pr-list-comments         → local draft comments as XML
 */

const EXIT_OK = 0
const EXIT_NO_SERVER = 3
const EXIT_NOT_FOUND = 4
const EXIT_USAGE = 5

let activeAuthToken: string | undefined

function baseUrl(): string {
  const lock = resolveActiveServerLock()
  if (!lock) {
    console.error('No diffing server running for this repo. Start one with `diffing "gh pr <ref>"`.')
    process.exit(EXIT_NO_SERVER)
  }
  const host = lock.host === '0.0.0.0' || lock.host === '::' ? '127.0.0.1' : lock.host
  activeAuthToken = lock.authToken
  return `http://${host}:${lock.port}`
}

function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (activeAuthToken) headers.set(SESSION_TOKEN_HEADER, activeAuthToken)
  return fetch(input, { ...init, headers })
}

async function fetchJson<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const res = await apiFetch(`${baseUrl()}${path}`)
  if (res.status === 404) {
    return { ok: false, status: 404, error: 'No active PR session. Start one with `diffing "gh pr <ref>"`.' }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    return { ok: false, status: res.status, error: (err as any).error ?? res.statusText }
  }
  return { ok: true, data: (await res.json()) as T }
}

async function ghOverview(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { json: { type: 'boolean' } },
    allowPositionals: false,
  })
  const result = await fetchJson<PrOverviewPayload & { prMode?: boolean }>('/api/gh/overview')
  if (!result.ok) {
    console.error(result.error)
    return result.status === 404 ? EXIT_NOT_FOUND : 1
  }
  const s = result.data
  if (values.json) {
    process.stdout.write(JSON.stringify(s, null, 2) + '\n')
    return EXIT_OK
  }
  const submittedLine = s.submittedAt
    ? `submitted at ${new Date(s.submittedAt).toISOString()} → ${s.submittedReviewUrl ?? '(no url)'}`
    : 'not submitted yet'
  console.log(`${s.owner}/${s.repo}#${s.pullNumber}  ${s.title}`)
  console.log(`  url:        ${s.url}`)
  console.log(`  author:     ${s.author?.login ?? '(unknown)'}`)
  console.log(`  +${s.additions} -${s.deletions}  (${s.changedFiles} files)  patchBytes=${s.patchBytes}`)
  console.log(`  head:       ${s.headSha.slice(0, 7)}${s.headRefName ? ` (${s.headRefName})` : ''}`)
  console.log(`  base:       ${s.baseSha.slice(0, 7)}${s.baseRefName ? ` (${s.baseRefName})` : ''}`)
  console.log(
    `  threads:    ${s.counts.publishedThreads} published (${s.counts.unresolvedThreads} unresolved, ${s.counts.outdatedThreads} outdated)`,
  )
  console.log(`  reviews:    ${s.counts.reviews} submitted review events`)
  console.log(`  drafts:     ${s.counts.localDrafts} local (${s.counts.openDrafts} open)`)
  console.log(`  status:     ${submittedLine}`)
  return EXIT_OK
}

async function ghStatus(): Promise<number> {
  // Prefer slim overview; fall back to fat session for older servers.
  const overview = await apiFetch(`${baseUrl()}/api/gh/overview`)
  if (overview.ok) {
    const session = (await overview.json()) as PrOverviewPayload
    const submitted = session.submittedAt
      ? `submitted ${new Date(session.submittedAt).toISOString()}`
      : 'not submitted'
    console.log(
      `PR #${session.pullNumber} ${session.owner}/${session.repo} ` +
      `[${session.headSha.slice(0, 7)}] — ${session.counts.localDrafts} local draft(s), ` +
      `${session.counts.unresolvedThreads} unresolved thread(s) — ${submitted}`,
    )
    return EXIT_OK
  }
  const res = await apiFetch(`${baseUrl()}/api/gh/session`)
  if (res.status === 404) {
    console.error('No active PR session. Start one with `diffing "gh pr <ref>"`.')
    return EXIT_NOT_FOUND
  }
  const s = (await res.json()) as PrSession & { prMode: boolean }
  if (!s.prMode) {
    console.error('No active PR session. Start one with `diffing "gh pr <ref>"`.')
    return EXIT_NOT_FOUND
  }
  const submittedLine = s.submittedAt
    ? `submitted at ${new Date(s.submittedAt).toISOString()} → ${s.submittedReviewUrl ?? '(no url)'}`
    : 'not submitted yet'
  console.log(`${s.owner}/${s.repo}#${s.pullNumber}  ${s.title}`)
  console.log(`  url:        ${s.url}`)
  console.log(`  author:     ${s.author?.login ?? '(unknown)'}`)
  console.log(`  +${s.additions} -${s.deletions}  (${s.changedFiles} files)`)
  console.log(`  head:       ${s.headSha.slice(0, 7)}${s.headRefName ? ` (${s.headRefName})` : ''}`)
  console.log(`  base:       ${s.baseSha.slice(0, 7)}${s.baseRefName ? ` (${s.baseRefName})` : ''}`)
  console.log(`  threads:    ${s.existingComments?.length ?? 0} published conversations`)
  console.log(`  reviews:    ${s.existingReviews?.length ?? 0} submitted review events`)
  console.log(`  new:        ${s.comments?.length ?? 0} comments in this session`)
  console.log(`  status:     ${submittedLine}`)
  return EXIT_OK
}

async function ghThreads(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      unresolved: { type: 'boolean' },
      path: { type: 'string' },
      author: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'string' },
      'reply-cursor': { type: 'string' },
      'reply-limit': { type: 'string' },
      format: { type: 'string' },
      'full-body': { type: 'boolean' },
      'body-max': { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  const params = new URLSearchParams()
  if (values.unresolved) params.set('unresolvedOnly', 'true')
  if (values.path) params.set('path', values.path)
  if (values.author) params.set('author', values.author)
  if (values.cursor) params.set('cursor', values.cursor)
  if (values.limit) params.set('limit', values.limit)
  if (values['reply-cursor']) params.set('replyCursor', values['reply-cursor'])
  if (values['reply-limit']) params.set('replyLimit', values['reply-limit'])
  if (values['full-body']) params.set('fullBody', 'true')
  if (values['body-max']) params.set('bodyMaxChars', values['body-max'])
  const format = values.json ? 'json' : (values.format ?? 'xml')
  if (format !== 'xml' && format !== 'json') {
    console.error('diffing gh threads: --format must be xml or json')
    return EXIT_USAGE
  }
  params.set('format', format)

  const res = await apiFetch(`${baseUrl()}/api/gh/threads?${params}`)
  if (res.status === 404) {
    console.error('No active PR session.')
    return EXIT_NOT_FOUND
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error((err as any).error ?? res.statusText)
    return 1
  }
  if (format === 'xml') {
    process.stdout.write((await res.text()) + '\n')
  } else {
    const body = await res.json()
    process.stdout.write(JSON.stringify(body, null, values.json ? 2 : undefined) + '\n')
  }
  return EXIT_OK
}

async function ghReviews(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      cursor: { type: 'string' },
      limit: { type: 'string' },
      format: { type: 'string' },
      state: { type: 'string' },
      'full-body': { type: 'boolean' },
      'body-max': { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  const params = new URLSearchParams()
  if (values.cursor) params.set('cursor', values.cursor)
  if (values.limit) params.set('limit', values.limit)
  if (values.state) params.set('state', values.state)
  if (values['full-body']) params.set('fullBody', 'true')
  if (values['body-max']) params.set('bodyMaxChars', values['body-max'])
  const format = values.json ? 'json' : (values.format ?? 'xml')
  if (format !== 'xml' && format !== 'json') {
    console.error('diffing gh reviews: --format must be xml or json')
    return EXIT_USAGE
  }
  params.set('format', format)

  const res = await apiFetch(`${baseUrl()}/api/gh/reviews?${params}`)
  if (res.status === 404) {
    console.error('No active PR session.')
    return EXIT_NOT_FOUND
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error((err as any).error ?? res.statusText)
    return 1
  }
  if (format === 'xml') {
    process.stdout.write((await res.text()) + '\n')
  } else {
    const body = await res.json()
    process.stdout.write(JSON.stringify(body, null, values.json ? 2 : undefined) + '\n')
  }
  return EXIT_OK
}

async function ghPrFetch(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  const ref = positionals[0]
  if (!ref) {
    console.error('Usage: diffing gh pr-fetch <ref> [--json]')
    return EXIT_USAGE
  }
  const base = baseUrl()
  // Prefer refresh so in-progress draft comments are preserved. Fall back to
  // init only when no session is active (refresh 404s).
  let res = await apiFetch(`${base}/api/gh/pr/refresh`, { method: 'POST' })
  if (res.status === 404) {
    res = await apiFetch(`${base}/api/gh/pr/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
    })
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error(`Failed to fetch PR: ${(err as any).error ?? res.statusText}`)
    return 1
  }
  // Prefer slim overview after refresh to avoid dumping full session JSON.
  const overviewRes = await apiFetch(`${base}/api/gh/overview`)
  if (overviewRes.ok) {
    const result = (await overviewRes.json()) as Record<string, unknown>
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    } else {
      console.log(`${result.owner}/${result.repo}#${result.pullNumber}  ${result.url}`)
    }
    return EXIT_OK
  }
  const sessionRes = await apiFetch(`${base}/api/gh/session`)
  const result = sessionRes.ok
    ? ((await sessionRes.json()) as Record<string, unknown>)
    : ((await res.json()) as Record<string, unknown>)
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    console.log(`${result.owner}/${result.repo}#${result.pullNumber}  ${result.url}`)
  }
  return EXIT_OK
}

async function ghPrListComments(): Promise<number> {
  const base = baseUrl()
  const res = await apiFetch(`${base}/api/gh/pr-session/comments`)
  if (res.status === 404) {
    console.error('No active PR session.')
    return EXIT_NOT_FOUND
  }
  const comments = (await res.json()) as ReviewComment[]
  // Re-use the local review XML format so the output is consistent across modes.
  process.stdout.write(formatComments(comments) + '\n')
  return EXIT_OK
}

async function ghPrReview(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      decision: { type: 'string', short: 'd' },
      body: { type: 'string', short: 'b' },
      'dry-run': { type: 'boolean' },
      'pending-id': { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  const decision = values.decision
  if (
    decision !== 'approve' &&
    decision !== 'comment' &&
    decision !== 'request-changes' &&
    decision !== 'draft'
  ) {
    console.error(
      'Usage: diffing gh pr-review --decision <approve|comment|request-changes|draft> [--body <text>] [--dry-run]',
    )
    return EXIT_USAGE
  }
  const base = baseUrl()
  const pendingId = values['pending-id'] ? Number(values['pending-id']) : undefined
  const payload = {
    decision,
    body: values.body ?? '',
    dryRun: values['dry-run'] === true,
    pendingReviewId: Number.isFinite(pendingId) ? pendingId : undefined,
  }
  const res = await apiFetch(`${base}/api/gh/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error(`Failed to submit review: ${(err as any).error ?? res.statusText}`)
    return 1
  }
  const result = (await res.json()) as {
    ok: boolean
    reviewId?: number
    reviewUrl?: string
    authSource: 'gh' | 'token' | 'none'
    error?: string
    dryRun?: boolean
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else if (result.ok) {
    if (result.dryRun) {
      console.log('Dry run OK — payload would have been accepted by GitHub.')
    } else {
      console.log(`Review submitted via ${result.authSource}: ${result.reviewUrl ?? `#${result.reviewId}`}`)
    }
  } else {
    console.error(`Submit failed (auth=${result.authSource}): ${result.error ?? 'unknown error'}`)
    return 1
  }
  return EXIT_OK
}

async function ghPending(args: string[]): Promise<number> {
  const action = args[0]
  const rest = args.slice(1)
  const { values } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      event: { type: 'string' },
      body: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  const id = Number(values.id)
  if (!Number.isFinite(id)) {
    console.error('Usage: diffing gh pending <submit|discard|resume> --id <review-id> [--event APPROVE|REQUEST_CHANGES|COMMENT]')
    return EXIT_USAGE
  }
  const base = baseUrl()
  if (action === 'discard') {
    const res = await apiFetch(`${base}/api/gh/reviews/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      console.error((err as any).error ?? res.statusText)
      return 1
    }
    console.log(`Discarded pending review #${id}`)
    return EXIT_OK
  }
  if (action === 'resume') {
    const res = await apiFetch(`${base}/api/gh/reviews/${id}/comments`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      console.error((err as any).error ?? res.statusText)
      return 1
    }
    const body = await res.json()
    if (values.json) process.stdout.write(JSON.stringify(body, null, 2) + '\n')
    else console.log(`Attached ${(body as any).attached ?? 0} draft comment(s) to pending review #${id}`)
    return EXIT_OK
  }
  if (action !== 'submit') {
    console.error('Usage: diffing gh pending <submit|discard|resume> --id <review-id>')
    return EXIT_USAGE
  }
  const event = values.event
  if (event !== 'APPROVE' && event !== 'REQUEST_CHANGES' && event !== 'COMMENT') {
    console.error('diffing gh pending submit: --event must be APPROVE, REQUEST_CHANGES, or COMMENT')
    return EXIT_USAGE
  }
  const res = await apiFetch(`${base}/api/gh/reviews/${id}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, body: values.body }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error((err as any).error ?? res.statusText)
    return 1
  }
  const body = await res.json()
  if (values.json) process.stdout.write(JSON.stringify(body, null, 2) + '\n')
  else console.log(`Submitted pending review #${id} as ${event}`)
  return EXIT_OK
}

async function ghPrUpdate(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      title: { type: 'string' },
      body: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: false,
  })
  if (values.title == null && values.body == null) {
    console.error('Usage: diffing gh pr-update [--title T] [--body B] [--dry-run]')
    return EXIT_USAGE
  }
  const res = await apiFetch(`${baseUrl()}/api/gh/pr`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: values.title,
      body: values.body,
      dryRun: values['dry-run'] === true,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error((err as any).error ?? res.statusText)
    return 1
  }
  console.log(values['dry-run'] ? 'Dry run OK' : 'Pull request updated')
  return EXIT_OK
}

async function ghPrState(path: string, label: string, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { 'dry-run': { type: 'boolean' } },
    allowPositionals: false,
  })
  const res = await apiFetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: values['dry-run'] === true }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error((err as any).error ?? res.statusText)
    return 1
  }
  console.log(values['dry-run'] ? `Dry run OK (${label})` : label)
  return EXIT_OK
}

async function ghPrMerge(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      method: { type: 'string' },
      'expected-head': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: false,
  })
  const method = values.method ?? 'merge'
  if (method !== 'merge' && method !== 'squash' && method !== 'rebase') {
    console.error('diffing gh pr-merge: --method must be merge, squash, or rebase')
    return EXIT_USAGE
  }
  const res = await apiFetch(`${baseUrl()}/api/gh/pr/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method,
      expectedHeadSha: values['expected-head'],
      dryRun: values['dry-run'] === true,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error((err as any).error ?? res.statusText)
    return 1
  }
  console.log(values['dry-run'] ? 'Dry run OK' : `Merged via ${method}`)
  return EXIT_OK
}

async function ghTimeline(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      cursor: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  const params = new URLSearchParams()
  if (values.cursor) params.set('cursor', values.cursor)
  if (values.limit) params.set('limit', values.limit)
  const res = await apiFetch(`${baseUrl()}/api/gh/timeline?${params}`)
  if (res.status === 404) {
    console.error('No active PR session.')
    return EXIT_NOT_FOUND
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error((err as any).error ?? res.statusText)
    return 1
  }
  process.stdout.write(JSON.stringify(await res.json(), null, values.json ? 2 : undefined) + '\n')
  return EXIT_OK
}

export async function runGhSubcommand(args: string[]): Promise<number> {
  const action = args[0]
  const rest = args.slice(1)
  switch (action) {
    case 'status':
      return ghStatus()
    case 'overview':
      return ghOverview(rest)
    case 'threads':
      return ghThreads(rest)
    case 'reviews':
      return ghReviews(rest)
    case 'timeline':
      return ghTimeline(rest)
    case 'pending':
      return ghPending(rest)
    case 'pr-fetch':
      return ghPrFetch(rest)
    case 'pr-review':
      return ghPrReview(rest)
    case 'pr-list-comments':
      return ghPrListComments()
    case 'pr-update':
      return ghPrUpdate(rest)
    case 'pr-close':
      return ghPrState('/api/gh/pr/close', 'Pull request closed', rest)
    case 'pr-reopen':
      return ghPrState('/api/gh/pr/reopen', 'Pull request reopened', rest)
    case 'pr-merge':
      return ghPrMerge(rest)
    default:
      console.error(
        'Usage: diffing gh <status|overview|threads|reviews|timeline|pending|pr-fetch|pr-review|pr-list-comments|pr-update|pr-close|pr-reopen|pr-merge> [...]',
      )
      return EXIT_USAGE
  }
}
