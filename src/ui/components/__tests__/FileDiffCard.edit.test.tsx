// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs'
import type { EditSessionView } from '../../hooks/useEditSessions'
import type { ReviewComment } from '../../../lib/types'
import type { ComponentProps } from 'react'

// Capture the props actually handed to MultiFileDiff so we can assert the
// edit surface (`edit`, seed content) and drive edit callbacks.
const { lastMultiFileDiffProps, StubMultiFileDiff } = vi.hoisted(() => {
  const lastMultiFileDiffProps: {
    edit?: boolean
    newFileContents?: string
    oldFileContents?: string
    onChange?: (event: { file: unknown; lineAnnotations?: unknown }) => void
    onAttach?: (...args: unknown[]) => void
  } = {}
  const StubMultiFileDiff = (props: {
    edit?: boolean
    newFile?: { name?: string; contents?: string }
    oldFile?: { name?: string; contents?: string }
    onEditChange?: (event: { file: unknown; lineAnnotations?: unknown }) => void
    editorOptions?: {
      onAttach?: (...args: unknown[]) => void
    }
  }) => {
    lastMultiFileDiffProps.edit = props.edit
    lastMultiFileDiffProps.newFileContents = props.newFile?.contents
    lastMultiFileDiffProps.oldFileContents = props.oldFile?.contents
    lastMultiFileDiffProps.onChange = props.onEditChange
    lastMultiFileDiffProps.onAttach = props.editorOptions?.onAttach
    return (
      <div
        data-testid="multifile-diff"
        data-edit={String(Boolean(props.edit))}
        data-newfile={props.newFile?.contents}
      />
    )
  }
  return { lastMultiFileDiffProps, StubMultiFileDiff }
})

vi.mock('@pierre/diffs/react', () => ({
  FileDiff: () => null,
  MultiFileDiff: StubMultiFileDiff,
}))

// NOTE: intentionally NOT mocking ../../hooks/useFileContents — it runs against
// the stubbed global fetch below and drives the full-context contentsReady gate.

import { FileDiffCard } from '../FileDiffCard'

const FILE_PATH = 'src/example.ts'

const fileDiff = {
  name: FILE_PATH,
  type: 'change',
  hunks: [],
  splitLineCount: 0,
  unifiedLineCount: 0,
  isPartial: false,
  deletionLines: [],
  additionLines: [],
} as unknown as FileDiffMetadata

function session(overrides: Partial<EditSessionView> = {}): EditSessionView {
  return {
    seedContent: 'new content',
    draft: 'new content',
    dirty: false,
    saving: false,
    error: null,
    annotations: null,
    annotationsVersion: 0,
    sessionKey: 0,
    baseHash: 'abc123',
    ...overrides,
  }
}

type RenderArgs = Pick<ComponentProps<typeof FileDiffCard>,
  'canEdit' | 'editSession' | 'onRequestEdit' | 'onEditChange' | 'onEditAttach' | 'onEditSave' | 'onEditDiscard'
>

function renderCard(args: RenderArgs = {}) {
  const {
    canEdit = false,
    editSession,
    onRequestEdit = vi.fn(),
    onEditChange = vi.fn(),
    onEditAttach = vi.fn(),
    onEditSave = vi.fn(),
    onEditDiscard = vi.fn(),
  } = args
  const annotations: DiffLineAnnotation<ReviewComment>[] = []
  return {
    onRequestEdit,
    onEditChange,
    onEditAttach,
    onEditSave,
    onEditDiscard,
    ...render(
      <FileDiffCard
        fileDiff={fileDiff}
        filePath={FILE_PATH}
        annotations={annotations}
        diffStyle="split"
        tabSize={4}
        viewed={false}
        theme="rose-pine"
        lineDiffType="word"
        lineWrap={false}
        diffIndicators="classic"
        showLineNumbers
        hunkSeparators="line-info"
        lineHoverHighlight="both"
        fontSize={13}
        monoFontFamily="monospace"
        expandContextByDefault={false}
        collapsedContextThreshold={10}
        expansionLineCount={20}
        autoCollapseLineThreshold={0}
        onViewedChange={vi.fn()}
        onAddComment={vi.fn()}
        onDeleteComment={vi.fn()}
        allowLocalActions
        canEdit={canEdit}
        editSession={editSession}
        onRequestEdit={onRequestEdit}
        onEditChange={onEditChange}
        onEditAttach={onEditAttach}
        onEditSave={onEditSave}
        onEditDiscard={onEditDiscard}
      />,
    ),
  }
}

beforeEach(() => {
  lastMultiFileDiffProps.edit = undefined
  lastMultiFileDiffProps.newFileContents = undefined
  lastMultiFileDiffProps.oldFileContents = undefined
  lastMultiFileDiffProps.onChange = undefined
  lastMultiFileDiffProps.onAttach = undefined
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const version = url.includes('version=old') ? 'old' : 'new'
    return {
      ok: true,
      json: async () => ({
        content: version === 'old' ? 'old content' : 'new content',
        missing: false,
      }),
    } as unknown as Response
  })
})

const EDIT_IN_PLACE = 'Edit file in place'
const SAVE_LABEL = 'Save edits (Cmd/Ctrl+S)'

describe('FileDiffCard in-place edit surface', () => {
  it('shows the Edit button when canEdit=true and clicks call onRequestEdit(filePath)', async () => {
    const { onRequestEdit } = renderCard({ canEdit: true })
    const editBtn = screen.getByLabelText(EDIT_IN_PLACE)
    expect(editBtn).toBeInTheDocument()
    fireEvent.click(editBtn)
    await act(async () => {
      await Promise.resolve()
    })
    expect(onRequestEdit).toHaveBeenCalledTimes(1)
    expect(onRequestEdit).toHaveBeenCalledWith(FILE_PATH)
  })

  it('does not render the Edit button when canEdit=false', () => {
    renderCard({ canEdit: false })
    expect(screen.queryByLabelText(EDIT_IN_PLACE)).toBeNull()
  })

  it('renders the Save button disabled when the session is clean (dirty=false)', () => {
    renderCard({ canEdit: true, editSession: session() })
    const save = screen.getByLabelText(SAVE_LABEL)
    expect(save).toBeInTheDocument()
    expect(save).toBeDisabled()
  })

  it('enables Save when dirty and click calls onEditSave(filePath)', () => {
    const { onEditSave } = renderCard({
      canEdit: true,
      editSession: session({ dirty: true }),
    })
    const save = screen.getByLabelText(SAVE_LABEL)
    expect(save).not.toBeDisabled()
    fireEvent.click(save)
    expect(onEditSave).toHaveBeenCalledTimes(1)
    expect(onEditSave).toHaveBeenCalledWith(FILE_PATH)
  })

  it('shows the session error text when error is set', () => {
    renderCard({
      canEdit: true,
      editSession: session({ error: 'disk conflict detected' }),
    })
    expect(screen.getByRole('alert')).toHaveTextContent('disk conflict detected')
  })

  it('renders the edit-mode MultiFileDiff with edit=true seeded from editSession.seedContent', async () => {
    renderCard({ canEdit: true, editSession: session({ seedContent: 'new content' }) })
    const surface = await screen.findByTestId('multifile-diff')
    expect(surface).toBeInTheDocument()
    expect(surface).toHaveAttribute('data-edit', 'true')
    expect(surface).toHaveAttribute('data-newfile', 'new content')
    expect(lastMultiFileDiffProps.edit).toBe(true)
    expect(lastMultiFileDiffProps.newFileContents).toBe('new content')
    expect(lastMultiFileDiffProps.oldFileContents).toBe('old content')
  })

  it('wires component onEditChange to onEditChange(filePath, file, undefined)', async () => {
    const { onEditChange } = renderCard({
      canEdit: true,
      editSession: session(),
    })
    await screen.findByTestId('multifile-diff')
    expect(lastMultiFileDiffProps.onChange).toBeTypeOf('function')
    const file = { name: FILE_PATH, contents: 'edited' }
    act(() => {
      lastMultiFileDiffProps.onChange!({ file, lineAnnotations: undefined })
    })
    expect(onEditChange).toHaveBeenCalledTimes(1)
    expect(onEditChange).toHaveBeenCalledWith(FILE_PATH, file, undefined)
  })

  it('wires editorOptions onAttach to onEditAttach(filePath, editor)', async () => {
    const { onEditAttach } = renderCard({
      canEdit: true,
      editSession: session(),
    })
    await screen.findByTestId('multifile-diff')
    expect(lastMultiFileDiffProps.onAttach).toBeTypeOf('function')
    const mockEditor = { focus: vi.fn(), setMarkers: vi.fn() }
    act(() => {
      lastMultiFileDiffProps.onAttach!(mockEditor as never)
    })
    expect(onEditAttach).toHaveBeenCalledTimes(1)
    expect(onEditAttach).toHaveBeenCalledWith(FILE_PATH, mockEditor)
  })

  it('calls onEditDiscard(filePath) when the Discard button is clicked while dirty', () => {
    const { onEditDiscard } = renderCard({
      canEdit: true,
      editSession: session({ dirty: true }),
    })
    const discard = screen.getByLabelText('Discard edits')
    expect(discard).not.toBeDisabled()
    fireEvent.click(discard)
    expect(onEditDiscard).toHaveBeenCalledTimes(1)
    expect(onEditDiscard).toHaveBeenCalledWith(FILE_PATH)
  })
})