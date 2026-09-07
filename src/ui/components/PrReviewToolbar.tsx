import { ArrowLeft, Copy, ExternalLink, GitPullRequest, Menu, RefreshCw, Search, ArrowRight } from 'lucide-react'
import type { ReviewComment } from '../../lib/types'
import type { PrSession } from '../../lib/pr-session'
import type { SubmitPrReviewResult } from '../hooks/usePrSession'
import { formatComments } from '../../lib/comment-format'
import { navigate } from '../router'
import { BrandMark } from './BrandMark'
import { ReviewSettingsPopover, type ReviewSettingsPopoverProps } from './ReviewSettingsPopover'
import { SubmitToGitHubPopover } from './SubmitToGitHubPopover'
import { PrAuthorActions } from './PrAuthorActions'
import { AiModelPicker } from '../ai/AiModelPicker'

interface PrReviewToolbarProps {
  session: PrSession
  comments: ReviewComment[]
  settingsProps: ReviewSettingsPopoverProps
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  onOpenSearch: () => void
  onRefresh: () => void
  refreshing: boolean
  onEditComment: (id: string, body: string) => void
  onDeleteComment: (id: string) => void
  onSubmitted?: (result: SubmitPrReviewResult) => void
  onOpenAiAssistant?: () => void
  onAuthorChanged?: () => void
}

export function PrReviewToolbar({
  session,
  comments,
  settingsProps,
  sidebarCollapsed,
  onToggleSidebar,
  onOpenSearch,
  onRefresh,
  refreshing,
  onEditComment,
  onDeleteComment,
  onSubmitted,
  onOpenAiAssistant,
  onAuthorChanged,
}: PrReviewToolbarProps) {
  return (
    <header className="toolbar diff-app-toolbar pr-review-toolbar" role="banner">
      <div className="toolbar-left">
        <button
          className="toolbar-mobile-toggle"
          onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? 'Open file tree' : 'Close file tree'}
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? 'Open sidebar · b' : 'Close sidebar · b'}
        >
          <Menu size={18} />
        </button>
        <button className="pr-toolbar-back" onClick={() => navigate('/')} title="Back to local review" aria-label="Back to local review">
          <ArrowLeft size={14} />
        </button>
        <div className="toolbar-brand pr-toolbar-brand">
          <BrandMark size={20} className="toolbar-brand-mark" />
          <div className="toolbar-brand-text">
            <h1 className="toolbar-title">{session.owner}/{session.repo}</h1>
            <span className="toolbar-branch-inline" title={`Pull request #${session.pullNumber}`}>
              <GitPullRequest size={11} /> #{session.pullNumber}
            </span>
            {session.headRefName && session.baseRefName && (
              <span
                className="toolbar-branch-flow"
                title={`Comparing ${session.headRefName} into ${session.baseRefName}`}
                aria-label={`Source branch ${session.headRefName} into target branch ${session.baseRefName}`}
              >
                <code className="toolbar-branch-head">{session.headRefName}</code>
                <ArrowRight size={11} aria-hidden="true" />
                <code className="toolbar-branch-base">{session.baseRefName}</code>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="toolbar-right">
        <AiModelPicker onOpenAssistant={onOpenAiAssistant} />
        <button className="btn btn-sm toolbar-search-btn" onClick={onOpenSearch} title="Search files and changed lines (⌘K)" aria-label="Search">
          <Search size={14} />
          <span className="btn-label">Search</span>
          <kbd className="toolbar-search-kbd">⌘K</kbd>
        </button>
        <button
          className="btn btn-sm pr-header-copy"
          onClick={() => navigator.clipboard.writeText(formatComments(comments))}
          disabled={comments.length === 0}
          title="Copy draft comments as Markdown"
        >
          <Copy size={13} /> <span className="btn-label">Copy</span>
        </button>
        <button className="btn btn-sm pr-header-refresh" onClick={onRefresh} disabled={refreshing} title="Refresh PR from GitHub">
          <RefreshCw size={13} className={refreshing ? 'spinning' : ''} />
          <span className="btn-label">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
        </button>
        <a className="btn btn-sm pr-header-link" href={session.url} target="_blank" rel="noreferrer" title="Open pull request on GitHub">
          <ExternalLink size={13} /> <span className="btn-label">GitHub</span>
        </a>
        <PrAuthorActions session={session} onChanged={onAuthorChanged} />
        <ReviewSettingsPopover {...settingsProps} />
        <SubmitToGitHubPopover session={session} comments={comments} onEditComment={onEditComment} onDeleteComment={onDeleteComment} onSubmitted={onSubmitted} />
      </div>
    </header>
  )
}
