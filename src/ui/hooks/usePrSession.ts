import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { subscribeLive } from "../live";
import type {
  PrSession,
  PrExistingComment,
  PrExistingReview,
  PrIssueComment,
  PrTimelineEvent,
  PrDecision,
  PrPublication,
} from "../../lib/pr-session";
import type { ReviewComment } from "../../lib/types";

const PR_SESSION_KEY = ["pr-session"] as const;

interface PrSessionResponse {
  prMode: boolean;
  ref: string;
  owner: string;
  repo: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  baseRefName?: string;
  headRefName?: string;
  title: string;
  url: string;
  author: { login: string; avatarUrl?: string } | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  existingComments: PrExistingComment[];
  existingReviews: PrExistingReview[];
  submittedAt?: number;
  submittedReviewId?: number;
  submittedReviewUrl?: string;
  authSource?: "gh" | "token";
  reviewBody?: string;
  reviewDecision?: PrDecision;
  publication?: PrPublication;
  body?: string;
  createdAt?: string;
  issueComments?: PrIssueComment[];
  timelineEvents?: PrTimelineEvent[];
}

/**
 * Resolves the active PR session. Returns `null` (with `loaded` false until the
 * first response) when the server is in local mode. Subscribes to the
 * `pr-session` SSE channel so a refresh from another tab / the CLI subcommand
 * re-renders the UI immediately.
 */
export function usePrSession() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery<PrSessionResponse | null>({
    queryKey: PR_SESSION_KEY,
    queryFn: async () => {
      const res = await fetch("/api/gh/session");
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as PrSessionResponse & {
        prMode?: boolean;
      };
      // Soft "not in PR mode" probe returns 200 + { prMode: false }.
      if (json?.prMode === false) return null;
      return json;
    },
    retry: false,
  });

  useEffect(() => {
    return subscribeLive("pr-session", () => {
      queryClient.invalidateQueries({ queryKey: PR_SESSION_KEY });
    });
  }, [queryClient]);

  return {
    session: data,
    loaded: !isLoading,
    error,
  };
}

/** Keep GitHub-originated replies, edits, deletions and resolution state live. */
export function usePrCommentSync(enabled: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let syncing = false;
    const sync = async () => {
      if (disposed || syncing || document.visibilityState === "hidden") return;
      syncing = true;
      try {
        const response = await fetch("/api/gh/comments/sync", {
          method: "POST",
        });
        if (response.ok && !disposed) {
          await queryClient.invalidateQueries({ queryKey: PR_SESSION_KEY });
        }
      } finally {
        syncing = false;
      }
    };
    const onFocus = () => {
      void sync();
    };
    void sync();
    const interval = window.setInterval(sync, 30_000);
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, queryClient]);
}

interface PrCommentsResponse extends Array<ReviewComment> {}

const PR_COMMENTS_KEY = ["pr-comments"] as const;

/**
 * Read/write the user's in-progress PR comments (stored in `pr-session.json`,
 * NOT `comments.json`). The hook is split from `useComments` so the wrong
 * storage backend can never accidentally be used.
 */
export function usePrComments(enabled: boolean) {
  const queryClient = useQueryClient();
  const { data: comments = [] } = useQuery<PrCommentsResponse>({
    queryKey: PR_COMMENTS_KEY,
    queryFn: async () => {
      const res = await fetch("/api/gh/pr-session/comments");
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled,
  });

  // Real-time: the server pushes a `pr-session` event when the file changes
  // (whether from this UI, the CLI subcommand, or an external editor). Re-fetch
  // both the session and the comments so the list stays in sync.
  useEffect(() => {
    return subscribeLive("pr-session", () => {
      queryClient.invalidateQueries({ queryKey: PR_COMMENTS_KEY });
    });
  }, [queryClient]);

  const addMutation = useMutation({
    mutationFn: async (params: {
      filePath: string;
      side: "deletions" | "additions";
      lineNumber: number;
      startLineNumber?: number;
      lineContent: string;
      body: string;
    }) => {
      const res = await fetch("/api/gh/pr-session/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const data = (await res.json().catch(() => ({}))) as ReviewComment & {
        error?: string;
      };
      if (!res.ok || !data.id)
        throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    onSuccess: (comment) => {
      queryClient.setQueryData<ReviewComment[]>(
        PR_COMMENTS_KEY,
        (prev = []) => [...prev, comment],
      );
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/gh/pr-session/comments/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData<ReviewComment[]>(PR_COMMENTS_KEY, (prev = []) =>
        prev.filter((c) => c.id !== id),
      );
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      body,
      status,
    }: {
      id: string;
      body?: string;
      status?: ReviewComment["status"];
    }) => {
      const res = await fetch(`/api/gh/pr-session/comments/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, status }),
      });
      const data = (await res.json().catch(() => ({}))) as ReviewComment & {
        error?: string;
      };
      if (!res.ok || !data.id)
        throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ReviewComment[]>(PR_COMMENTS_KEY, (prev = []) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      );
    },
  });

  const replyMutation = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: string }) => {
      const res = await fetch(`/api/gh/pr-session/comments/${id}/replies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, role: "user" }),
      });
      const data = (await res.json().catch(() => ({}))) as ReviewComment & {
        error?: string;
      };
      if (!res.ok || !data.id)
        throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    onMutate: async ({ id, body }) => {
      await queryClient.cancelQueries({ queryKey: PR_COMMENTS_KEY });
      const previous =
        queryClient.getQueryData<ReviewComment[]>(PR_COMMENTS_KEY) ?? [];
      const optimisticId = `pending-${crypto.randomUUID()}`;
      queryClient.setQueryData<ReviewComment[]>(
        PR_COMMENTS_KEY,
        (current = []) =>
          current.map((comment) =>
            comment.id === id
              ? {
                  ...comment,
                  replies: [
                    ...(comment.replies ?? []),
                    {
                      id: optimisticId,
                      body,
                      createdAt: Date.now(),
                      role: "user",
                    },
                  ],
                }
              : comment,
          ),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous)
        queryClient.setQueryData(PR_COMMENTS_KEY, context.previous);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ReviewComment[]>(PR_COMMENTS_KEY, (prev = []) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      );
    },
  });

  const resolveComment = useCallback(
    (id: string) => {
      return updateMutation.mutateAsync({ id, status: "resolved" });
    },
    [updateMutation],
  );

  const unresolveComment = useCallback(
    (id: string) => {
      return updateMutation.mutateAsync({ id, status: "open" });
    },
    [updateMutation],
  );


  return {
    comments,
    addComment: addMutation.mutate,
    removeComment: removeMutation.mutate,
    updateComment: updateMutation.mutate,
    addReply: replyMutation.mutateAsync,
    resolveComment,
    unresolveComment,
    editComment: (id: string, body: string) =>
      updateMutation.mutateAsync({ id, body }),

  };
}

export interface SubmitPrReviewInput {
  decision: PrDecision;
  body: string;
  dryRun?: boolean;
  pendingReviewId?: number;
}

export interface SubmitPrReviewResult {
  ok: boolean;
  reviewId?: number;
  reviewUrl?: string;
  authSource: "gh" | "token" | "none";
  error?: string;
  dryRun?: boolean;
  failedComments?: number;
}

export function useSubmitPrReview() {
  const queryClient = useQueryClient();
  return useMutation<SubmitPrReviewResult, Error, SubmitPrReviewInput>({
    mutationFn: async (input) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 60_000);
      try {
        const res = await fetch("/api/gh/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            decision: input.decision,
            body: input.body,
            dryRun: input.dryRun,
            pendingReviewId: input.pendingReviewId,
          }),
        });
        const data = (await res.json()) as SubmitPrReviewResult;
        if (!res.ok || !data.ok) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        return data;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(
            "GitHub submission timed out. Check your connection and try again.",
          );
        }
        throw error;
      } finally {
        window.clearTimeout(timeout);
      }
    },
    onSuccess: () => {
      queryClient.setQueryData<ReviewComment[]>(PR_COMMENTS_KEY, []);
      queryClient.invalidateQueries({ queryKey: PR_SESSION_KEY });
      queryClient.invalidateQueries({ queryKey: PR_COMMENTS_KEY });
    },
  });
}

export function useRefreshPrSession() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true; headSha: string }, Error, void>({
    mutationFn: async () => {
      const res = await fetch("/api/gh/pr/refresh", { method: "POST" });
      const data = (await res.json()) as {
        ok: boolean;
        headSha?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data as { ok: true; headSha: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PR_SESSION_KEY });
      queryClient.invalidateQueries({ queryKey: PR_COMMENTS_KEY });
    },
  });
}

export type { PrSession, PrExistingComment, PrDecision };
