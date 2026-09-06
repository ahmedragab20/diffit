import { join } from "node:path";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { getProjectStorageDir } from "./git.js";
import type { ReviewComment } from "./types.js";

/**
 * A review comment that already exists on the PR. Fetched from GitHub at
 * session start and synchronized with their published GitHub thread.
 */
export interface PrExistingComment {
  /** GitHub's database id for the review comment. */
  id: number;
  author: { login: string; avatarUrl?: string } | null;
  body: string;
  /** File path as GitHub reports it (no `a/` / `b/` prefix). */
  path: string;
  /** `null` when the comment is anchored to the file rather than a specific line. */
  line: number | null;
  /** First line of a multi-line GitHub review comment. */
  startLine?: number | null;
  /** GitHub's "LEFT" (deletions) or "RIGHT" (additions) side, or null. */
  side: "LEFT" | "RIGHT" | null;
  startSide?: "LEFT" | "RIGHT" | null;
  createdAt: string;
  updatedAt: string;
  /** The state of the review this comment belongs to (if it's the head comment of a review). */
  state:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "COMMENTED"
    | "PENDING"
    | "DISMISSED"
    | null;
  replies: PrExistingReply[];
  /** GitHub returns this when the diff has shifted; we surface it as a warning. */
  isOutdated: boolean;
  /** GraphQL node id for the containing review thread (required to resolve it). */
  threadId?: string;
  /** Resolution state lives on PullRequestReviewThread, not the REST comment. */
  isResolved?: boolean;
  viewerCanResolve?: boolean;
  viewerCanUnresolve?: boolean;
  viewerDidAuthor?: boolean;
}

export interface PrExistingReply {
  id: number;
  author: { login: string; avatarUrl?: string } | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  viewerDidAuthor?: boolean;
}

/** A submitted GitHub review event and its overall (non-inline) comment. */
export interface PrExistingReview {
  id: number;
  author: { login: string; avatarUrl?: string } | null;
  body: string;
  state:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "COMMENTED"
    | "PENDING"
    | "DISMISSED";
  submittedAt: string | null;
  htmlUrl?: string;
  commitId?: string;
}

export type PrState = "open" | "closed" | "merged";
export type PrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** Issue-level (non-review) comment on the pull request conversation. */
export interface PrIssueComment {
  id: number;
  author: PrAuthor | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl?: string;
}

/** Compact GitHub timeline event (labels, close/reopen, force-push, …). */
export interface PrTimelineEvent {
  id: string;
  event: string;
  createdAt: string;
  actor: PrAuthor | null;
  label?: string;
  assignee?: string;
  commitId?: string;
  rename?: { from: string; to: string };
}

export function findPendingReview(
  reviews: PrExistingReview[] | undefined,
  reviewId?: number,
): PrExistingReview | undefined {
  const pending = (reviews ?? []).filter((review) => review.state === "PENDING");
  if (reviewId != null) return pending.find((review) => review.id === reviewId);
  return pending[0];
}

export interface PrAuthor {
  login: string;
  avatarUrl?: string;
}

/**
 * - approve / comment / request-changes → GitHub review events
 * - draft → pending review (omit `event` so GitHub keeps it as PENDING)
 */
export type PrDecision = "approve" | "comment" | "request-changes" | "draft";

export type PrPublicationState =
  | "idle"
  | "sending"
  | "confirmed"
  | "unknown"
  | "failed";

export interface PrPublication {
  state: PrPublicationState;
  decision?: PrDecision;
  body?: string;
  updatedAt: number;
  reviewId?: number;
  reviewUrl?: string;
  error?: string;
  headSha?: string;
}

/**
 * A full PR review session: the cached diff + metadata + the in-progress
 * new comments + the read-only existing comments. Persisted to
 * `pr-session.json` in the per-repo storage dir.
 */
export interface PrSession {
  /** Original `gh pr <ref>` input as the user typed it. */
  ref: string;
  /** Resolved `owner` segment from `repository.owner.login`. */
  owner: string;
  /** Resolved `repository.name`. */
  repo: string;
  pullNumber: number;
  /**
   * GitHub host when not github.com (GHES / GHE Cloud). Omitted for
   * github.com and for sessions created before host tracking existed.
   */
  host?: string;
  /** The PR's head SHA — used to detect "force-pushed" between fetches. */
  headSha: string;
  /** The PR's base SHA (often just `refs/heads/main`). */
  baseSha: string;
  /** The PR's head (source) branch name, e.g. `feature/foo`. Empty for legacy sessions. */
  headRefName?: string;
  /** The PR's base (target) branch name, e.g. `main`. Empty for legacy sessions. */
  baseRefName?: string;
  /** Merge-base SHA for the PR comparison. Used for old-file expansion. */
  mergeBaseSha?: string;
  /** Files-API completeness when the unified diff was synthesized. */
  diffCompleteness?: { listedFiles: number; omittedPatches: number };
  title: string;
  url: string;
  author: PrAuthor | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** The full unified diff for the PR. */
  diff: string;
  /** Comments the user is writing *right now* in this diffing session. */
  comments: ReviewComment[];
  /** Existing published comments fetched from and synchronized with GitHub. */
  existingComments: PrExistingComment[];
  /** Submitted review verdicts and their overall GitHub comments. */
  existingReviews?: PrExistingReview[];
  /** Draft overall review note, persisted independently of the submit POST. */
  reviewBody?: string;
  /** Last chosen verdict, persisted independently of the submit POST. */
  reviewDecision?: PrDecision;
  /** Durable publication receipt for the latest submit attempt. */
  publication?: PrPublication;
  /** PR description markdown (GitHub issue body). */
  body?: string;
  /** OPEN/CLOSED/MERGED as lowercase. */
  state?: PrState;
  isDraft?: boolean;
  createdAt?: string;
  mergeable?: PrMergeable;
  mergeStateStatus?: string;
  maintainerCanModify?: boolean;
  /** Head repository when the PR is from a fork. */
  headOwner?: string;
  headRepo?: string;
  issueComments?: PrIssueComment[];
  timelineEvents?: PrTimelineEvent[];
  /** Epoch ms of the last successful GitHub conversation/metadata sync. */
  syncedAt?: number;
  /** Set after a successful submit; allows us to surface a no-op on double-click. */
  submittedAt?: number;
  submittedReviewId?: number;
  submittedReviewUrl?: string;
  /** The auth source we used last (for diagnostics). */
  authSource?: "gh" | "token";
  /**
   * Ids of replies we optimistically appended in {@link PrSession.existingComments}
   * via the reply endpoint that have not yet shown up in a fresh
   * `fetchExistingCommentsViaGh`. `syncExistingPrReviewData` walks this list to
   * preserve the optimistic copies across the GitHub propagation window so the
   * UI never sees them flash out (which is what the user reported as "comments
   * disappear after submitting a reply"). An id is removed the moment a fresh
   * fetch includes it; ids whose GitHub counterpart never lands are also removed
   * (a once-optimistic acknowledgement that the optimistic copy was wrong).
   */
  pendingOptimisticReplyIds?: number[];
}

export type PrSessionIdentity = Pick<
  PrSession,
  "owner" | "repo" | "pullNumber"
> & { host?: string };

export function prSessionIdentity(session: PrSessionIdentity): string {
  const host =
    session.host && session.host !== "github.com" ? session.host : "github.com";
  return `${host}::${session.owner}::${session.repo}::${session.pullNumber}`;
}

export function samePrIdentity(
  a: PrSessionIdentity,
  b: PrSessionIdentity,
): boolean {
  return prSessionIdentity(a) === prSessionIdentity(b);
}

function identityFileName(id: string): string {
  return `pr-session--${id.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
}

export type PrSessionMutator = (
  current: PrSession | null,
) => PrSession | null | Promise<PrSession | null>;

export interface PrSessionStore {
  get(): Promise<PrSession | null>;
  set(session: PrSession): Promise<void>;
  /** Patch fields of the session (shallow merge). Returns the new full session. */
  update(fields: Partial<PrSession>): Promise<PrSession | null>;
  /** Serialize read-modify-write so concurrent mutations cannot clobber each other. */
  apply(mutator: PrSessionMutator): Promise<PrSession | null>;
  /** Read a previously stored session for a specific PR without changing the active pointer. */
  getFor(identity: PrSessionIdentity): Promise<PrSession | null>;
  clear(): Promise<void>;
}

export class FilePrSessionStore implements PrSessionStore {
  private dirPath: string;
  private filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(storageDir?: string) {
    this.dirPath = storageDir ?? getProjectStorageDir();
    this.filePath = join(this.dirPath, "pr-session.json");
  }

  private identityPath(identity: PrSessionIdentity): string {
    return join(this.dirPath, identityFileName(prSessionIdentity(identity)));
  }

  private async readPath(path: string): Promise<PrSession | null> {
    try {
      const data = await readFile(path, "utf-8");
      return JSON.parse(data) as PrSession;
    } catch {
      return null;
    }
  }

  async get(): Promise<PrSession | null> {
    return this.readPath(this.filePath);
  }

  async getFor(identity: PrSessionIdentity): Promise<PrSession | null> {
    return this.readPath(this.identityPath(identity));
  }

  private async writeAtomic(path: string, session: PrSession): Promise<void> {
    await mkdir(this.dirPath, { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(session, null, 2), "utf-8");
    await rename(tmp, path);
  }

  private async save(session: PrSession): Promise<void> {
    await this.writeAtomic(this.identityPath(session), session);
    await this.writeAtomic(this.filePath, session);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async set(session: PrSession): Promise<void> {
    await this.enqueue(() => this.save(session));
  }

  async update(fields: Partial<PrSession>): Promise<PrSession | null> {
    return this.apply((current) =>
      current ? { ...current, ...fields } : null,
    );
  }

  async apply(mutator: PrSessionMutator): Promise<PrSession | null> {
    return this.enqueue(async () => {
      const next = await mutator(await this.get());
      if (next) await this.save(next);
      return next;
    });
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      try {
        await unlink(this.filePath);
      } catch {
        // ignore
      }
    });
  }
}

export class InMemoryPrSessionStore implements PrSessionStore {
  private current: PrSession | null = null;
  private byIdentity = new Map<string, PrSession>();
  private queue: Promise<unknown> = Promise.resolve();

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async get(): Promise<PrSession | null> {
    return this.current;
  }

  async getFor(identity: PrSessionIdentity): Promise<PrSession | null> {
    return this.byIdentity.get(prSessionIdentity(identity)) ?? null;
  }

  async set(session: PrSession): Promise<void> {
    await this.enqueue(async () => {
      this.current = session;
      this.byIdentity.set(prSessionIdentity(session), session);
    });
  }

  async update(fields: Partial<PrSession>): Promise<PrSession | null> {
    return this.apply((current) =>
      current ? { ...current, ...fields } : null,
    );
  }

  async apply(mutator: PrSessionMutator): Promise<PrSession | null> {
    return this.enqueue(async () => {
      const next = await mutator(this.current);
      this.current = next;
      if (next) this.byIdentity.set(prSessionIdentity(next), next);
      return next;
    });
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      this.current = null;
    });
  }
}
