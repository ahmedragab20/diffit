import { describe, expect, it } from 'vitest'
import {
  buildPrTimeline,
  mergeBlockedReason,
  paginatePrTimeline,
  timelineEventFromGh,
} from '../pr-timeline.js'
import type { PrSession } from '../pr-session.js'

function session(partial: Partial<PrSession> = {}): PrSession {
  return {
    ref: '1',
    owner: 'acme',
    repo: 'widget',
    pullNumber: 1,
    headSha: 'head',
    baseSha: 'base',
    title: 'T',
    url: 'https://github.com/acme/widget/pull/1',
    author: { login: 'octocat' },
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    diff: '',
    comments: [],
    existingComments: [],
    body: 'Fixes the widget.',
    createdAt: '2026-01-01T00:00:00.000Z',
    issueComments: [
      {
        id: 9,
        author: { login: 'alice' },
        body: 'Looks close.',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    existingReviews: [
      {
        id: 3,
        author: { login: 'bob' },
        body: 'Please tweak.',
        state: 'CHANGES_REQUESTED',
        submittedAt: '2026-01-03T00:00:00.000Z',
      },
    ],
    timelineEvents: [
      {
        id: 'event:1',
        event: 'labeled',
        createdAt: '2026-01-01T12:00:00.000Z',
        actor: { login: 'octocat' },
        label: 'bug',
      },
    ],
    ...partial,
  }
}

describe('pr-timeline', () => {
  it('pins the description first and paginates the rest', () => {
    const items = buildPrTimeline(session())
    expect(items[0]?.kind).toBe('pr-description')
    expect(items.map((item) => item.kind)).toContain('issue-comment')
    expect(items.map((item) => item.kind)).toContain('review')
    const page = paginatePrTimeline(session(), { limit: 2 })
    expect(page.returned).toBe(2)
    expect(page.total).toBe(4)
    expect(page.nextCursor).toBe(2)
  })

  it('keeps labeled events and drops review-comment noise', () => {
    expect(timelineEventFromGh({ id: 1, event: 'labeled', label: { name: 'bug' }, created_at: 't' })?.event).toBe(
      'labeled',
    )
    expect(timelineEventFromGh({ id: 2, event: 'commented' })).toBeNull()
  })

  it('blocks merge on draft, closed, dirty, and conflicting PRs', () => {
    expect(mergeBlockedReason({ isDraft: true })).toMatch(/draft/i)
    expect(mergeBlockedReason({ state: 'merged' })).toMatch(/already merged/)
    expect(mergeBlockedReason({ mergeStateStatus: 'dirty' })).toMatch(/conflicts/)
    expect(mergeBlockedReason({ mergeable: 'CONFLICTING' })).toMatch(/conflicts/)
    expect(mergeBlockedReason({ state: 'open', mergeable: 'MERGEABLE', mergeStateStatus: 'clean' })).toBeNull()
  })
})
