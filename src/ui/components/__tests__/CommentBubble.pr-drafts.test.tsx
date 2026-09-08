// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewComment } from "../../../lib/types";
import { CommentBubble } from "../CommentBubble";
import { CommentActionsProvider } from "../CommentActionsProvider";
import { usePrComments } from "../../hooks/usePrSession";

const localHook = vi.hoisted(() => vi.fn(() => { throw new Error("Local comment hook must not run for PR drafts"); }));
vi.mock("../../hooks/useComments", () => ({ useComments: localHook }));
vi.mock("../../live", () => ({ subscribeLive: () => () => undefined }));
vi.mock("../Markdown", () => ({ Markdown: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock("../CommentForm", () => ({ CommentForm: ({ onSubmit }: { onSubmit: (body: string) => Promise<unknown> }) => <button onClick={() => void onSubmit("saved text")}>Save text</button> }));

let stored: ReviewComment[];
let failUpdate: boolean;
let requests: string[];
function Harness() {
  const api = usePrComments(true);
  return <CommentActionsProvider actions={{ addReply: (id, body) => api.addReply({ id, body }), editComment: api.editComment, resolveComment: api.resolveComment, unresolveComment: api.unresolveComment }}>
    {api.comments.map(comment => <CommentBubble key={comment.id} comment={comment} onDelete={api.removeComment} />)}
  </CommentActionsProvider>;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
}

beforeEach(() => {
  localHook.mockClear(); requests = []; failUpdate = false;
  stored = [{ id: "draft-1", filePath: "a.ts", side: "additions", lineNumber: 1, lineContent: "const a = 1", body: "Draft finding", status: "open", createdAt: Date.now(), replies: [] }];
  vi.stubGlobal("fetch", vi.fn(async (input: string, options?: RequestInit) => {
    requests.push(`${options?.method ?? "GET"} ${input}`);
    if (!input.startsWith("/api/gh/pr-session/comments")) throw new Error(`Wrong store: ${input}`);
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (options?.method === "PUT") {
      if (failUpdate) return new Response(JSON.stringify({ error: "Save failed" }), { status: 500 });
      stored[0] = { ...stored[0]!, ...body };
    }
    if (input.endsWith("/replies")) stored[0]!.replies.push({ id: "reply-1", body: body.body, role: "user", createdAt: Date.now() });
    if (options?.method === "DELETE") { stored = []; return Response.json({ ok: true }); }
    return Response.json(options?.method ? stored[0] : stored);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("inline PR draft actions", () => {
  it("persists reply, edit, resolve, reopen and delete in the PR store", async () => {
    mount(); await screen.findByText("Draft finding");
    fireEvent.click(screen.getByRole("button", { name: "Write a reply" }));
    fireEvent.click(screen.getByRole("button", { name: "Save text" }));
    await waitFor(() => expect(stored[0]!.replies).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save text" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Edit reply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete reply" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    fireEvent.click(screen.getByRole("button", { name: "Save text" }));
    await waitFor(() => expect(stored[0]!.body).toBe("saved text"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save text" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Resolve conversation" }));
    await screen.findAllByRole("button", { name: "Show resolved conversation" });
    expect(stored[0]!.status).toBe("resolved");
    fireEvent.click(screen.getAllByRole("button", { name: "Show resolved conversation" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Unresolve conversation" }));
    await screen.findByRole("button", { name: "Resolve conversation" });
    expect(stored[0]!.status).toBe("open");
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete comment" }));
    await waitFor(() => expect(stored).toHaveLength(0));
    expect(requests).toContain("POST /api/gh/pr-session/comments/draft-1/replies");
    expect(requests).toContain("PUT /api/gh/pr-session/comments/draft-1");
    expect(requests).toContain("DELETE /api/gh/pr-session/comments/draft-1");
    expect(localHook).not.toHaveBeenCalled();
  });

  it("reports failed resolution and preserves the open draft", async () => {
    failUpdate = true; mount(); await screen.findByText("Draft finding");
    fireEvent.click(screen.getByRole("button", { name: "Resolve conversation" }));
    await screen.findByText("Save failed");
    expect(stored[0]!.status).toBe("open");
  });

  it("does not offer working-tree suggestion application for PR drafts", async () => {
    stored[0]!.body = "```suggestion\nconst a = 2\n```";
    mount(); await screen.findByText("Suggested Change");
    expect(screen.queryByRole("button", { name: "Apply Suggestion" })).not.toBeInTheDocument();
  });
});
