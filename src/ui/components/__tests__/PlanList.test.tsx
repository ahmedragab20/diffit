// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'

// ── Mocks ──

// Stub every lucide icon used by PlanList AND ConfirmDialog.
vi.mock('lucide-react', () => ({
  Check: () => <svg />,
  X: () => <svg />,
  MessageSquareWarning: () => <svg />,
  Clock: () => <svg />,
  Trash2: () => <svg />,
  Bot: () => <svg />,
  Search: () => <svg />,
  PanelLeftClose: () => <svg />,
  PanelLeftOpen: () => <svg />,
  MessageSquare: () => <svg />,
  Copy: () => <svg />,
  AlertTriangle: () => <svg />,
  Loader2: () => <svg />,
}))

vi.mock('../../primitives/Tooltip', () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
}))

vi.mock('../../utils/uiState', () => ({
  getUiStateItem: () => null,
  setUiStateItem: () => {},
}))

// Do NOT mock ConfirmDialog — the real one (Modal → Base UI Dialog) renders
// fine in jsdom.

// ── Imports (after mocks) ──
import { PlanList } from '../PlanList'
import type { Plan } from '../../../lib/plan-types'

const plans: Plan[] = [
  { id: 'p1', title: 'Plan one', body: '# one', createdAt: 1, updatedAt: 1, version: 1, decision: 'pending', comments: [], versions: [] },
  { id: 'p2', title: 'Plan two', body: '# two', createdAt: 1, updatedAt: 1, version: 1, decision: 'pending', comments: [], versions: [] },
]

function openDeleteDialog(onDelete: (id: string) => void) {
  render(
    <PlanList
      plans={plans}
      activeId={null}
      onSelect={vi.fn()}
      onDelete={onDelete}
    />,
  )
  fireEvent.click(screen.getAllByLabelText('Delete plan')[0])
}

beforeEach(() => {
  // Base UI's Dialog.Portal mounts into document.body — clear it between
  // tests so the rendered popups don't bleed across cases.
  document.body.innerHTML = ''
})

describe('PlanList delete confirmation', () => {
  it('shows a confirmation dialog instead of deleting immediately', () => {
    const onDelete = vi.fn()
    openDeleteDialog(onDelete)

    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog', { name: 'Delete plan?' })).toBeInTheDocument()
  })

  it('cancel closes the dialog without deleting', () => {
    const onDelete = vi.fn()
    openDeleteDialog(onDelete)

    const dialog = screen.getByRole('alertdialog', { name: 'Delete plan?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('confirm deletes the plan', () => {
    const onDelete = vi.fn()
    openDeleteDialog(onDelete)

    const dialog = screen.getByRole('alertdialog', { name: 'Delete plan?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith('p1')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
