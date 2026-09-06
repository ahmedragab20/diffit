// @vitest-environment node
import { describe, it, expect } from 'vitest'
import type { PrSession } from '../pr-session.js'
import {
  buildPrOverviewPayload,
  paginatePrThreads,
  paginatePrReviews,
  formatPrReviewThreads,
} from '../pr-agent-format.js'

function sampleSession(): PrSession {
  return {
    ref: '1234',
    owner: 'acme',
    repo: 'widget',
    pullNumber: 1234,
    headSha: 'abc123def456',
    baseSha: 'base000',
    title: 'Add the widget',
    url: 'https://github.com/acme/widget/pull/1234',
    author: { login: 'octocat' },
    additions: 10,
    deletions: 2,
    changedFiles: 2,
    diff: 'diff --git a/a.ts b/a.ts\n',
    comments: [
      {
        id: 'draft-1',
        filePath: 'a.ts',
        side: 'additions',
        lineNumber: 1,
        lineContent: 'x',
        body: 'draft',
        status: 'open',
        createdAt: 1,
        replies: [],
      },
    ],
    existingComments: [
      {
        id: 1,
        author: { login: 'alice' },
        body: 'Please fix the race condition in the handler.',
        path: 'src/server.ts',
        line: 42,
        side: 'RIGHT',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        state: 'CHANGES_REQUESTED',
        replies: [
          {
            id: 2,
            author: { login: 'bob' },
            body: 'Agreed — also add a test.',
            createdAt: '2026-01-01T01:00:00.000Z',
            updatedAt: '2026-01-01T01:00:00.000Z',
          },
        ],
        isOutdated: false,
        threadId: 'PRRT_1',
        isResolved: false,
      },
      {
        id: 3,
        author: { login: 'carol' },
        body: 'nit: naming',
        path: 'src/ui.tsx',
        line: 10,
        side: 'RIGHT',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        state: 'COMMENTED',
        replies: [],
        isOutdated: false,
        threadId: 'PRRT_2',
        isResolved: true,
      },
    ],
    existingReviews: [
      {
        id: 99,
        author: { login: 'alice' },
        body: 'Needs work on concurrency.',
        state: 'CHANGES_REQUESTED',
        submittedAt: '2026-01-01T00:05:00.000Z',
        htmlUrl: 'https://github.com/acme/widget/pull/1234#pullrequestreview-99',
      },
    ],
  }
}

describe('buildPrOverviewPayload', () => {
  it('counts unresolved threads and drafts without embedding bodies', () => {
    const ov = buildPrOverviewPayload(sampleSession())
    expect(ov.prMode).toBe(true)
    expect(ov.counts.publishedThreads).toBe(2)
    expect(ov.counts.unresolvedThreads).toBe(1)
    expect(ov.counts.resolvedThreads).toBe(1)
    expect(ov.counts.reviews).toBe(1)
    expect(ov.counts.pendingReviews).toBe(0)
    expect(ov.hasBody).toBe(false)
    expect(ov.counts.localDrafts).toBe(1)
    expect(ov.counts.openDrafts).toBe(1)
    expect(ov.patchBytes).toBeGreaterThan(0)
    expect(JSON.stringify(ov)).not.toContain('race condition')
  })
})

describe('paginatePrThreads', () => {
  it('filters unresolved and truncates bodies', () => {
    const page = paginatePrThreads(sampleSession(), {
      unresolvedOnly: true,
      bodyMaxChars: 20,
    })
    expect(page.total).toBe(1)
    expect(page.threads[0].id).toBe(1)
    expect(page.threads[0].bodyTruncated).toBe(true)
    expect(page.threads[0].body.endsWith('…')).toBe(true)
    expect(page.threads[0].replyCount).toBe(1)
    expect(page.threads[0].repliesReturned).toBe(1)
    expect(page.headSha).toBe('abc123def456')
  })

  it('paginates replies so a giant thread cannot dump every reply', () => {
    const session = sampleSession()
    session.existingComments[0].replies = Array.from({ length: 5 }, (_, i) => ({
      id: 100 + i,
      author: { login: 'bob' },
      body: `reply ${i}`,
      createdAt: '2026-01-01T01:00:00.000Z',
      updatedAt: '2026-01-01T01:00:00.000Z',
    }))
    const page = paginatePrThreads(session, { replyLimit: 2, replyCursor: 2 })
    expect(page.threads[0].replyCount).toBe(5)
    expect(page.threads[0].repliesReturned).toBe(2)
    expect(page.threads[0].replies[0].id).toBe(102)
    expect(page.threads[0].repliesNextCursor).toBe(4)
  })

  it('requires fullBody to bypass a zero body budget', () => {
    const truncated = paginatePrThreads(sampleSession(), { bodyMaxChars: 0 })
    expect(truncated.threads[0].body).toBe('…')
    expect(truncated.threads[0].bodyTruncated).toBe(true)
    const full = paginatePrThreads(sampleSession(), { bodyMaxChars: 0, fullBody: true })
    expect(full.threads[0].body).toContain('race condition')
  })

  it('filters by path', () => {
    const page = paginatePrThreads(sampleSession(), { path: 'ui.tsx' })
    expect(page.total).toBe(1)
    expect(page.threads[0].path).toBe('src/ui.tsx')
  })
})

describe('paginatePrReviews + XML', () => {
  it('pages reviews', () => {
    const page = paginatePrReviews(sampleSession(), { limit: 10 })
    expect(page.total).toBe(1)
    expect(page.reviews[0].state).toBe('CHANGES_REQUESTED')
  })

  it('emits stable agent XML', () => {
    const session = sampleSession()
    const page = paginatePrThreads(session, { unresolvedOnly: true, fullBody: true })
    const reviews = paginatePrReviews(session, { fullBody: true }).reviews
    const xml = formatPrReviewThreads(session, page.threads, reviews, page)
    expect(xml).toContain('<pr-review-threads pr="acme/widget#1234"')
    expect(xml).toContain('returned="1" total="1"')
    expect(xml).toContain('resolved="false"')
    expect(xml).toContain('race condition')
    expect(xml).toContain('<review id="99" state="CHANGES_REQUESTED"')
  })

  it('keeps CDATA terminators from breaking XML', () => {
    const session = sampleSession()
    session.existingComments[0].body = 'before ]]> after'
    const page = paginatePrThreads(session, { fullBody: true })
    const xml = formatPrReviewThreads(session, page.threads, undefined, page)
    expect(xml).toContain('before ]]]]><![CDATA[> after')
    expect(xml.match(/]]>/g)?.length).toBeGreaterThan(0)
  })
})
