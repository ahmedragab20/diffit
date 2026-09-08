// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { Plan } from '../../lib/plan-types.js'

const { planReviewSpy, mockNavigate, mockUsePlans } = vi.hoisted(() => ({
  planReviewSpy: vi.fn(),
  mockNavigate: vi.fn(),
  mockUsePlans: vi.fn(),
}))

vi.mock('../router', () => ({
  useRoutePath: () => '/plan/p1',
  navigate: (path: string) => mockNavigate(path),
}))

vi.mock('../hooks/usePlans', () => ({
  usePlans: () => mockUsePlans(),
}))

vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({
    settings: {
      theme: 'rose-pine',
      fontSize: 13,
      monoFont: 'default',
      lineWrap: true,
      showLineNumbers: true,
      lineHoverHighlight: 'line',
      defaultTabSize: 2,
      showStatusBar: true,
    },
    loaded: true,
    updateSettings: vi.fn(),
  }),
  resolveMonoFont: () => 'monospace',
}))

vi.mock('../hooks/useApplyFonts', () => ({
  useApplyFonts: () => undefined,
}))

vi.mock('../hooks/usePlanReviewKeymaps', () => ({
  usePlanReviewKeymaps: () => undefined,
}))

vi.mock('@pierre/diffs/react', () => ({
  useWorkerPool: () => ({ setRenderOptions: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('@pierre/diffs', () => ({
  preloadHighlighter: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../components/PlanReview', () => ({
  PlanReview: (props: { viewMode?: string }) => {
    planReviewSpy(props)
    return <div data-testid="plan-review-stub" data-view-mode={props.viewMode} />
  },
}))

vi.mock('../components/ThemeModal', () => ({
  ThemeModal: () => null,
}))

vi.mock('../components/AgentActivityToast', () => ({
  AgentActivityToast: () => null,
}))

vi.mock('../components/VimStatusBar', () => ({
  VimStatusBar: () => null,
}))

vi.mock('../components/ShortcutsHelpModal', () => ({
  ShortcutsHelpModal: () => null,
}))

vi.mock('../components/SubmitPlanReviewPopover', () => ({
  SubmitPlanReviewPopover: () => null,
}))

vi.mock('../primitives/Popover', () => ({
  Popover: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</>,
}))

vi.mock('../primitives/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('lucide-react', () => {
  const Stub = () => null
  const mod: Record<string, unknown> = {}
  for (const name of [
    'AlertTriangle', 'ArrowLeft', 'Palette', 'ClipboardList', 'Settings', 'Code2', 'FileText', 'Columns2', 'Menu',
    'Search', 'PanelLeftClose', 'PanelLeftOpen', 'Check', 'X', 'MessageSquareWarning', 'Clock',
    'Trash2', 'Bot', 'MessageSquare', 'Copy', 'Loader2',
  ]) {
    mod[name] = Stub
  }
  return mod
})

import { PlanReviewApp } from '../components/PlanReviewApp.js'
import { setUiStateItem } from '../utils/uiState.js'

const plans: Plan[] = [
  {
    id: 'p1',
    title: 'Plan one',
    body: '# one',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    decision: 'pending',
    comments: [],
    versions: [],
  },
  {
    id: 'p2',
    title: 'Plan two',
    body: '# two',
    createdAt: 2,
    updatedAt: 2,
    version: 1,
    decision: 'pending',
    comments: [],
    versions: [],
  },
]

function mockMatchMedia(opts: { mobile?: boolean; narrowSplit?: boolean; commentsSheet?: boolean }) {
  const { mobile = false, narrowSplit = false, commentsSheet = false } = opts
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches:
      (mobile && query === '(max-width: 768px)') ||
      (narrowSplit && query === '(max-width: 960px)') ||
      (commentsSheet && query === '(max-width: 1024px)'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

describe('PlanReviewApp responsive sidebar', () => {
  beforeEach(() => {
    mockNavigate.mockReset()
    planReviewSpy.mockClear()
    setUiStateItem('diffing-sidebar-collapsed', 'false')
    global.ResizeObserver = class {
      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
      constructor(_cb: ResizeObserverCallback) {}
    } as unknown as typeof ResizeObserver
    mockUsePlans.mockReturnValue({
      plans,
      getPlan: (id: string) => plans.find((p) => p.id === id) ?? null,
      removePlan: vi.fn(),
      agentActivity: null,
      clearAgentActivity: vi.fn(),
      submitDecision: vi.fn(),
      submitting: false,
      agentWaiting: false,
      isLoading: false,
    })
  })

  it('collapses the plans sidebar after selecting a plan on mobile', () => {
    mockMatchMedia({ mobile: true })

    const { container } = render(<PlanReviewApp />)
    const sidebar = container.querySelector('.plan-sidebar')
    expect(sidebar).not.toHaveClass('sidebar-collapsed')

    fireEvent.click(screen.getByText('Plan two'))

    expect(mockNavigate).toHaveBeenCalledWith('/plan/p2')
    expect(sidebar).toHaveClass('sidebar-collapsed')
  })

  it('keeps the sidebar open after selecting a plan on desktop', () => {
    mockMatchMedia({})

    const { container } = render(<PlanReviewApp />)
    const sidebar = container.querySelector('.plan-sidebar')
    expect(sidebar).not.toHaveClass('sidebar-collapsed')

    fireEvent.click(screen.getByText('Plan two'))

    expect(mockNavigate).toHaveBeenCalledWith('/plan/p2')
    expect(sidebar).not.toHaveClass('sidebar-collapsed')
  })

  it('downgrades split to the last single mode on narrow viewports but keeps split stored', () => {
    mockMatchMedia({ narrowSplit: true, commentsSheet: true })
    setUiStateItem('diffing-plan-view-mode', 'split')
    setUiStateItem('diffing-plan-last-single-view-mode', 'source')

    render(<PlanReviewApp />)

    const lastCall = planReviewSpy.mock.calls.at(-1)?.[0]
    expect(lastCall?.viewMode).toBe('source')
  })

  it('restores split layout on wide viewports when split is the stored preference', () => {
    mockMatchMedia({})
    setUiStateItem('diffing-plan-view-mode', 'split')
    setUiStateItem('diffing-plan-last-single-view-mode', 'source')

    render(<PlanReviewApp />)

    const lastCall = planReviewSpy.mock.calls.at(-1)?.[0]
    expect(lastCall?.viewMode).toBe('split')
  })
})
