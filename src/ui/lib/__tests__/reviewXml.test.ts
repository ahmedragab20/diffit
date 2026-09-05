// Parser-based regression tests for the agent-handoff XML serializers
// (formatComments / formatPlanReview / formatMockupReview).
//
// These tests only verify XML SERIALIZATION: that the emitted string is
// well-formed XML whose parsed attributes and text round-trip to the fixture
// values, with no stray elements injected and exactly the real comment/reply
// nodes present. They make NO claim about how an LLM interprets the payload.
import { describe, it, expect } from 'vitest'
import { formatComments } from '../../../lib/comment-format.js'
import { formatPlanReview } from '../../../lib/plan-format.js'
import { formatMockupReview } from '../../../lib/mockup-format.js'
import type { ReviewComment } from '../../../lib/types.js'
import type { Plan, PlanComment } from '../../../lib/plan-types.js'
import type { Mockup, MockupComment } from '../../../lib/mockup-types.js'

/** Hostile free-text attribute payload: quotes, ampersand, markup, whitespace. */
const HOSTILE_ATTR = 'say "hi" & <injected/> \n\t tabbed'
/** Hostile CDATA/text payload: the classic CDATA-closer escape attempt. */
const HOSTILE_TEXT = 'before ]]> <injected/> after'

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const errors = Array.from(doc.getElementsByTagName('parsererror'))
  expect(
    errors,
    `serializer emitted malformed XML (parsererror: ${errors.map((e) => e.textContent?.trim()).join(' | ')})\n---\n${xml}`,
  ).toHaveLength(0)
  return doc
}

function tag(doc: Document, name: string): Element[] {
  return Array.from(doc.getElementsByTagName(name))
}

function firstTag(doc: Document, name: string): Element {
  const els = tag(doc, name)
  expect(els.length, `expected a <${name}> element`).toBeGreaterThan(0)
  return els[0]
}

/** CDATA body text must survive byte-for-byte (after deliberate trim only). */
function expectText(doc: Document, name: string, original: string, { trim = false, prefix = '' } = {}) {
  const el = firstTag(doc, name)
  const actual = el.textContent ?? ''
  const rest = trim ? actual.trim() : actual.slice(prefix.length)
  expect(rest).toBe(trim ? original.trim() : original)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseComment: ReviewComment = {
  id: 'c1',
  filePath: 'src/index.ts',
  side: 'additions',
  lineNumber: 10,
  lineContent: 'const x = 1',
  body: 'Consider renaming',
  status: 'open',
  createdAt: 1000,
  replies: [],
}

function planFixture(overrides: Partial<Plan> = {}, comments: PlanComment[] = []): Plan {
  const body = '# Title\n\nDo the thing'
  return {
    id: 'p1',
    title: 'My Plan',
    body,
    source: 'claude-code',
    model: 'opus',
    createdAt: 1000,
    updatedAt: 1000,
    version: 1,
    decision: 'changes-requested',
    comments,
    versions: [
      { version: 1, body, title: 'My Plan', source: 'claude-code', model: 'opus', createdAt: 1000 },
    ],
    ...overrides,
  }
}

function planCommentFixture(overrides: Partial<PlanComment> = {}): PlanComment {
  return {
    id: 'c1',
    lineNumber: 2,
    lineContent: 'Do the thing',
    sectionTitle: 'Title',
    body: 'Clarify this',
    status: 'open',
    createdAt: 3000,
    createdAtPlanVersion: 1,
    replies: [],
    ...overrides,
  }
}

function mockupFixture(overrides: Partial<Mockup> = {}, comments: MockupComment[] = []): Mockup {
  return {
    id: 'm1',
    title: 'Landing',
    screens: [{ id: 'main', label: 'Main', html: '<h1>Hi</h1>' }],
    createdAt: 0,
    updatedAt: 0,
    version: 2,
    decision: 'changes-requested',
    versions: [
      {
        version: 2,
        title: 'Landing',
        screens: [{ id: 'main', label: 'Main', html: '<h1>Hi</h1>' }],
        createdAt: 0,
      },
    ],
    comments,
    ...overrides,
  }
}

function mockupCommentFixture(overrides: Partial<MockupComment> = {}): MockupComment {
  return {
    id: 'c1',
    screenId: 'main',
    kind: 'section',
    target: 'hero',
    body: 'Hero copy is too long',
    status: 'open',
    createdAt: 0,
    createdAtMockupVersion: 2,
    replies: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// formatComments — code review handoff
// ---------------------------------------------------------------------------

describe('formatComments XML serialization', () => {
  it('normal representative output parses with zero parsererror nodes', () => {
    const xml = formatComments(
      [baseComment],
      'Prioritise the security fixes first',
      'changes-requested',
    )
    const doc = parseXml(xml)
    expect(doc.documentElement.tagName).toBe('code-review-comments')
    expect(tag(doc, 'comment')).toHaveLength(1)
  })

  it('free-text attributes round-trip through the parser (filePath, reply model)', () => {
    const xml = formatComments([
      {
        ...baseComment,
        filePath: `src/${HOSTILE_ATTR}.ts`,
        replies: [
          { id: 'r1', body: 'ok', createdAt: 3000, role: 'agent', model: HOSTILE_ATTR },
        ],
      },
    ])
    const doc = parseXml(xml)
    expect(firstTag(doc, 'file').getAttribute('path')).toBe(`src/${HOSTILE_ATTR}.ts`)
    expect(firstTag(doc, 'reply').getAttribute('model')).toBe(HOSTILE_ATTR)
  })

  it('CDATA bodies round-trip without element injection (body, reply, general, code)', () => {
    const xml = formatComments(
      [
        {
          ...baseComment,
          lineContent: HOSTILE_TEXT,
          body: HOSTILE_TEXT,
          replies: [{ id: 'r1', body: HOSTILE_TEXT, createdAt: 3000, role: 'agent', model: 'opus' }],
        },
      ],
      HOSTILE_TEXT,
      'changes-requested',
    )
    const doc = parseXml(xml)
    expect(tag(doc, 'injected')).toHaveLength(0)
    // exactly the real nodes — instruction examples must not become elements
    expect(tag(doc, 'comment')).toHaveLength(1)
    expect(tag(doc, 'reply')).toHaveLength(1)
    expect(tag(doc, 'comment-replies')).toHaveLength(0)
    expectText(doc, 'code', HOSTILE_TEXT, { prefix: '+ ' })
    expectText(doc, 'body', HOSTILE_TEXT)
    expectText(doc, 'general-comment', HOSTILE_TEXT, { trim: true })
    expectText(doc, 'reply', HOSTILE_TEXT)
  })
})

// ---------------------------------------------------------------------------
// formatPlanReview — plan review handoff
// ---------------------------------------------------------------------------

describe('formatPlanReview XML serialization', () => {
  it('normal representative output parses with zero parsererror nodes', () => {
    const xml = formatPlanReview(
      planFixture(
        { decisionComment: 'Wrong approach' },
        [planCommentFixture({ replies: [{ id: 'r1', body: 'Done', createdAt: 5000, role: 'agent', model: 'opus' }] })],
      ),
    )
    const doc = parseXml(xml)
    expect(doc.documentElement.tagName).toBe('plan-review')
    expect(tag(doc, 'comment')).toHaveLength(1)
    expect(tag(doc, 'reply')).toHaveLength(1)
  })

  it('free-text attributes round-trip through the parser (title, section, reply model)', () => {
    const xml = formatPlanReview(
      planFixture(
        { title: HOSTILE_ATTR },
        [
          planCommentFixture({
            sectionTitle: HOSTILE_ATTR,
            replies: [{ id: 'r1', body: 'ok', createdAt: 5000, role: 'agent', model: HOSTILE_ATTR }],
          }),
        ],
      ),
    )
    const doc = parseXml(xml)
    expect(firstTag(doc, 'plan').getAttribute('title')).toBe(HOSTILE_ATTR)
    expect(firstTag(doc, 'comment').getAttribute('section')).toBe(HOSTILE_ATTR)
    expect(firstTag(doc, 'reply').getAttribute('model')).toBe(HOSTILE_ATTR)
  })

  it('CDATA bodies round-trip without element injection (decision comment, body, reply, plan body)', () => {
    const hostileBody = HOSTILE_TEXT
    const xml = formatPlanReview(
      planFixture(
        {
          body: hostileBody,
          decisionComment: HOSTILE_TEXT,
          versions: [
            { version: 1, body: hostileBody, title: 'My Plan', createdAt: 1000 },
          ],
        },
        [
          planCommentFixture({
            body: HOSTILE_TEXT,
            replies: [{ id: 'r1', body: HOSTILE_TEXT, createdAt: 5000, role: 'agent', model: 'opus' }],
          }),
        ],
      ),
    )
    const doc = parseXml(xml)
    expect(tag(doc, 'injected')).toHaveLength(0)
    expect(tag(doc, 'comment')).toHaveLength(1)
    expect(tag(doc, 'reply')).toHaveLength(1)
    expectText(doc, 'plan-body', hostileBody)
    expectText(doc, 'decision-comment', HOSTILE_TEXT, { trim: true })
    expectText(doc, 'body', HOSTILE_TEXT)
    expectText(doc, 'reply', HOSTILE_TEXT)
  })
})

// ---------------------------------------------------------------------------
// formatMockupReview — mockup review handoff
// ---------------------------------------------------------------------------

describe('formatMockupReview XML serialization', () => {
  it('compact handoff parses with zero parsererror nodes', () => {
    const xml = formatMockupReview(
      mockupFixture({}, [
        mockupCommentFixture({ replies: [{ id: 'r1', body: 'Done', createdAt: 0, role: 'agent', model: 'opus' }] }),
      ]),
    )
    const doc = parseXml(xml)
    expect(doc.documentElement.tagName).toBe('mockup-review')
    expect(tag(doc, 'comment')).toHaveLength(1)
    expect(tag(doc, 'reply')).toHaveLength(1)
    expect(tag(doc, 'instructions')).toHaveLength(0)
  })

  it('instructions-enabled handoff parses with zero parsererror nodes', () => {
    const xml = formatMockupReview(mockupFixture(), { instructions: true })
    const doc = parseXml(xml)
    expect(doc.documentElement.tagName).toBe('mockup-review')
    expect(tag(doc, 'instructions')).toHaveLength(1)
  })

  it('free-text attributes round-trip through the parser (title, target, reply model)', () => {
    const xml = formatMockupReview(
      mockupFixture(
        { title: HOSTILE_ATTR },
        [
          mockupCommentFixture({
            target: HOSTILE_ATTR,
            replies: [{ id: 'r1', body: 'ok', createdAt: 0, role: 'agent', model: HOSTILE_ATTR }],
          }),
        ],
      ),
    )
    const doc = parseXml(xml)
    expect(firstTag(doc, 'mockup').getAttribute('title')).toBe(HOSTILE_ATTR)
    expect(firstTag(doc, 'comment').getAttribute('target')).toBe(HOSTILE_ATTR)
    expect(firstTag(doc, 'reply').getAttribute('model')).toBe(HOSTILE_ATTR)
  })

  it('CDATA bodies round-trip without element injection (decision comment, body, reply)', () => {
    const xml = formatMockupReview(
      mockupFixture(
        { decisionComment: HOSTILE_TEXT },
        [
          mockupCommentFixture({
            body: HOSTILE_TEXT,
            replies: [{ id: 'r1', body: HOSTILE_TEXT, createdAt: 0, role: 'agent', model: 'opus' }],
          }),
        ],
      ),
    )
    const doc = parseXml(xml)
    expect(tag(doc, 'injected')).toHaveLength(0)
    expect(tag(doc, 'comment')).toHaveLength(1)
    expect(tag(doc, 'reply')).toHaveLength(1)
    expectText(doc, 'decision-comment', HOSTILE_TEXT, { trim: true })
    expectText(doc, 'body', HOSTILE_TEXT)
    expectText(doc, 'reply', HOSTILE_TEXT)
  })
})
