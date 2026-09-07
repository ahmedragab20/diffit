// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PrConversationTimeline } from '../PrConversationTimeline'

describe('PrConversationTimeline', () => {
  it('renders the PR description as a conversation item', () => {
    render(
      <PrConversationTimeline
        items={[
          {
            id: 'pr-description',
            kind: 'pr-description',
            createdAt: '2026-01-01T00:00:00.000Z',
            author: 'octocat',
            body: 'Fixes the widget race.',
          },
        ]}
        total={1}
        cursor={0}
      />,
    )
    expect(screen.getByText('Description')).toBeInTheDocument()
    expect(screen.getByText('Fixes the widget race.')).toBeInTheDocument()
  })

  it('renders nothing when the timeline is empty', () => {
    const { container } = render(
      <PrConversationTimeline items={[]} total={0} cursor={0} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
