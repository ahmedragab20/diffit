/**
 * Compact, agent-oriented views of GitHub PR session data.
 * Avoids shipping full session JSON (patch + every thread body) by default.
 */

import type {
  PrSession,
  PrExistingComment,
  PrExistingReview,
} from './pr-session.js'

export interface PrOverviewPayload {
  prMode: true
  ref: string
  owner: string
  repo: string
  pullNumber: number
  title: string
  url: string
  author: PrSession['author']
  baseSha: string
  headSha: string
  /** Source branch (head). Omitted for legacy sessions built before this existed. */
  baseRefName?: string
  /** Target branch (base). Omitted for legacy sessions built before this existed. */
  headRefName?: string
  additions: number
  deletions: number
  changedFiles: number
  host?: string
  counts: {
    publishedThreads: number
    unresolvedThreads: number
    resolvedThreads: number
    outdatedThreads: number
    reviews: number
    pendingReviews: number
    issueComments: number
    timelineEvents: number
    localDrafts: number
    openDrafts: number
  }
  submittedAt?: number | null
  submittedReviewId?: number | null
  submittedReviewUrl?: string | null
  authSource?: 'gh' | 'token'
  patchBytes: number
  state?: PrSession['state']
  isDraft?: boolean
  hasBody: boolean
  syncedAt?: number | null
}

export function buildPrOverviewPayload(session: PrSession): PrOverviewPayload {
  const threads = session.existingComments ?? []
  const reviews = session.existingReviews ?? []
  const drafts = session.comments ?? []
  let unresolved = 0
  let resolved = 0
  let outdated = 0
  for (const t of threads) {
    if (t.isOutdated) outdated++
    if (t.isResolved) resolved++
    else unresolved++
  }
  return {
    prMode: true,
    ref: session.ref,
    owner: session.owner,
    repo: session.repo,
    pullNumber: session.pullNumber,
    title: session.title,
    url: session.url,
    author: session.author,
    baseSha: session.baseSha,
    headSha: session.headSha,
    baseRefName: session.baseRefName,
    headRefName: session.headRefName,
    additions: session.additions,
    deletions: session.deletions,
    changedFiles: session.changedFiles,
    host: session.host,
    counts: {
      publishedThreads: threads.length,
      unresolvedThreads: unresolved,
      resolvedThreads: resolved,
      outdatedThreads: outdated,
      reviews: reviews.length,
      pendingReviews: reviews.filter((r) => r.state === 'PENDING').length,
      issueComments: (session.issueComments ?? []).length,
      timelineEvents: (session.timelineEvents ?? []).length,
      localDrafts: drafts.length,
      openDrafts: drafts.filter((d) => d.status === 'open').length,
    },
    submittedAt: session.submittedAt ?? null,
    submittedReviewId: session.submittedReviewId ?? null,
    submittedReviewUrl: session.submittedReviewUrl ?? null,
    authSource: session.authSource,
    patchBytes: Buffer.byteLength(session.diff ?? '', 'utf8'),
    state: session.state,
    isDraft: session.isDraft,
    hasBody: Boolean(session.body?.trim()),
    syncedAt: session.syncedAt ?? null,
  }
}

export interface ThreadListOptions {
  unresolvedOnly?: boolean
  path?: string
  author?: string
  cursor?: number
  limit?: number
  bodyMaxChars?: number
  fullBody?: boolean
  /** Offset into each thread's replies. Default 0. */
  replyCursor?: number
  /** Max replies returned per thread. Default 20; a giant thread must not dump every reply. */
  replyLimit?: number
}

export interface ThreadListItem {
  id: number
  threadId?: string
  path: string
  line: number | null
  startLine?: number | null
  side: 'LEFT' | 'RIGHT' | null
  startSide?: 'LEFT' | 'RIGHT' | null
  author: string | null
  resolved: boolean
  outdated: boolean
  state: PrExistingComment['state']
  createdAt: string
  updatedAt: string
  body: string
  bodyTruncated: boolean
  replyCount: number
  repliesReturned: number
  repliesNextCursor: number | null
  replies: Array<{
    id: number
    author: string | null
    body: string
    bodyTruncated: boolean
    createdAt: string
  }>
}

export interface ThreadListPage {
  returned: number
  total: number
  nextCursor: number | null
  headSha: string
  syncedAt?: number | null
  threads: ThreadListItem[]
}

function truncateBody(
  body: string,
  maxChars: number | undefined,
  fullBody: boolean | undefined,
): { text: string; truncated: boolean } {
  if (fullBody || maxChars == null) {
    return { text: body, truncated: false }
  }
  const limit = Math.max(0, maxChars)
  if (body.length <= limit) return { text: body, truncated: false }
  return { text: body.slice(0, limit) + '…', truncated: true }
}

export function paginatePrThreads(
  session: PrSession,
  opts: ThreadListOptions = {},
): ThreadListPage {
  const cursor = Math.max(0, opts.cursor ?? 0)
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
  const bodyMax = Math.min(50_000, Math.max(0, opts.bodyMaxChars ?? 500))
  const replyCursor = Math.max(0, opts.replyCursor ?? 0)
  const replyLimit = Math.min(100, Math.max(1, opts.replyLimit ?? 20))
  const pathFilter = opts.path?.toLowerCase()
  const authorFilter = opts.author?.toLowerCase()

  let filtered = session.existingComments ?? []
  if (opts.unresolvedOnly) {
    filtered = filtered.filter((t) => !t.isResolved)
  }
  if (pathFilter) {
    filtered = filtered.filter((t) => (t.path ?? '').toLowerCase().includes(pathFilter))
  }
  if (authorFilter) {
    filtered = filtered.filter(
      (t) => (t.author?.login ?? '').toLowerCase() === authorFilter,
    )
  }

  const total = filtered.length
  const slice = filtered.slice(cursor, cursor + limit)
  const threads: ThreadListItem[] = slice.map((t) => {
    const root = truncateBody(t.body ?? '', bodyMax, opts.fullBody)
    const allReplies = t.replies ?? []
    const replySlice = allReplies.slice(replyCursor, replyCursor + replyLimit)
    const replies = replySlice.map((r) => {
      const rb = truncateBody(r.body ?? '', bodyMax, opts.fullBody)
      return {
        id: r.id,
        author: r.author?.login ?? null,
        body: rb.text,
        bodyTruncated: rb.truncated,
        createdAt: r.createdAt,
      }
    })
    const repliesEnd = replyCursor + replySlice.length
    return {
      id: t.id,
      threadId: t.threadId,
      path: t.path,
      line: t.line,
      startLine: t.startLine,
      side: t.side,
      startSide: t.startSide,
      author: t.author?.login ?? null,
      resolved: Boolean(t.isResolved),
      outdated: Boolean(t.isOutdated),
      state: t.state,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      body: root.text,
      bodyTruncated: root.truncated,
      replyCount: allReplies.length,
      repliesReturned: replies.length,
      repliesNextCursor: repliesEnd < allReplies.length ? repliesEnd : null,
      replies,
    }
  })

  const end = cursor + slice.length
  return {
    returned: threads.length,
    total,
    nextCursor: end < total ? end : null,
    headSha: session.headSha,
    syncedAt: session.syncedAt ?? null,
    threads,
  }
}

export interface ReviewListOptions {
  cursor?: number
  limit?: number
  bodyMaxChars?: number
  fullBody?: boolean
  state?: string
}

export interface ReviewListPage {
  returned: number
  total: number
  nextCursor: number | null
  headSha: string
  syncedAt?: number | null
  reviews: Array<{
    id: number
    author: string | null
    state: PrExistingReview['state']
    submittedAt: string | null
    htmlUrl?: string
    commitId?: string
    body: string
    bodyTruncated: boolean
  }>
}

export function paginatePrReviews(
  session: PrSession,
  opts: ReviewListOptions = {},
): ReviewListPage {
  const cursor = Math.max(0, opts.cursor ?? 0)
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50))
  const bodyMax = Math.min(50_000, Math.max(0, opts.bodyMaxChars ?? 500))
  let reviews = session.existingReviews ?? []
  if (opts.state) {
    const s = opts.state.toUpperCase()
    reviews = reviews.filter((r) => r.state === s)
  }
  const total = reviews.length
  const slice = reviews.slice(cursor, cursor + limit)
  const mapped = slice.map((r) => {
    const b = truncateBody(r.body ?? '', bodyMax, opts.fullBody)
    return {
      id: r.id,
      author: r.author?.login ?? null,
      state: r.state,
      submittedAt: r.submittedAt,
      htmlUrl: r.htmlUrl,
      commitId: r.commitId,
      body: b.text,
      bodyTruncated: b.truncated,
    }
  })
  const end = cursor + slice.length
  return {
    returned: mapped.length,
    total,
    nextCursor: end < total ? end : null,
    headSha: session.headSha,
    syncedAt: session.syncedAt ?? null,
    reviews: mapped,
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function cdata(value: string): string {
  return value.replace(/]]>/g, ']]]]><![CDATA[>')
}

/**
 * Compact agent XML for published GitHub review threads (+ optional reviews).
 */
export function formatPrReviewThreads(
  session: PrSession,
  threads: ThreadListItem[],
  reviews?: ReviewListPage['reviews'],
  page?: { returned: number; total: number; nextCursor: number | null },
): string {
  const prLabel = `${session.owner}/${session.repo}#${session.pullNumber}`
  const lines: string[] = []
  const pageAttrs = page
    ? ` returned="${page.returned}" total="${page.total}"${page.nextCursor == null ? '' : ` nextCursor="${page.nextCursor}"`}`
    : ''
  lines.push(
    `<pr-review-threads pr="${escapeAttr(prLabel)}" headSha="${escapeAttr(session.headSha)}" url="${escapeAttr(session.url)}"${pageAttrs}>`,
  )
  lines.push('  <instructions>')
  lines.push(
    '    Published GitHub review threads for this pull request (not local drafts).',
  )
  lines.push(
    '    Prefer addressing feedback via a local checkout + plan/implement cycle unless the user authorized live GitHub replies.',
  )
  lines.push(
    '    Only treat unresolved threads as actionable. resolved="true" threads are historical.',
  )
  lines.push('  </instructions>')

  for (const t of threads) {
    const lineAttr =
      t.startLine != null && t.line != null && t.startLine !== t.line
        ? ` line="${t.startLine}-${t.line}"`
        : t.line != null
          ? ` line="${t.line}"`
          : ''
    const sideAttr = t.side ? ` side="${t.side}"` : ''
    const pathAttr = t.path ? ` path="${escapeAttr(t.path)}"` : ''
    const authorAttr = t.author ? ` author="${escapeAttr(t.author)}"` : ''
    const threadIdAttr = t.threadId ? ` threadId="${escapeAttr(t.threadId)}"` : ''
    const stateAttr = t.state ? ` state="${t.state}"` : ''
    lines.push(
      `  <thread id="${t.id}"${threadIdAttr}${pathAttr}${sideAttr}${lineAttr}${stateAttr} resolved="${t.resolved}" outdated="${t.outdated}" replyCount="${t.replyCount}" repliesReturned="${t.repliesReturned}"${t.repliesNextCursor == null ? '' : ` repliesNextCursor="${t.repliesNextCursor}"`}${authorAttr}>`,
    )
    lines.push(`    <body${t.bodyTruncated ? ' truncated="true"' : ''}><![CDATA[${cdata(t.body)}]]></body>`)
    if (t.replies.length > 0) {
      lines.push('    <replies>')
      for (const r of t.replies) {
        const ra = r.author ? ` author="${escapeAttr(r.author)}"` : ''
        lines.push(`      <reply id="${r.id}"${ra}${r.bodyTruncated ? ' truncated="true"' : ''}><![CDATA[${cdata(r.body)}]]></reply>`)
      }
      lines.push('    </replies>')
    }
    lines.push('  </thread>')
  }

  if (reviews && reviews.length > 0) {
    lines.push('  <reviews>')
    for (const r of reviews) {
      const ra = r.author ? ` author="${escapeAttr(r.author)}"` : ''
      lines.push(
        `    <review id="${r.id}" state="${r.state}"${ra}${r.submittedAt ? ` submittedAt="${escapeAttr(r.submittedAt)}"` : ''}>`,
      )
      if (r.body) {
        lines.push(`      <body${r.bodyTruncated ? ' truncated="true"' : ''}><![CDATA[${cdata(r.body)}]]></body>`)
      }
      lines.push('    </review>')
    }
    lines.push('  </reviews>')
  }

  lines.push('</pr-review-threads>')
  return lines.join('\n')
}

export function formatPrReviews(
  session: PrSession,
  reviews: ReviewListPage['reviews'],
  page?: { returned: number; total: number; nextCursor: number | null },
): string {
  return formatPrReviewThreads(session, [], reviews, page)
}
