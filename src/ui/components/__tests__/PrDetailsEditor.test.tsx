// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrSession } from '../../../lib/pr-session'
import { PrAuthorActions } from '../PrAuthorActions'
import { PrDetailsEditor } from '../PrDetailsEditor'

const session: PrSession = { owner: 'acme', repo: 'widget', pullNumber: 7, ref: '7', headSha: 'sha', baseSha: 'base', title: 'Original title', url: 'https://github.test/pr/7', author: { login: 'octocat' }, additions: 1, deletions: 0, changedFiles: 1, diff: '', comments: [], existingComments: [], body: 'Original body', state: 'open', mergeable: 'MERGEABLE', mergeStateStatus: 'clean', headRefName: 'topic', baseRefName: 'main' }
const renderEditor = (overrides: Partial<PrSession> = {}, onClose = vi.fn()) => render(<PrDetailsEditor session={{ ...session, ...overrides }} onClose={onClose} />)

describe('PrDetailsEditor', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends both changed fields in one PATCH', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    renderEditor()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New title' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'New body' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save to GitHub' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/gh/pr', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'New title', body: 'New body' }) })))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not request when fields are unchanged', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const onClose = vi.fn()
    renderEditor({}, onClose)
    fireEvent.click(screen.getByRole('button', { name: 'Save to GitHub' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('disables save when the title is blank', () => {
    renderEditor()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Save to GitHub' })).toBeDisabled()
    expect(screen.getByRole('alert', { name: '' })).toHaveTextContent('Title cannot be blank.')
  })

  it('renders markdown in preview mode', () => {
    renderEditor({}, vi.fn())
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '# Rendered heading\n\n**bold text**' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('heading', { name: /Rendered heading/ })).toBeInTheDocument()
    expect(screen.getByText('bold text')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument()
  })

  it('retains fields and shows an error when save fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Save failed' }) }))
    renderEditor()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Retained title' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Retained body' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save to GitHub' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Save failed'))
    expect(screen.getByLabelText('Title')).toHaveValue('Retained title')
    expect(screen.getByLabelText('Description')).toHaveValue('Retained body')
  })

  it('disables controls while save is pending', async () => {
    let resolve!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(r => { resolve = r })))
    renderEditor()
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Pending body' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save to GitHub' }))
    expect(screen.getByLabelText('Title')).toBeDisabled()
    expect(screen.getByLabelText('Description')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    resolve({ ok: true, json: async () => ({}) })
  })

  it('prompts on dirty cancel and allows keeping edits', () => {
    const onClose = vi.fn()
    renderEditor({}, onClose)
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Changed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('alertdialog', { name: 'Discard changes?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Description')).toHaveValue('Changed')
  })

  it('uses the latest session when opened again', () => {
    const { rerender } = render(<PrAuthorActions session={session} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    const latest = { ...session, title: 'Latest title', body: 'Latest body' }
    rerender(<PrAuthorActions session={latest} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }))
    expect(screen.getByLabelText('Title')).toHaveValue('Latest title')
    expect(screen.getByLabelText('Description')).toHaveValue('Latest body')
  })
})
