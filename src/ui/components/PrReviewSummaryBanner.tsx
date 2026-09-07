import { useState } from "react";
import { GitPullRequest } from "lucide-react";
import type { PrSession } from "../../lib/pr-session";
import { PrChecksPopover } from "./PrChecksPopover";
import { Markdown } from "./Markdown";
import { PrAuthorActions } from "./PrAuthorActions";

interface PrReviewSummaryBannerProps {
  session: PrSession;
  draftCount: number;
  onAuthorChanged?: () => void;
}

/** GitHub-specific context, kept out of the action toolbar. */
export function PrReviewSummaryBanner({
  session,
  draftCount,
  onAuthorChanged,
}: PrReviewSummaryBannerProps) {
  const [bodyOpen, setBodyOpen] = useState(false);
  return (
    <section
      className="diff-overview-banner pr-overview-banner"
      aria-label={`Pull request #${session.pullNumber}: ${session.title}`}
    >
      <header className="diff-overview-banner-header">
        <div className="diff-overview-banner-line">
          <GitPullRequest
            size={14}
            className="diff-overview-banner-icon"
            aria-hidden="true"
          />
          <h2 className="diff-overview-banner-headline">{session.title}</h2>
        </div>
        <div className="diff-overview-banner-meta pr-overview-meta">
          <span className="pr-overview-identity">
            Pull request #{session.pullNumber}
            {session.author?.login ? (
              <>
                {" "}
                by <strong>@{session.author.login}</strong>
              </>
            ) : null}
          </span>
          {session.headRefName && session.baseRefName && (
            <span
              className="pr-overview-branches"
              title={`Comparing ${session.headRefName} into ${session.baseRefName}`}
            >
              <code className="pr-overview-branch-head">
                {session.headRefName}
              </code>
              <span className="pr-overview-branch-arrow" aria-hidden="true">
                →
              </span>
              <code className="pr-overview-branch-base">
                {session.baseRefName}
              </code>
            </span>
          )}
          <span>
            {session.changedFiles} file{session.changedFiles === 1 ? "" : "s"}
          </span>
          <span
            className="toolbar-chip-diff"
            aria-label={`${session.additions} additions and ${session.deletions} deletions`}
          >
            <span className="stat-additions">+{session.additions}</span>
            <span className="stat-deletions">−{session.deletions}</span>
          </span>
          {draftCount > 0 && (
            <span className="toolbar-chip toolbar-chip-comments">
              {draftCount} draft{draftCount === 1 ? "" : "s"}
            </span>
          )}
          {session.diffCompleteness &&
            session.diffCompleteness.omittedPatches > 0 && (
              <span
                className="toolbar-chip"
                title="Some files have no patch (binary or over GitHub's per-file cap)"
              >
                {session.diffCompleteness.omittedPatches} of{" "}
                {session.diffCompleteness.listedFiles} files lack patches
              </span>
            )}
          {session.state && (
            <span className="toolbar-chip" data-state={session.state}>
              {session.isDraft ? "draft" : session.state}
            </span>
          )}
          <PrChecksPopover headSha={session.headSha} />
        </div>
      </header>
      <PrAuthorActions session={session} onChanged={onAuthorChanged} />
      {session.body?.trim() ? (
        <div className="pr-overview-body">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setBodyOpen((open) => !open)}
            aria-expanded={bodyOpen}
          >
            {bodyOpen ? "Hide description" : "Show description"}
          </button>
          {bodyOpen && (
            <Markdown
              content={session.body}
              className="pr-overview-description markdown-body"
            />
          )}
        </div>
      ) : null}
    </section>
  );
}
