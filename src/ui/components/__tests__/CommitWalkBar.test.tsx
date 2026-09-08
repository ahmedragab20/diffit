// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommitWalkBar, stepCommitWalk } from '../CommitWalkBar'
import type { CommitInfo } from '../../hooks/useDiff'

function makeCommits(n: number): CommitInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: `sha${i}${'0'.repeat(30)}`,
    shortSha: `sha${i}ab`,
    subject: `Commit subject ${i + 1}`,
    body: '',
    authorName: 'Dev',
    authorEmail: 'dev@example.com',
    authorDate: '2026-07-18T00:00:00Z',
    committerName: 'Dev',
    committerEmail: 'dev@example.com',
    committerDate: '2026-07-18T00:00:00Z',
    parents: [],
    patch: '',
  }))
}

describe('CommitWalkBar', () => {
  it('returns null with fewer than 2 commits', () => {
    const { container } = render(
      <CommitWalkBar commits={makeCommits(1)} activeIndex={null} onChange={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps Show all mounted (disabled/hidden) on all-commits view so next stays put', () => {
    render(
      <CommitWalkBar commits={makeCommits(3)} activeIndex={null} onChange={() => {}} />,
    )
    const showAll = screen.getByRole('button', { name: 'Show all commits' })
    expect(showAll).toBeDisabled()
    expect(showAll).toHaveClass('commit-walk-all')
    expect(screen.getByRole('button', { name: 'Next commit' })).toBeInTheDocument()
  })

  it('enables Show all when focused on a single commit', () => {
    render(
      <CommitWalkBar commits={makeCommits(3)} activeIndex={0} onChange={() => {}} />,
    )
    const showAll = screen.getByRole('button', { name: 'Show all commits' })
    expect(showAll).not.toBeDisabled()
  })

  it('steps next from all → first commit without removing the Show all slot', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <CommitWalkBar commits={makeCommits(3)} activeIndex={null} onChange={onChange} />,
    )
    // Slot present while on all view
    expect(screen.getByRole('button', { name: 'Show all commits' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next commit' }))
    expect(onChange).toHaveBeenCalledWith(0)
  })

  it('Show all returns to the full range', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <CommitWalkBar commits={makeCommits(3)} activeIndex={1} onChange={onChange} />,
    )
    await user.click(screen.getByRole('button', { name: 'Show all commits' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })
})

describe('stepCommitWalk', () => {
  it('rings through all → 0 → … → last → all', () => {
    expect(stepCommitWalk(null, 3, 'next')).toBe(0)
    expect(stepCommitWalk(0, 3, 'next')).toBe(1)
    expect(stepCommitWalk(1, 3, 'next')).toBe(2)
    expect(stepCommitWalk(2, 3, 'next')).toBe(null)
    expect(stepCommitWalk(null, 3, 'prev')).toBe(2)
    expect(stepCommitWalk(0, 3, 'prev')).toBe(null)
    expect(stepCommitWalk(2, 3, 'prev')).toBe(1)
  })

  it('is a no-op when fewer than 2 commits', () => {
    expect(stepCommitWalk(null, 1, 'next')).toBe(null)
    expect(stepCommitWalk(0, 0, 'prev')).toBe(0)
  })
})

