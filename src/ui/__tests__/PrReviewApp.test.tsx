// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the hooks the PrReviewApp component depends on, BEFORE importing it.
// The component is integration-heavy (uses useWorkerPool, useApplyFonts,
// parsePatchFiles, etc.); these tests focus on the empty-state UX which
// is the only path that doesn't require a full diff render.

const mockUsePrSession = vi.fn()
vi.mock('../hooks/usePrSession', () => ({
  usePrSession: () => mockUsePrSession(),
  usePrCommentSync: () => undefined,
  usePrComments: () => ({
    comments: [],
    addComment: vi.fn(),
    removeComment: vi.fn(),
    updateComment: vi.fn(),
    addReply: vi.fn(),
    resolveComment: vi.fn(),
    unresolveComment: vi.fn(),
    editComment: vi.fn(),
    editReply: vi.fn(),
    removeReply: vi.fn(),
  }),
  useSubmitPrReview: () => ({ mutateAsync: vi.fn() }),
  useRefreshPrSession: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ settings: {}, loaded: true, updateSettings: vi.fn() }),
  resolveMonoFont: () => 'monospace',
}))

vi.mock('../hooks/useApplyFonts', () => ({
  useApplyFonts: () => undefined,
}))

vi.mock('../hooks/useViewed', () => ({
  useViewed: () => ({ viewedFiles: new Set<string>(), setViewed: vi.fn() }),
}))

vi.mock('../hooks/useDiff', () => ({
  useDiff: () => ({ patch: '', loading: false, error: null }),
}))

vi.mock('../router', () => ({
  useRoutePath: () => '/gh/pr',
  navigate: vi.fn(),
}))

// The @pierre/diffs worker pool isn't usable in jsdom; stub it.
vi.mock('@pierre/diffs/react', () => ({
  useWorkerPool: () => ({ setRenderOptions: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: () => ({ data: null, isLoading: false }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  }
})

// Stub lucide-react icons as simple no-op components so the jsdom env
// doesn't need the SVG engine. The full set used across the components
// the empty-state path transitively imports.
vi.mock('lucide-react', () => {
  const Stub = () => null
  const proxy: Record<string, unknown> = {}
  const keys = [
    'GitPullRequest', 'ArrowLeft', 'ExternalLink', 'RefreshCw', 'MessageCircle', 'Copy',
    'GitMerge',
    'Pencil', 'Trash2', 'Check', 'X', 'MessageSquareWarning', 'AlertCircle',
    'CheckCircle2', 'Loader2', 'Eye', 'EyeOff', 'Search', 'XCircle', 'Clock',
    'ChevronDown', 'ChevronUp', 'ChevronLeft', 'ChevronRight', 'CornerUpLeft',
    'FilePenLine', 'Menu', 'Settings', 'Palette', 'Type', 'LayoutGrid', 'Sparkles',
    'FileText', 'Code2', 'Loader2', 'GitCompare', 'CornerDownLeft', 'Layers',
    'CircleDot', 'Clock3', 'MinusCircle', 'Terminal', 'Keyboard', 'Command',
    // CommentForm severity select
    'Minus', 'AlertOctagon', 'CircleDot', 'HelpCircle', 'Sparkles', 'ChevronsUpDown',
  ]
  for (const k of keys) proxy[k] = Stub
  return proxy
})

import { render, screen } from '@testing-library/react'
import { PrReviewApp } from '../components/PrReviewApp'

describe('PrReviewApp (empty state)', () => {
  beforeEach(() => {
    mockUsePrSession.mockReset()
  })

  it('shows a "loading" message while the session hook is hydrating', () => {
    mockUsePrSession.mockReturnValue({ session: null, loaded: false })
    render(<PrReviewApp />)
    expect(screen.getByText(/Loading PR session/i)).toBeInTheDocument()
  })

  it('shows an empty-state CTA when no session is present', () => {
    mockUsePrSession.mockReturnValue({ session: null, loaded: true })
    render(<PrReviewApp />)
    expect(screen.getByText(/No active PR session/i)).toBeInTheDocument()
    expect(
      screen.getByText(/diffing "gh pr 1234"/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/diffing --gh-pr 1234/i),
    ).toBeInTheDocument()
  })

  it('never renders the local "Send to agent" popover in PR mode', () => {
    mockUsePrSession.mockReturnValue({ session: null, loaded: true })
    render(<PrReviewApp />)
    expect(screen.queryByText(/Send to agent/i)).not.toBeInTheDocument()
  })

  it('has a "Back to local review" button', () => {
    mockUsePrSession.mockReturnValue({ session: null, loaded: true })
    render(<PrReviewApp />)
    expect(
      screen.getByRole('button', { name: /Back to local/i }),
    ).toBeInTheDocument()
  })

})
