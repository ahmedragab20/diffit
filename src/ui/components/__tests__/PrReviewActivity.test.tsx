// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PrReviewActivity } from '../PrReviewActivity'

const reviews = [
  {
    id: 2,
    author: { login: 'ahmedragab20', avatarUrl: 'https://example.test/avatar.png' },
    body: 'Approved again buddy@',
    state: 'APPROVED',
    submittedAt: '2026-07-18T20:00:00.000Z',
    htmlUrl: 'https://github.test/review/2',
  },
  {
    id: 1,
    author: { login: 'reviewer' },
    body: 'Please address the failing check.',
    state: 'CHANGES_REQUESTED',
    submittedAt: '2026-07-18T19:00:00.000Z',
  },
] as any

describe('PrReviewActivity', () => {
  it('shows the latest overall review comment and verdict', () => {
    const { container } = render(<PrReviewActivity reviews={reviews} />)
    expect(screen.getByText('Approved again buddy@')).toBeInTheDocument()
    expect(screen.getByText('Approved')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /View on GitHub/i })).toHaveAttribute('href', 'https://github.test/review/2')
    expect(container.querySelector('img.pr-review-activity-avatar')).toHaveAttribute(
      'src',
      `/api/gh/avatar?url=${encodeURIComponent('https://example.test/avatar.png')}`,
    )
  })

  it('falls back to the verdict icon when the avatar proxy cannot load', () => {
    const { container } = render(<PrReviewActivity reviews={reviews} />)
    fireEvent.error(container.querySelector('img.pr-review-activity-avatar')!)
    expect(container.querySelector('img.pr-review-activity-avatar')).not.toBeInTheDocument()
  })

  it('walks older review submissions without changing the diff', () => {
    render(<PrReviewActivity reviews={reviews} />)
    fireEvent.click(screen.getByRole('button', { name: 'Older review' }))
    expect(screen.getByText('Please address the failing check.')).toBeInTheDocument()
    expect(screen.getByText('Changes requested')).toBeInTheDocument()
  })

  it('sorts pending reviews first and exposes submit/discard actions', async () => {
    const onSubmitPending = vi.fn().mockResolvedValue(undefined)
    const onDiscardPending = vi.fn().mockResolvedValue(undefined)
    render(
      <PrReviewActivity
        reviews={[
          reviews[0],
          {
            id: 9,
            author: { login: 'me' },
            body: 'still writing',
            state: 'PENDING',
            submittedAt: null,
          },
        ]}
        onSubmitPending={onSubmitPending}
        onDiscardPending={onDiscardPending}
      />,
    )
    expect(screen.getByText('Pending')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onSubmitPending).toHaveBeenCalledWith(9, 'APPROVE'))
    fireEvent.click(screen.getByRole('button', { name: 'Discard pending review' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(onDiscardPending).toHaveBeenCalledWith(9))
  })
})
