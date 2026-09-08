// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  findOutlineSectionForLine,
  bucketCommentsByOutline,
  planCommentLineLabel,
  findReadModeAnchorElement,
  lastElementOfSection,
} from '../planCommentAnchors.js'
import type { PlanOutlineItem } from '../planOutline.js'
import type { PlanComment } from '../../../lib/plan-types.js'

const outline: PlanOutlineItem[] = [
  { level: 1, text: 'Title', id: 'title', line: 1 },
  { level: 2, text: 'Changes', id: 'changes', line: 5 },
  { level: 2, text: 'Risks', id: 'risks', line: 11 },
]

function c(partial: Partial<PlanComment> & { id: string; lineNumber: number }): PlanComment {
  return {
    id: partial.id,
    lineNumber: partial.lineNumber,
    startLineNumber: partial.startLineNumber,
    body: partial.body ?? 'x',
    status: partial.status ?? 'open',
    createdAt: 1,
    replies: [],
    sectionTitle: partial.sectionTitle,
    lineContent: partial.lineContent ?? '',
    createdAtPlanVersion: partial.createdAtPlanVersion ?? 1,
  } as PlanComment
}

describe('findOutlineSectionForLine', () => {
  it('returns the last heading at or before the line', () => {
    expect(findOutlineSectionForLine(outline, 6)?.id).toBe('changes')
    expect(findOutlineSectionForLine(outline, 5)?.id).toBe('changes')
    expect(findOutlineSectionForLine(outline, 12)?.id).toBe('risks')
    expect(findOutlineSectionForLine(outline, 1)?.id).toBe('title')
  })

  it('returns null for empty outline', () => {
    expect(findOutlineSectionForLine([], 3)).toBeNull()
  })
})

describe('bucketCommentsByOutline', () => {
  it('groups by section and skips general comments', () => {
    const buckets = bucketCommentsByOutline(outline, [
      c({ id: 'g', lineNumber: 0, body: 'general' }),
      c({ id: 'a', lineNumber: 6, body: 'on changes' }),
      c({ id: 'b', lineNumber: 12, body: 'on risks' }),
      c({ id: 'c', lineNumber: 3, body: 'under title' }),
    ])
    expect(buckets.has('preamble')).toBe(false)
    expect(buckets.get('changes')?.map((x) => x.id)).toEqual(['a'])
    expect(buckets.get('risks')?.map((x) => x.id)).toEqual(['b'])
    expect(buckets.get('title')?.map((x) => x.id)).toEqual(['c'])
  })

  it('puts lines before first heading in preamble', () => {
    const short: PlanOutlineItem[] = [{ level: 1, text: 'Later', id: 'later', line: 10 }]
    const buckets = bucketCommentsByOutline(short, [c({ id: 'p', lineNumber: 2 })])
    expect(buckets.get('preamble')?.map((x) => x.id)).toEqual(['p'])
  })
})

describe('planCommentLineLabel', () => {
  it('formats single, multi, and general', () => {
    expect(planCommentLineLabel({ lineNumber: 0 })).toBe('General')
    expect(planCommentLineLabel({ lineNumber: 6 })).toBe('L6')
    expect(planCommentLineLabel({ lineNumber: 9, startLineNumber: 6 })).toBe('L6–L9')
  })
})

describe('findReadModeAnchorElement', () => {
  it('anchors multi-line range after the last matching body block, not the heading alone', () => {
    document.body.innerHTML = `
      <div class="plan-rendered">
        <h1 id="title">Test Plan – Dumb Test</h1>
        <p>Just verifying the plan review loop works.</p>
        <h2 id="changes">Changes</h2>
        <ol><li>Add a hello endpoint</li></ol>
      </div>
    `
    const root = document.querySelector('.plan-rendered') as HTMLElement
    const outline: PlanOutlineItem[] = [
      { level: 1, text: 'Test Plan – Dumb Test', id: 'title', line: 1 },
      { level: 2, text: 'Changes', id: 'changes', line: 5 },
    ]
    const anchor = findReadModeAnchorElement(
      root,
      outline,
      { lineNumber: 3, startLineNumber: 1, lineContent: '# Test Plan – Dumb Test\n\nJust verifying the plan review loop works.' },
      '# Test Plan – Dumb Test\n\nJust verifying the plan review loop works.',
    )
    expect(anchor?.tagName).toBe('P')
    expect(anchor?.textContent).toMatch(/Just verifying/)
  })

  it('lastElementOfSection walks to the end of the section body', () => {
    document.body.innerHTML = `
      <div>
        <h2 id="changes">Changes</h2>
        <p>one</p>
        <p>two</p>
        <h2 id="risks">Risks</h2>
      </div>
    `
    const h = document.getElementById('changes')!
    expect(lastElementOfSection(h).textContent).toBe('two')
  })
})
