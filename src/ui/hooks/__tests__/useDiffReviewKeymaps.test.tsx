// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Scope } from '../../lib/searchTypes'

vi.mock('../useHaptics', () => ({
  fireFeedback: vi.fn(),
  playSound: vi.fn(),
}))

import { useDiffReviewKeymaps } from '../useDiffReviewKeymaps'

type TestActions = Omit<
  Parameters<typeof useDiffReviewKeymaps>[0],
  'onExitZen' | 'onCloseFileSearch'
> & {
  onExitZen?: ReturnType<typeof vi.fn<() => void>>
  onCloseFileSearch?: ReturnType<typeof vi.fn<() => void>>
}

function makeActions(): TestActions {
  return {
    onNavigateFile: vi.fn(),
    onNavigateCommit: vi.fn(),
    onToggleViewed: vi.fn(),
    onToggleDiffStyle: vi.fn(),
    onCycleTabSize: vi.fn(),
    onToggleSidebar: vi.fn(),
    onToggleLineWrap: vi.fn(),
    onToggleLineNumbers: vi.fn(),
    onCycleDiffIndicators: vi.fn(),
    onCycleLineDiffType: vi.fn(),
    onOpenPalette: vi.fn<(scope: Scope) => void>(),
    onTogglePalette: vi.fn(),
    onNextSearchHit: vi.fn(),
    onPrevSearchHit: vi.fn(),
    onOpenTheme: vi.fn(),
    onOpenFileSearch: vi.fn(),
    onOpenShortcuts: vi.fn(),
    onToggleZen: vi.fn(),
    onExitZen: vi.fn(),
    onOpenSendReview: vi.fn(),
  }
}

function Harness({
  actions,
  children,
}: {
  actions: Parameters<typeof useDiffReviewKeymaps>[0]
  children?: React.ReactNode
}) {
  useDiffReviewKeymaps(actions)
  return <>{children}</>
}

describe('shared diff review keymaps', () => {
  beforeEach(() => {
    vi.stubGlobal('scrollBy', vi.fn())
    vi.stubGlobal('scrollTo', vi.fn())
  })

  it('supports file navigation, viewed state, sidebar, and formatting bindings', () => {
    const actions = makeActions()
    render(<Harness actions={actions} />)

    for (const key of ['J', 'K', 'v', 'm', 't', 'b', 'w', 'i', 'I']) {
      fireEvent.keyDown(window, { key })
    }

    expect(actions.onNavigateFile).toHaveBeenNthCalledWith(1, 'next')
    expect(actions.onNavigateFile).toHaveBeenNthCalledWith(2, 'prev')
    expect(actions.onToggleViewed).toHaveBeenCalledOnce()
    expect(actions.onToggleDiffStyle).toHaveBeenCalledOnce()
    expect(actions.onCycleTabSize).toHaveBeenCalledOnce()
    expect(actions.onToggleSidebar).toHaveBeenCalledOnce()
    expect(actions.onToggleLineWrap).toHaveBeenCalledOnce()
    expect(actions.onCycleDiffIndicators).toHaveBeenCalledOnce()
    expect(actions.onCycleLineDiffType).toHaveBeenCalledOnce()
  })

  it('cycles search hits with n and N', () => {
    const actions = makeActions()
    render(<Harness actions={actions} />)

    fireEvent.keyDown(window, { key: 'n' })
    fireEvent.keyDown(window, { key: 'N' })

    expect(actions.onNextSearchHit).toHaveBeenCalledOnce()
    expect(actions.onPrevSearchHit).toHaveBeenCalledOnce()
  })

  it('toggles line numbers with gn and #', () => {
    const actions = makeActions()
    render(<Harness actions={actions} />)

    fireEvent.keyDown(window, { key: 'g' })
    fireEvent.keyDown(window, { key: 'n' })
    fireEvent.keyDown(window, { key: '#' })

    expect(actions.onToggleLineNumbers).toHaveBeenCalledTimes(2)
  })

  it('supports the same search and theme sequences as local review', () => {
    const actions = makeActions()
    render(<Harness actions={actions} />)

    fireEvent.keyDown(window, { key: '/' })
    fireEvent.keyDown(window, { key: 'f' })
    fireEvent.keyDown(window, { key: 's' })
    fireEvent.keyDown(window, { key: 'g' })
    fireEvent.keyDown(window, { key: 'f' })
    fireEvent.keyDown(window, { key: 'g' })
    fireEvent.keyDown(window, { key: 'v' })
    fireEvent.keyDown(window, { key: 'g' })
    fireEvent.keyDown(window, { key: 't' })
    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    expect(actions.onOpenPalette).toHaveBeenNthCalledWith(1, 'all')
    expect(actions.onOpenPalette).toHaveBeenNthCalledWith(2, 'files')
    expect(actions.onOpenPalette).toHaveBeenNthCalledWith(3, 'symbols')
    expect(actions.onOpenPalette).toHaveBeenNthCalledWith(4, 'all')
    expect(actions.onOpenPalette).toHaveBeenNthCalledWith(5, 'files')
    expect(actions.onOpenTheme).toHaveBeenCalledOnce()
    expect(actions.onTogglePalette).toHaveBeenCalledOnce()
  })

  it('supports scrolling, help, and commit navigation where available', () => {
    const actions = makeActions()
    render(<Harness actions={actions} />)

    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'u', ctrlKey: true })
    fireEvent.keyDown(window, { key: ']' })
    fireEvent.keyDown(window, { key: '[' })
    fireEvent.keyDown(window, { key: '?' })

    expect(window.scrollBy).toHaveBeenCalledTimes(2)
    expect(actions.onNavigateCommit).toHaveBeenCalledWith('next')
    expect(actions.onNavigateCommit).toHaveBeenCalledWith('prev')
    expect(actions.onOpenShortcuts).toHaveBeenCalledOnce()
  })

  it('toggles zen mode with z', () => {
    const actions = makeActions()
    render(<Harness actions={actions} />)

    fireEvent.keyDown(window, { key: 'z' })

    expect(actions.onToggleZen).toHaveBeenCalledOnce()
  })

  it('Escape exits zen only when onExitZen is wired', () => {
    const withExit = makeActions()
    render(<Harness actions={withExit} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(withExit.onExitZen).toHaveBeenCalledOnce()

    // A second harness whose actions omit onExitZen — Escape must be inert
    // (no crash, nothing fired) because only App wires it while zen is active.
    const withoutExit = makeActions()
    delete withoutExit.onExitZen
    render(<Harness actions={withoutExit} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(withoutExit.onOpenShortcuts).not.toHaveBeenCalled()
    expect(withoutExit.onToggleZen).not.toHaveBeenCalled()
    expect(withoutExit.onOpenSendReview).not.toHaveBeenCalled()
  })

  it('Escape closes the open file search instead of exiting zen', () => {
    const actions = makeActions()
    actions.onCloseFileSearch = vi.fn()
    render(<Harness actions={actions} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(actions.onCloseFileSearch).toHaveBeenCalledOnce()
    expect(actions.onExitZen).not.toHaveBeenCalled()
  })

  it('Escape closes the file search even when zen is not wired', () => {
    const actions = makeActions()
    delete actions.onExitZen
    actions.onCloseFileSearch = vi.fn()
    render(<Harness actions={actions} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(actions.onCloseFileSearch).toHaveBeenCalledOnce()
    expect(actions.onToggleZen).not.toHaveBeenCalled()
    expect(actions.onOpenSendReview).not.toHaveBeenCalled()
  })

  it('opens the send-review dialog with Cmd/Ctrl+Enter', () => {
    const actions = makeActions()
    render(<Harness actions={actions} />)

    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })

    expect(actions.onOpenSendReview).toHaveBeenCalledOnce()
  })

  it('does not open send-review from an input field', () => {
    const actions = makeActions()
    render(
      <Harness actions={actions}>
        <input data-testid="in" />
      </Harness>,
    )

    const input = screen.getByTestId('in')
    input.focus()
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(actions.onOpenSendReview).not.toHaveBeenCalled()

    input.blur()
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    expect(actions.onOpenSendReview).toHaveBeenCalledOnce()
  })

  it('does not invoke global Cmd+Enter when a bubbling keydown is already defaultPrevented', () => {
    const actions = makeActions()
    render(
      <Harness actions={actions}>
        <button data-testid="button" onKeyDown={(event) => event.preventDefault()} />
      </Harness>,
    )

    fireEvent.keyDown(screen.getByTestId('button'), {
      key: 'Enter',
      metaKey: true,
    })

    expect(actions.onOpenSendReview).not.toHaveBeenCalled()
  })

  it('ignores composing j and Cmd+Enter keydowns', () => {
    const actions = makeActions()
    render(<Harness actions={actions} />)

    fireEvent.keyDown(window, { key: 'j', isComposing: true })
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true, keyCode: 229 })

    expect(window.scrollBy).not.toHaveBeenCalled()
    expect(actions.onOpenSendReview).not.toHaveBeenCalled()
  })

  it('does not invoke Cmd+Enter after a textarea removes and blurs itself synchronously', () => {
    const actions = makeActions()
    const { container } = render(<Harness actions={actions} />)
    const textarea = document.createElement('textarea')
    textarea.addEventListener('keydown', () => {
      textarea.blur()
      textarea.remove()
    })
    container.appendChild(textarea)

    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })

    expect(actions.onOpenSendReview).not.toHaveBeenCalled()
  })

  it('does not handle keydowns from a focused contenteditable inside a shadow root', () => {
    const actions = makeActions()
    const { container } = render(<Harness actions={actions} />)
    const host = document.createElement('div')
    if (typeof host.attachShadow !== 'function') return
    const shadow = host.attachShadow({ mode: 'open' })
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    shadow.appendChild(editable)
    container.appendChild(host)
    editable.focus()

    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })

    expect(window.scrollBy).not.toHaveBeenCalled()
    expect(actions.onOpenSendReview).not.toHaveBeenCalled()
  })

  it('does not scroll for meta+j or alt+j', () => {
    const actions = makeActions()
    render(<Harness actions={actions} />)

    fireEvent.keyDown(window, { key: 'j', metaKey: true })
    fireEvent.keyDown(window, { key: 'j', altKey: true })

    expect(window.scrollBy).not.toHaveBeenCalled()
    expect(actions.onNavigateFile).not.toHaveBeenCalled()
  })

  it('does not trigger background actions while a dialog is mounted', () => {
    const actions = makeActions()
    render(
      <Harness actions={actions}>
        <div role="dialog" data-testid="dialog" />
      </Harness>,
    )

    const dialog = screen.getByTestId('dialog')
    fireEvent.keyDown(dialog, { key: 'j' })
    fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true })

    expect(window.scrollBy).not.toHaveBeenCalled()
    expect(actions.onOpenSendReview).not.toHaveBeenCalled()
  })

  it('does not open send-review while a contenteditable inside a shadow root has focus', () => {
    const actions = makeActions()
    const { container } = render(<Harness actions={actions} />)

    const host = document.createElement('div')
    if (typeof host.attachShadow !== 'function') {
      // jsdom without shadow-DOM support — nothing to assert.
      return
    }
    const shadow = host.attachShadow({ mode: 'open' })
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    shadow.appendChild(editable)
    container.appendChild(host)

    editable.focus()

    // document.activeElement retargets to the shadow host, so a guard that
    // only inspects the top-level active element misses the editable node.
    expect(document.activeElement).toBe(host)

    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    expect(actions.onOpenSendReview).not.toHaveBeenCalled()
  })

  it('opens file search with Cmd/Ctrl+F, never the palette', () => {
    const actions = makeActions()
    render(<Harness actions={actions} />)

    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })

    expect(actions.onOpenFileSearch).toHaveBeenCalledTimes(2)
    expect(actions.onOpenPalette).not.toHaveBeenCalled()
  })

  it('opens file search with F', () => {
    const actions = makeActions()
    render(<Harness actions={actions} />)

    fireEvent.keyDown(window, { key: 'F' })

    expect(actions.onOpenFileSearch).toHaveBeenCalledOnce()
    expect(actions.onOpenPalette).not.toHaveBeenCalled()
  })

  it('opens file search from an input field via Cmd+F (global branch precedes the focus guard)', () => {
    const actions = makeActions()
    render(
      <Harness actions={actions}>
        <input data-testid="in" />
      </Harness>,
    )

    const input = screen.getByTestId('in')
    input.focus()
    fireEvent.keyDown(input, { key: 'f', metaKey: true })

    expect(actions.onOpenFileSearch).toHaveBeenCalledOnce()
    expect(actions.onOpenPalette).not.toHaveBeenCalled()
  })

  it('plain f opens the file palette instead of file search', () => {
    const actions = makeActions()
    render(<Harness actions={actions} />)

    fireEvent.keyDown(window, { key: 'f' })

    expect(actions.onOpenFileSearch).not.toHaveBeenCalled()
    expect(actions.onOpenPalette).toHaveBeenCalledWith('files')
  })
})
