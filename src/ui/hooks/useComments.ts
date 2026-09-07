import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { DiffLineAnnotation } from "@pierre/diffs";
import type {
  CommentSeverity,
  ReviewComment,
  ReviewDecision,
  ReviewMode,
} from "../../lib/types";
import { formatComments } from "../../lib/comment-format";
import { subscribeLive } from "../live";

const COMMENTS_KEY = ["comments"];

import { readCommentResponse } from "../lib/commentResponse";

async function fetchComments(): Promise<ReviewComment[]> {
  const res = await fetch("/api/comments");
  if (!res.ok) throw new Error(`Could not load comments (HTTP ${res.status})`);
  const data: unknown = await res.json();
  // The API returns `{ error }` on failure (e.g. missing session token) — a
  // non-array body must not crash consumers that iterate `comments`.
  return Array.isArray(data) ? (data as ReviewComment[]) : [];
}

export interface AgentActivity {
  at: number;
  commentId: string;
  filePath: string;
  model?: string;
  body: string;
}

interface AgentStatus {
  round: number;
  waiters: number;
  lastSentAt: number | null;
  lastDecision?: ReviewDecision;
  lastOpenCount?: number;
  agents?: Array<{
    id: string;
    model?: string;
    label?: string;
    connectedAt: number;
  }>;
}

export function useComments() {
  const queryClient = useQueryClient();
  const { data: comments = [], isLoading } = useQuery({
    queryKey: COMMENTS_KEY,
    queryFn: fetchComments,
  });

  // Realtime: the server pushes a `comments` event whenever the store changes
  // (a user or agent added / replied / resolved / deleted). Refetch on push
  // instead of polling, so user<->agent exchanges feel instant.
  useEffect(() => {
    return subscribeLive("comments", () => {
      queryClient.invalidateQueries({ queryKey: COMMENTS_KEY });
    });
  }, [queryClient]);

  // Track the agent-handoff state so the "Send to agent" button can show
  // whether an agent is connected and waiting. Seed once, then follow the
  // server's `agent-status` pushes (an agent connected/left, or a round sent).
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({
    round: 0,
    waiters: 0,
    lastSentAt: null,
    lastDecision: undefined,
    lastOpenCount: undefined,
  });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/review/status")
      .then((r) => r.json())
      .then((s) => {
        if (!cancelled) setAgentStatus(s);
      })
      .catch(() => {});
    const unsubscribe = subscribeLive("agent-status", (data) => {
      try {
        setAgentStatus(JSON.parse(data));
      } catch {
        /* ignore malformed */
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Surface fresh agent replies so the UI can flash a "the agent responded"
  // indicator. Seed after the first successful fetch — an empty initial
  // `comments=[]` must not count as "seeded", or every historical reply
  // toasts when the real data arrives. Skip resolved threads.
  const seenReplyIds = useRef<Set<string> | null>(null);
  const [agentActivity, setAgentActivity] = useState<AgentActivity | null>(
    null,
  );

  useEffect(() => {
    if (isLoading) return;

    const seeding = seenReplyIds.current === null;
    if (seenReplyIds.current === null) seenReplyIds.current = new Set();
    const seen = seenReplyIds.current;

    let latest: AgentActivity | null = null;
    for (const comment of comments) {
      for (const reply of comment.replies ?? []) {
        if (seen.has(reply.id)) continue;
        seen.add(reply.id);
        if (seeding) continue;
        if (comment.status === "resolved") continue;
        const isAgent =
          reply.role === "agent" || (reply.role == null && !!reply.model);
        if (!isAgent) continue;
        if (!latest || reply.createdAt > latest.at) {
          latest = {
            at: reply.createdAt,
            commentId: comment.id,
            filePath: comment.filePath,
            model: reply.model,
            body: reply.body,
          };
        }
      }
    }
    if (latest) setAgentActivity(latest);
  }, [comments, isLoading]);

  const addMutation = useMutation({
    mutationFn: async (params: {
      filePath: string;
      side: "deletions" | "additions";
      lineNumber: number;
      startLineNumber?: number;
      lineContent: string;
      body: string;
      severity?: CommentSeverity;
    }) => {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      return readCommentResponse(res);
    },
    onSuccess: async (comment) => {
      await queryClient.cancelQueries({ queryKey: COMMENTS_KEY });
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) =>
        prev.some((item) => item.id === comment.id)
          ? prev.map((item) => (item.id === comment.id ? comment : item))
          : [...prev, comment],
      );
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/comments/${id}`, { method: "DELETE" });
      if (!res.ok)
        throw new Error(`Could not delete comment (HTTP ${res.status})`);
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) =>
        prev.filter((c) => c.id !== id),
      );
    },
  });

  const editMutation = useMutation({
    mutationFn: async ({
      id,
      body,
      status,
    }: {
      id: string;
      body?: string;
      status?: ReviewComment["status"];
    }) => {
      const res = await fetch(`/api/comments/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, status }),
      });
      return readCommentResponse(res);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      );
    },
  });

  const addReplyMutation = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: string }) => {
      const res = await fetch(`/api/comments/${id}/replies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, role: "user" }),
      });
      return readCommentResponse(res);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      );
    },
  });

  const removeReplyMutation = useMutation({
    mutationFn: async ({
      commentId,
      replyId,
    }: {
      commentId: string;
      replyId: string;
    }) => {
      const res = await fetch(`/api/comments/${commentId}/replies/${replyId}`, {
        method: "DELETE",
      });
      return readCommentResponse(res);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      );
    },
  });

  const editReplyMutation = useMutation({
    mutationFn: async ({
      commentId,
      replyId,
      body,
    }: {
      commentId: string;
      replyId: string;
      body: string;
    }) => {
      const res = await fetch(`/api/comments/${commentId}/replies/${replyId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      return readCommentResponse(res);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      );
    },
  });

  const sendToAgentMutation = useMutation({
    mutationFn: async ({
      decision,
      generalComment,
      mode,
      force,
    }: {
      decision?: ReviewDecision;
      generalComment?: string;
      mode?: ReviewMode;
      force?: boolean;
    }) => {
      const res = await fetch("/api/review/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          generalComment: generalComment?.trim() || undefined,
          mode,
          force: !!force,
        }),
      });
      if (res.status === 400) {
        const body = (await res.json().catch(() => null)) as {
          ok?: false;
          error?: string;
          findings?: { rule: string; snippet: string; source: string }[];
        } | null;
        if (body?.error === "secrets-detected") {
          const err = new Error("Secrets detected") as Error & {
            kind: "secrets";
            findings: { rule: string; snippet: string; source: string }[];
          };
          err.kind = "secrets";
          err.findings = body.findings ?? [];
          throw err;
        }
      }
      if (!res.ok) throw new Error("Failed to send to agent");
      return res.json() as Promise<{
        ok: boolean;
        round: number;
        openCount: number;
        decision?: ReviewDecision;
        waiters: number;
      }>;
    },
  });

  const applySuggestionMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/comments/${id}/apply-suggestion`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to apply suggestion");
      }
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: COMMENTS_KEY });
    },
  });

  const addComment = useCallback(
    (
      filePath: string,
      side: "deletions" | "additions",
      lineNumber: number,
      lineContent: string,
      body: string,
      startLineNumber?: number,
      severity?: CommentSeverity,
    ) => {
      return addMutation.mutateAsync({
        filePath,
        side,
        lineNumber,
        startLineNumber,
        lineContent,
        body,
        severity: severity && severity !== "none" ? severity : undefined,
      });
    },
    [addMutation.mutateAsync],
  );

  const removeComment = useCallback(
    (id: string) => {
      removeMutation.mutate(id);
    },
    [removeMutation.mutate],
  );

  const editComment = useCallback(
    (id: string, body: string) => editMutation.mutateAsync({ id, body }),
    [editMutation.mutateAsync],
  );

  const resolveComment = useCallback(
    (id: string) => {
      editMutation.mutate({ id, status: "resolved" });
    },
    [editMutation.mutate],
  );

  const unresolveComment = useCallback(
    (id: string) => {
      editMutation.mutate({ id, status: "open" });
    },
    [editMutation.mutate],
  );

  const addReply = useCallback(
    (id: string, body: string) => addReplyMutation.mutateAsync({ id, body }),
    [addReplyMutation.mutateAsync],
  );

  const removeReply = useCallback(
    (commentId: string, replyId: string) => {
      removeReplyMutation.mutate({ commentId, replyId });
    },
    [removeReplyMutation.mutate],
  );

  const editReply = useCallback(
    (commentId: string, replyId: string, body: string) =>
      editReplyMutation.mutateAsync({ commentId, replyId, body }),
    [editReplyMutation.mutateAsync],
  );

  const applySuggestion = useCallback(
    async (id: string) => {
      await applySuggestionMutation.mutateAsync(id);
    },
    [applySuggestionMutation.mutateAsync],
  );

  const formatAllComments = useCallback(
    (): string => formatComments(comments),
    [comments],
  );

  const getAnnotationsForFile = useCallback(
    (filePath: string): DiffLineAnnotation<ReviewComment>[] => {
      return comments
        .filter((c) => c.filePath === filePath)
        .map((c) => ({
          side: c.side,
          lineNumber: c.lineNumber,
          metadata: c,
        }));
    },
    [comments],
  );

  const copyAllComments = useCallback(async () => {
    const text = formatAllComments();
    await navigator.clipboard.writeText(text);
  }, [formatAllComments]);

  const copyAllCommentsMarkdown = useCallback(async () => {
    const { formatCommentsMarkdown } = await import(
      "../../lib/review-export.js"
    );
    const text = formatCommentsMarkdown(comments);
    if (!text) return;
    await navigator.clipboard.writeText(text);
  }, [comments]);

  const sendToAgent = useCallback(
    (
      decision?: ReviewDecision,
      generalComment?: string,
      mode?: ReviewMode,
      force?: boolean,
    ) =>
      sendToAgentMutation.mutateAsync({
        decision,
        generalComment,
        mode,
        force,
      }),
    [sendToAgentMutation.mutateAsync],
  );

  const resolveAllOpenMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/comments/resolve-all", { method: "POST" });
      if (!res.ok) throw new Error("Failed to resolve all comments");
      return (await res.json()) as { ok: boolean; resolved: number };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: COMMENTS_KEY });
    },
  });

  const resolveAllOpen = useCallback(
    () => resolveAllOpenMutation.mutateAsync(),
    [resolveAllOpenMutation],
  );

  return {
    comments,
    addComment,
    removeComment,
    editComment,
    resolveComment,
    unresolveComment,
    addReply,
    removeReply,
    editReply,
    applySuggestion,
    getAnnotationsForFile,
    formatAllComments,
    copyAllComments,
    copyAllCommentsMarkdown,
    agentActivity,
    clearAgentActivity: useCallback(() => setAgentActivity(null), []),
    sendToAgent,
    sending: sendToAgentMutation.isPending,
    agentWaiting:
      agentStatus.waiters > 0 || (agentStatus.agents?.length ?? 0) > 0,
    waitingAgents: agentStatus.agents ?? [],
    /**
     * Snapshot of the most recent handoff round. The UI uses this to render a
     * "Last sent" badge in the toolbar so reviewers can see at a glance
     * whether the agent is already up to date (round > 0) and what verdict
     * they last sent.
     */
    lastSend:
      agentStatus.lastSentAt == null
        ? null
        : {
            round: agentStatus.round,
            sentAt: agentStatus.lastSentAt,
            decision: agentStatus.lastDecision,
            openCount: agentStatus.lastOpenCount ?? null,
          },
    resolveAllOpen,
    resolvingAll: resolveAllOpenMutation.isPending,
  };
}
