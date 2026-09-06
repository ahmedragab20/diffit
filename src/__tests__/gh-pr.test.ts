// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { CommentStore } from "../lib/comments.js";
import { InMemoryPrSessionStore, type PrSession } from "../lib/pr-session.js";
import type { PlanStore } from "../lib/plans.js";

const githubMocks = vi.hoisted(() => ({
    submitReview: vi.fn(),
    fetchExistingComments: vi.fn(),
    fetchExistingReviews: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    setThreadResolved: vi.fn(),
    fetchPrFileContent: vi.fn(),
    refreshPrSession: vi.fn(),
    submitPendingReview: vi.fn(),
    deletePendingReview: vi.fn(),
}));

vi.mock("../lib/github.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/github.js")>();
    return {
        ...actual,
        submitReview: githubMocks.submitReview,
        fetchExistingCommentsViaGh: githubMocks.fetchExistingComments,
        fetchExistingReviewsViaGh: githubMocks.fetchExistingReviews,
        updatePrReviewComment: githubMocks.updateComment,
        deletePrReviewComment: githubMocks.deleteComment,
        setPrReviewThreadResolved: githubMocks.setThreadResolved,
        fetchPrFileContentViaGh: githubMocks.fetchPrFileContent,
        refreshPrSession: githubMocks.refreshPrSession,
        submitPendingReviewViaGh: githubMocks.submitPendingReview,
        deletePendingReviewViaGh: githubMocks.deletePendingReview,
    };
});

vi.mock("../lib/git.js", () => ({
    getGitDiff: vi.fn(() => ""),
    getCustomGitDiff: vi.fn(() => ""),
    getRepoName: vi.fn(() => "test-repo"),
    getBranchName: vi.fn(() => "main"),
    getFileContent: vi.fn(() => ""),
    getTabSizeForFiles: vi.fn(() => ({})),
    getUntrackedFilePaths: vi.fn(() => []),
    getGitDiffAsync: vi.fn(async () => ""),
    getCustomGitDiffAsync: vi.fn(async () => ""),
    getRepoRootAsync: vi.fn(async () => "/tmp/test-repo"),
    getBranchNameAsync: vi.fn(async () => "main"),
    getUntrackedFilePathsAsync: vi.fn(async () => []),
    getRepoRoot: vi.fn(() => "/tmp/test-repo"),
    getProjectStorageDir: vi.fn(() => "/tmp/test-project-storage"),
    getShowDiff: vi.fn(() => ""),
}));

vi.mock("../lib/settings.js", () => ({
    loadSettings: vi.fn(() => ({})),
    saveSettings: vi.fn((s: any) => s),
}));

vi.mock("../lib/path.js", () => ({ isSafePath: vi.fn(() => true) }));

class MockCommentStore implements CommentStore {
    async getAll() {
        return [];
    }
    async add(c: any) {
        return c;
    }
    async update() {
        return null;
    }
    async remove() {
        return false;
    }
    async addReply() {
        return null;
    }
    async removeReply() {
        return null;
    }
    async updateReply() {
        return null;
    }
    async resolveAllOpen() {
        return 0;
    }
}

class MockPlanStore implements PlanStore {
    async getAll() {
        return [];
    }
    async get() {
        return null;
    }
    async upsert(input: {
        id?: string;
        title: string;
        body: string;
        source?: string;
        model?: string;
    }) {
        return {
            id: input.id || "p1",
            title: input.title,
            body: input.body,
            source: input.source,
            model: input.model,
            createdAt: 0,
            updatedAt: 0,
            version: 1,
            decision: "pending" as const,
            comments: [],
            versions: [
                {
                    version: 1,
                    body: input.body,
                    title: input.title,
                    createdAt: 0,
                },
            ],
        };
    }
    async update() {
        return null;
    }
    async remove() {
        return false;
    }
    async setDecision() {
        return null;
    }
    async addComment() {
        return null;
    }
    async updateComment() {
        return null;
    }
    async removeComment() {
        return null;
    }
    async addReply() {
        return null;
    }
    async removeReply() {
        return null;
    }
    async updateReply() {
        return null;
    }
    async getVersion() {
        return null;
    }
}

const baseSession: PrSession = {
    ref: "1234",
    owner: "acme",
    repo: "widget",
    pullNumber: 1234,
    headSha: "head",
    baseSha: "base",
    title: "A test PR",
    url: "https://github.com/ahmedragab20/diffing/pull/1234",
    author: { login: "octocat" },
    additions: 10,
    deletions: 5,
    changedFiles: 2,
    diff: "diff --git a/x b/x\n",
    comments: [],
    existingComments: [
        {
            id: 999,
            author: { login: "reviewer" },
            body: "pre-existing feedback",
            path: "src/server.ts",
            line: 42,
            side: "RIGHT",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            state: "COMMENTED",
            replies: [],
            isOutdated: false,
        },
    ],
    authSource: "gh",
};

async function makeApp(prStore: InMemoryPrSessionStore): Promise<Hono> {
    const { createApp } = await import("../server.js");
    const { DEFAULTS } = await import("../lib/diff-options.js");
    return createApp(
        "/tmp/test-client",
        DEFAULTS,
        new MockCommentStore(),
        new MockPlanStore(),
        prStore,
        true,
    );
}

describe("gh-pr endpoints (integration)", () => {
    let app: Hono;
    let prStore: InMemoryPrSessionStore;

    beforeEach(async () => {
        vi.clearAllMocks();
        githubMocks.submitReview.mockResolvedValue({
            ok: true,
            reviewId: 55,
            reviewUrl: "https://github.test/review/55",
            authSource: "gh",
        });
        githubMocks.fetchExistingComments.mockResolvedValue([]);
        githubMocks.fetchExistingReviews.mockResolvedValue([]);
        githubMocks.updateComment.mockResolvedValue({ ok: true });
        githubMocks.deleteComment.mockResolvedValue({ ok: true });
        githubMocks.setThreadResolved.mockResolvedValue({ ok: true });
        githubMocks.fetchPrFileContent.mockResolvedValue(null);
        githubMocks.refreshPrSession.mockImplementation(
            async (session) => session,
        );
        prStore = new InMemoryPrSessionStore();
        app = await makeApp(prStore);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("GET /api/gh/session returns 200 prMode:false when no session", async () => {
        const res = await app.fetch(
            new Request("http://localhost/api/gh/session"),
        );
        // Soft probe for SPA Root redirect — not a hard 404.
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.prMode).toBe(false);
    });

    it("GET /api/gh/session returns the session when present", async () => {
        await prStore.set(baseSession);
        const res = await app.fetch(
            new Request("http://localhost/api/gh/session"),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.prMode).toBe(true);
        expect(body.owner).toBe("acme");
        expect(body.repo).toBe("widget");
        expect(body.pullNumber).toBe(1234);
        expect(body.title).toBe("A test PR");
        expect(body.existingComments).toHaveLength(1);
        expect(body.existingComments[0].body).toBe("pre-existing feedback");
        expect(body.existingReviews).toEqual([]);
    });

    it("GET /api/file-text loads PR base/head content instead of the local checkout", async () => {
        await prStore.set(baseSession);
        githubMocks.fetchPrFileContent
            .mockResolvedValueOnce(Buffer.from("old vue source"))
            .mockResolvedValueOnce(Buffer.from("new vue source"));

        const oldRes = await app.fetch(
            new Request(
                "http://localhost/api/file-text?path=src%2FOld.vue&version=old",
            ),
        );
        const newRes = await app.fetch(
            new Request(
                "http://localhost/api/file-text?path=src%2FNew.vue&version=new",
            ),
        );

        expect(await oldRes.json()).toEqual({
            content: "old vue source",
            missing: false,
            hash: createHash("sha256").update("old vue source").digest("hex"),
        });
        expect(await newRes.json()).toEqual({
            content: "new vue source",
            missing: false,
            hash: createHash("sha256").update("new vue source").digest("hex"),
        });
        expect(githubMocks.fetchPrFileContent).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ owner: "acme", repo: "widget" }),
            "src/Old.vue",
            "base",
        );
        expect(githubMocks.fetchPrFileContent).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ owner: "acme", repo: "widget" }),
            "src/New.vue",
            "head",
        );
    });

    it("GET /api/gh/avatar proxies only avatar URLs from the active session", async () => {
        const avatarUrl = "https://avatars.githubusercontent.com/u/1?v=4";
        await prStore.set({
            ...baseSession,
            existingReviews: [
                {
                    id: 7,
                    author: { login: "reviewer", avatarUrl },
                    body: "Looks good",
                    state: "APPROVED",
                    submittedAt: "2026-01-01T00:00:00.000Z",
                },
            ],
        });
        const remoteFetch = vi.fn().mockResolvedValue(
            new Response(new Uint8Array([1, 2, 3]), {
                headers: { "Content-Type": "image/png" },
            }),
        );
        vi.stubGlobal("fetch", remoteFetch);

        const res = await app.fetch(
            new Request(
                `http://localhost/api/gh/avatar?url=${encodeURIComponent(avatarUrl)}`,
            ),
        );

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([
            1, 2, 3,
        ]);
        expect(remoteFetch).toHaveBeenCalledWith(new URL(avatarUrl), {
            redirect: "error",
        });

        const forbidden = await app.fetch(
            new Request(
                `http://localhost/api/gh/avatar?url=${encodeURIComponent("http://127.0.0.1/private")}`,
            ),
        );
        expect(forbidden.status).toBe(403);
        expect(remoteFetch).toHaveBeenCalledTimes(1);
    });

    it("GET /api/gh/pr-session/comments returns the in-progress comments", async () => {
        await prStore.set({
            ...baseSession,
            comments: [
                {
                    id: "c1",
                    filePath: "src/x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "+ x",
                    body: "first",
                    status: "open",
                    createdAt: 1000,
                    replies: [],
                },
            ],
        });
        const res = await app.fetch(
            new Request("http://localhost/api/gh/pr-session/comments"),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveLength(1);
        expect(body[0].body).toBe("first");
    });

    it("POST /api/gh/pr-session/comments adds a comment to the session", async () => {
        await prStore.set(baseSession);
        const res = await app.fetch(
            new Request("http://localhost/api/gh/pr-session/comments", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filePath: "src/y.ts",
                    side: "additions",
                    lineNumber: 5,
                    lineContent: "+ y",
                    body: "second",
                }),
            }),
        );
        expect(res.status).toBe(201);
        const after = await prStore.get();
        expect(after?.comments).toHaveLength(1);
        expect(after?.comments[0].body).toBe("second");
    });

    it("PUT /api/gh/pr-session/comments/:id edits a comment", async () => {
        await prStore.set({
            ...baseSession,
            comments: [
                {
                    id: "c1",
                    filePath: "src/x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "",
                    body: "first",
                    status: "open",
                    createdAt: 1000,
                    replies: [],
                },
            ],
        });
        const res = await app.fetch(
            new Request("http://localhost/api/gh/pr-session/comments/c1", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ body: "edited" }),
            }),
        );
        expect(res.status).toBe(200);
        const after = await prStore.get();
        expect(after?.comments[0].body).toBe("edited");
    });

    it("DELETE /api/gh/pr-session/comments/:id removes a comment", async () => {
        await prStore.set({
            ...baseSession,
            comments: [
                {
                    id: "c1",
                    filePath: "src/x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "",
                    body: "first",
                    status: "open",
                    createdAt: 1000,
                    replies: [],
                },
            ],
        });
        const res = await app.fetch(
            new Request("http://localhost/api/gh/pr-session/comments/c1", {
                method: "DELETE",
            }),
        );
        expect(res.status).toBe(200);
        const after = await prStore.get();
        expect(after?.comments).toHaveLength(0);
    });

    it("POST /api/gh/pr-session/comments/:id/replies persists a visible reply", async () => {
        await prStore.set({
            ...baseSession,
            comments: [
                {
                    id: "c1",
                    filePath: "src/x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "+ x",
                    body: "first",
                    status: "open",
                    createdAt: 1000,
                    replies: [],
                },
            ],
        });
        const res = await app.fetch(
            new Request(
                "http://localhost/api/gh/pr-session/comments/c1/replies",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        body: "  follow-up  ",
                        role: "user",
                    }),
                },
            ),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.replies).toHaveLength(1);
        expect(body.replies[0].body).toBe("follow-up");
        expect((await prStore.get())?.comments[0].replies[0].body).toBe(
            "follow-up",
        );
    });

    it("POST /api/gh/pr-session/comments/:id/replies reports a missing comment", async () => {
        await prStore.set(baseSession);
        const res = await app.fetch(
            new Request(
                "http://localhost/api/gh/pr-session/comments/missing/replies",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ body: "follow-up" }),
                },
            ),
        );
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe("Comment not found");
    });

    it("GET /api/diff short-circuits in PR mode and exposes PR metadata", async () => {
        await prStore.set({
            ...baseSession,
            diff: "diff --git a/zzz b/zzz\n+hello\n",
        });
        const res = await app.fetch(new Request("http://localhost/api/diff"));
        const body = await res.json();
        expect(body.prMode).toBe(true);
        expect(body.prRef).toBe("1234");
        expect(body.prOwner).toBe("acme");
        expect(body.prRepo).toBe("widget");
        expect(body.prPullNumber).toBe(1234);
        expect(body.prUrl).toBe(
            "https://github.com/ahmedragab20/diffing/pull/1234",
        );
        expect(body.patch).toBe("diff --git a/zzz b/zzz\n+hello\n");
        expect(body.branch).toBe("#1234");
        // Phase 1 PR overview banner: derived entirely from pr-session fields,
        // no extra git / gh calls.
        expect(body.overview).toBeDefined();
        expect(body.overview.kind).toBe("pr");
        expect(body.overview.headline).toBe("PR #1234: A test PR");
        expect(body.overview.subtitle).toBe("by octocat · +10 / -5");
        expect(body.overview.prNumber).toBe(1234);
        expect(body.overview.prTitle).toBe("A test PR");
        expect(body.overview.authors).toEqual(["octocat"]);
    });

    it("PR overview handles a session with no author and zero diffs", async () => {
        await prStore.set({
            ...baseSession,
            author: null,
            additions: 0,
            deletions: 0,
            diff: "diff --git a/empty b/empty\n",
        });
        const res = await app.fetch(new Request("http://localhost/api/diff"));
        const body = await res.json();
        expect(body.overview.kind).toBe("pr");
        expect(body.overview.headline).toBe("PR #1234: A test PR");
        // No author, no diff counts → no subtitle line.
        expect(body.overview.subtitle).toBeUndefined();
        expect(body.overview.authors).toEqual([]);
    });

    it("mutating /api/gh/* routes 404 when no PR session; session probe is soft 200", async () => {
        // Soft probe stays 200 + prMode:false even with empty store.
        const sessionRes = await app.fetch(
            new Request("http://localhost/api/gh/session"),
        );
        expect(sessionRes.status).toBe(200);
        expect((await sessionRes.json()).prMode).toBe(false);

        const checks: Array<{ path: string; method: string }> = [
            { path: "/api/gh/pr-session/comments", method: "GET" },
            // /api/gh/submit is POST-only; we only assert it 404s when no session exists.
            { path: "/api/gh/submit", method: "POST" },
        ];
        for (const { path, method } of checks) {
            const res = await app.fetch(
                new Request(`http://localhost${path}`, {
                    method,
                    headers:
                        method === "POST"
                            ? { "Content-Type": "application/json" }
                            : undefined,
                    body:
                        method === "POST"
                            ? JSON.stringify({ decision: "comment" })
                            : undefined,
                }),
            );
            expect(res.status).toBe(404);
        }
    });

    it("POST /api/gh/submit dryRun returns payload without marking submitted", async () => {
        await prStore.set({
            ...baseSession,
            comments: [
                {
                    id: "c1",
                    filePath: "src/x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "+ x",
                    body: "nit",
                    status: "open",
                    createdAt: 1000,
                    replies: [],
                },
            ],
        });
        const res = await app.fetch(
            new Request("http://localhost/api/gh/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    decision: "comment",
                    body: "overall",
                    dryRun: true,
                }),
            }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.dryRun).toBe(true);
        expect(body.payload).toBeDefined();
        expect(body.payload.event).toBe("COMMENT");
        expect(body.payload.comments).toHaveLength(1);
        // Must not stamp submittedAt on a dry run.
        const after = await prStore.get();
        expect(after?.submittedAt).toBeUndefined();
    });

    it("successful submission promotes local drafts into GitHub-backed conversations", async () => {
        const published = {
            ...baseSession.existingComments[0],
            id: 501,
            body: "published feedback",
            threadId: "PRRT_thread",
            isResolved: false,
        };
        const publishedReview = {
            id: 55,
            author: { login: "reviewer" },
            body: "Approved again buddy@",
            state: "APPROVED",
            submittedAt: "2026-07-18T20:00:00.000Z",
        };
        githubMocks.fetchExistingComments.mockResolvedValue([published]);
        githubMocks.fetchExistingReviews.mockResolvedValue([publishedReview]);
        await prStore.set({
            ...baseSession,
            comments: [
                {
                    id: "c1",
                    filePath: "src/x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "+ x",
                    body: "published feedback",
                    status: "open",
                    createdAt: 1000,
                    replies: [],
                },
            ],
        });

        const res = await app.fetch(
            new Request("http://localhost/api/gh/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ decision: "comment", body: "" }),
            }),
        );

        expect(res.status).toBe(200);
        const after = await prStore.get();
        expect(after?.comments).toEqual([]);
        expect(after?.existingComments).toEqual([published]);
        expect(after?.existingReviews).toEqual([publishedReview]);
        expect(after?.submittedAt).toEqual(expect.any(Number));
        expect(after?.publication).toMatchObject({
            state: "confirmed",
            reviewId: 55,
            reviewUrl: "https://github.test/review/55",
            decision: "comment",
        });
    });

    it("PUT /api/gh/pr-session/review-draft persists overall body and verdict", async () => {
        await prStore.set(baseSession);
        const res = await app.fetch(
            new Request("http://localhost/api/gh/pr-session/review-draft", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    body: "Looks good overall",
                    decision: "approve",
                }),
            }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({
            ok: true,
            reviewBody: "Looks good overall",
            reviewDecision: "approve",
        });
        const after = await prStore.get();
        expect(after?.reviewBody).toBe("Looks good overall");
        expect(after?.reviewDecision).toBe("approve");
        const session = await app.fetch(
            new Request("http://localhost/api/gh/session"),
        );
        expect((await session.json()).reviewBody).toBe("Looks good overall");
    });

    it("failed submit persists a failed publication receipt and keeps drafts", async () => {
        githubMocks.submitReview.mockResolvedValue({
            ok: false,
            error: "GitHub 502",
            authSource: "gh",
        });
        await prStore.set({
            ...baseSession,
            comments: [
                {
                    id: "c1",
                    filePath: "src/x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "+ x",
                    body: "nit",
                    status: "open",
                    createdAt: 1000,
                    replies: [],
                },
            ],
        });
        const res = await app.fetch(
            new Request("http://localhost/api/gh/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ decision: "comment", body: "overall" }),
            }),
        );
        expect(res.status).toBe(502);
        const after = await prStore.get();
        expect(after?.comments).toHaveLength(1);
        expect(after?.publication).toMatchObject({
            state: "failed",
            error: "GitHub 502",
            decision: "comment",
            body: "overall",
        });
        expect(after?.submittedAt).toBeUndefined();
    });

    it("submit without a review id persists an unknown publication receipt", async () => {
        githubMocks.submitReview.mockResolvedValue({
            ok: true,
            authSource: "gh",
        });
        await prStore.set(baseSession);
        const res = await app.fetch(
            new Request("http://localhost/api/gh/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ decision: "comment", body: "overall" }),
            }),
        );
        expect(res.status).toBe(200);
        expect((await prStore.get())?.publication).toMatchObject({
            state: "unknown",
            decision: "comment",
            body: "overall",
        });
    });

    it("shows the overall review note immediately while GitHub review history is still catching up", async () => {
        githubMocks.fetchExistingReviews.mockResolvedValue([]);
        await prStore.set(baseSession);

        const res = await app.fetch(
            new Request("http://localhost/api/gh/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    decision: "approve",
                    body: "Approved again buddy@",
                }),
            }),
        );

        expect(res.status).toBe(200);
        expect((await prStore.get())?.existingReviews?.[0]).toMatchObject({
            id: 55,
            body: "Approved again buddy@",
            state: "APPROVED",
            htmlUrl: "https://github.test/review/55",
        });
    });

    it("GET /api/gh/overview returns slim counts without embedding thread bodies", async () => {
        await prStore.set({
            ...baseSession,
            existingComments: [
                { ...baseSession.existingComments[0], isResolved: false },
                {
                    ...baseSession.existingComments[0],
                    id: 1000,
                    body: "resolved one",
                    isResolved: true,
                },
            ],
            existingReviews: [
                {
                    id: 1,
                    author: { login: "r" },
                    body: "LGTM later",
                    state: "COMMENTED",
                    submittedAt: "2026-01-01T00:00:00.000Z",
                },
            ],
        });
        const res = await app.fetch(
            new Request("http://localhost/api/gh/overview"),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.prMode).toBe(true);
        expect(body.counts.publishedThreads).toBe(2);
        expect(body.counts.unresolvedThreads).toBe(1);
        expect(body.counts.reviews).toBe(1);
        expect(JSON.stringify(body)).not.toContain("pre-existing feedback");
    });

    it("GET /api/gh/threads returns paged XML for agents", async () => {
        await prStore.set({
            ...baseSession,
            existingComments: [
                {
                    ...baseSession.existingComments[0],
                    isResolved: false,
                    threadId: "PRRT_x",
                },
            ],
        });
        const res = await app.fetch(
            new Request(
                "http://localhost/api/gh/threads?unresolvedOnly=true&format=xml",
            ),
        );
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain("<pr-review-threads");
        expect(text).toContain("pre-existing feedback");
        expect(text).toContain('resolved="false"');
    });

    it("GET /api/gh/threads and reviews filter and paginate JSON", async () => {
        await prStore.set({
            ...baseSession,
            existingComments: [
                {
                    ...baseSession.existingComments[0],
                    id: 10,
                    isResolved: false,
                },
                {
                    ...baseSession.existingComments[0],
                    id: 11,
                    path: "src/other.ts",
                    author: { login: "someone-else" },
                    isResolved: false,
                },
            ],
            existingReviews: [
                {
                    id: 20,
                    author: { login: "reviewer" },
                    body: "Needs work",
                    state: "CHANGES_REQUESTED",
                    submittedAt: "2026-01-01T00:00:00.000Z",
                },
                {
                    id: 21,
                    author: { login: "approver" },
                    body: "Looks good",
                    state: "APPROVED",
                    submittedAt: "2026-01-02T00:00:00.000Z",
                },
            ],
        });

        const threadsRes = await app.fetch(
            new Request(
                "http://localhost/api/gh/threads?author=reviewer&limit=1&bodyMaxChars=5",
            ),
        );
        const threads = await threadsRes.json();
        expect(threads).toMatchObject({
            returned: 1,
            total: 1,
            nextCursor: null,
        });
        expect(threads.threads[0]).toMatchObject({
            id: 10,
            bodyTruncated: true,
        });

        const reviewsRes = await app.fetch(
            new Request(
                "http://localhost/api/gh/reviews?state=changes_requested&limit=1",
            ),
        );
        const reviews = await reviewsRes.json();
        expect(reviews).toMatchObject({
            returned: 1,
            total: 1,
            nextCursor: null,
        });
        expect(reviews.reviews[0].id).toBe(20);
    });

    it("GET /api/diff/summary and slice work for PR mode without full patch transfer", async () => {
        await prStore.set({
            ...baseSession,
            diff: `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
 line
+added
`,
        });
        const summaryRes = await app.fetch(
            new Request("http://localhost/api/diff/summary"),
        );
        expect(summaryRes.status).toBe(200);
        const summary = await summaryRes.json();
        expect(summary.files).toBe(1);
        expect(summary.complete).toBe(true);
        expect(typeof summary.generation).toBe("number");
        expect(summary).toMatchObject({
            prMode: true,
            owner: baseSession.owner,
            repo: baseSession.repo,
            pullNumber: baseSession.pullNumber,
            headSha: baseSession.headSha,
        });

        const filesRes = await app.fetch(
            new Request("http://localhost/api/diff/files"),
        );
        const files = await filesRes.json();
        expect(files.files[0].path).toBe("src/a.ts");

        const sliceRes = await app.fetch(
            new Request(
                `http://localhost/api/diff/slice?file=0&start=0&maxLines=20&generation=${summary.generation}`,
            ),
        );
        expect(sliceRes.status).toBe(200);
        const slice = await sliceRes.json();
        expect(slice.rows[0].type).toBe("fileHeader");
        expect(
            slice.rows.some((r: any) => r.type === "line" && r.kind === "add"),
        ).toBe(true);
    });

    it("POST /api/gh/pr-session/comments accepts severity", async () => {
        await prStore.set(baseSession);
        const res = await app.fetch(
            new Request("http://localhost/api/gh/pr-session/comments", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filePath: "src/a.ts",
                    side: "additions",
                    lineNumber: 2,
                    lineContent: "+added",
                    body: "blocking concern",
                    severity: "blocking",
                }),
            }),
        );
        expect(res.status).toBe(201);
        const comment = await res.json();
        expect(comment.severity).toBe("blocking");
        const stored = await prStore.get();
        expect(stored?.comments[0].severity).toBe("blocking");
    });

    it("published comment actions update GitHub and refresh cached conversations", async () => {
        const synced = [
            {
                ...baseSession.existingComments[0],
                body: "edited",
                isResolved: true,
            },
        ];
        githubMocks.fetchExistingComments.mockResolvedValue(synced);
        await prStore.set(baseSession);

        const edit = await app.fetch(
            new Request("http://localhost/api/gh/existing-comments/999", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ body: "edited" }),
            }),
        );
        expect(edit.status).toBe(200);
        expect(githubMocks.updateComment).toHaveBeenCalledWith(
            expect.objectContaining({ commentId: 999, body: "edited" }),
        );
        expect((await prStore.get())?.existingComments).toEqual(synced);

        const resolve = await app.fetch(
            new Request("http://localhost/api/gh/review-threads/PRRT_thread", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ resolved: true }),
            }),
        );
        expect(resolve.status).toBe(200);
        expect(githubMocks.setThreadResolved).toHaveBeenCalledWith({
            threadId: "PRRT_thread",
            resolved: true,
        });

        const remove = await app.fetch(
            new Request("http://localhost/api/gh/existing-comments/999", {
                method: "DELETE",
            }),
        );
        expect(remove.status).toBe(200);
        expect(githubMocks.deleteComment).toHaveBeenCalledWith(
            expect.objectContaining({ commentId: 999 }),
        );
    });

    it("review sync hydrates overall reviews, removes published drafts, and preserves newer drafts", async () => {
        githubMocks.fetchExistingComments.mockResolvedValue(
            baseSession.existingComments,
        );
        githubMocks.fetchExistingReviews.mockResolvedValue([
            {
                id: 77,
                author: { login: "reviewer" },
                body: "Overall approval note",
                state: "APPROVED",
                submittedAt: "2026-07-18T20:00:00.000Z",
            },
        ]);
        await prStore.set({
            ...baseSession,
            submittedAt: 2000,
            comments: [
                {
                    id: "published-local",
                    filePath: "src/old.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "+ old",
                    body: "already published",
                    status: "open",
                    createdAt: 1000,
                    replies: [],
                },
                {
                    id: "new-draft",
                    filePath: "src/new.ts",
                    side: "additions",
                    lineNumber: 2,
                    lineContent: "+ new",
                    body: "new review draft",
                    status: "open",
                    createdAt: 3000,
                    replies: [],
                },
            ],
        });

        const res = await app.fetch(
            new Request("http://localhost/api/gh/comments/sync", {
                method: "POST",
            }),
        );
        expect(res.status).toBe(200);
        const synced = await prStore.get();
        expect(synced?.comments.map((comment) => comment.id)).toEqual([
            "new-draft",
        ]);
        expect(synced?.existingReviews?.[0].body).toBe("Overall approval note");
    });

    it("PUT /api/gh/pr-session/comments/:id can resolve a draft comment locally", async () => {
        await prStore.set({
            ...baseSession,
            comments: [
                {
                    id: "c1",
                    filePath: "src/x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "",
                    body: "first",
                    status: "open",
                    createdAt: 1000,
                    replies: [],
                },
            ],
        });
        const res = await app.fetch(
            new Request("http://localhost/api/gh/pr-session/comments/c1", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "resolved" }),
            }),
        );
        expect(res.status).toBe(200);
        const after = await prStore.get();
        expect(after?.comments[0].status).toBe("resolved");
    });

    it("GET /api/gh/session includes stored branch names", async () => {
        await prStore.set({
            ...baseSession,
            headRefName: "topic",
            baseRefName: "main",
        });
        const body = await (
            await app.fetch(new Request("http://localhost/api/gh/session"))
        ).json();
        expect(body.headRefName).toBe("topic");
        expect(body.baseRefName).toBe("main");
    });

    it("concurrent draft POSTs both persist", async () => {
        await prStore.set(baseSession);
        const post = (body: string) =>
            app.fetch(
                new Request("http://localhost/api/gh/pr-session/comments", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        filePath: "x.ts",
                        side: "additions",
                        lineNumber: 1,
                        lineContent: "x",
                        body,
                    }),
                }),
            );
        const responses = await Promise.all([post("first"), post("second")]);
        expect(responses.map((res) => res.status)).toEqual([201, 201]);
        const saved =
            (await prStore.get())?.comments.map((comment) => comment.body) ??
            [];
        expect(saved.sort()).toEqual(["first", "second"]);
    });

    it("keeps last-known threads when comment sync fetch fails", async () => {
        await prStore.set(baseSession);
        githubMocks.fetchExistingComments.mockRejectedValue(
            new Error("outage"),
        );
        const res = await app.fetch(
            new Request("http://localhost/api/gh/comments/sync", {
                method: "POST",
            }),
        );
        expect(res.status).toBe(502);
        expect((await prStore.get())?.existingComments).toHaveLength(1);
    });

    it("comment-only sync does not re-download the patch", async () => {
        await prStore.set(baseSession);
        githubMocks.fetchExistingComments.mockResolvedValue(
            baseSession.existingComments,
        );
        githubMocks.fetchExistingReviews.mockResolvedValue([]);
        const res = await app.fetch(
            new Request("http://localhost/api/gh/comments/sync", {
                method: "POST",
            }),
        );
        expect(res.status).toBe(200);
        expect(githubMocks.refreshPrSession).not.toHaveBeenCalled();
        expect(githubMocks.fetchExistingComments).toHaveBeenCalled();
        expect(githubMocks.fetchExistingReviews).toHaveBeenCalled();
        expect((await res.json()).count).toBe(1);
    });

    it("coalesces concurrent submits into one GitHub POST", async () => {
        await prStore.set({
            ...baseSession,
            comments: [
                {
                    id: "c1",
                    filePath: "src/x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "+ x",
                    body: "nit",
                    status: "open",
                    createdAt: 1000,
                    replies: [],
                },
            ],
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        githubMocks.submitReview.mockImplementation(async () => {
            await gate;
            return {
                ok: true,
                reviewId: 55,
                reviewUrl: "https://github.test/review/55",
                authSource: "gh",
            };
        });
        const submit = () =>
            app.fetch(
                new Request("http://localhost/api/gh/submit", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        decision: "comment",
                        body: "overall",
                    }),
                }),
            );
        const first = submit();
        const second = submit();
        await Promise.resolve();
        release();
        const statuses = await Promise.all([first, second]);
        expect(statuses.map((res) => res.status)).toEqual([200, 200]);
        expect(githubMocks.submitReview).toHaveBeenCalledTimes(1);
        expect(githubMocks.submitReview.mock.calls[0][0].commitId).toBe("head");
    });

    it("refresh keeps drafts created while GitHub metadata is in flight", async () => {
        await prStore.set({
            ...baseSession,
            comments: [
                {
                    id: "original",
                    filePath: "x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "x",
                    body: "original",
                    status: "open",
                    createdAt: 1,
                    replies: [],
                },
            ],
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        githubMocks.refreshPrSession.mockImplementation(async (session) => {
            await gate;
            return { ...session, headSha: "new-head" };
        });
        const refresh = app.fetch(
            new Request("http://localhost/api/gh/pr/refresh", {
                method: "POST",
            }),
        );
        await Promise.resolve();
        await app.fetch(
            new Request("http://localhost/api/gh/pr-session/comments", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filePath: "x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "x",
                    body: "created-while-waiting",
                }),
            }),
        );
        release();
        expect((await refresh).status).toBe(200);
        const bodies =
            (await prStore.get())?.comments.map((comment) => comment.body) ??
            [];
        expect(bodies).toContain("created-while-waiting");
    });

    it("submit keeps drafts created after the outgoing payload was captured", async () => {
        await prStore.set({
            ...baseSession,
            comments: [
                {
                    id: "original",
                    filePath: "x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "x",
                    body: "original",
                    status: "open",
                    createdAt: 1,
                    replies: [],
                },
            ],
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        githubMocks.submitReview.mockImplementation(async () => {
            await gate;
            return {
                ok: true,
                reviewId: 55,
                reviewUrl: "https://github.test/review/55",
                authSource: "gh",
            };
        });
        const submit = app.fetch(
            new Request("http://localhost/api/gh/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ decision: "comment", body: "review" }),
            }),
        );
        await Promise.resolve();
        await app.fetch(
            new Request("http://localhost/api/gh/pr-session/comments", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filePath: "x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "x",
                    body: "created-while-submitting",
                }),
            }),
        );
        release();
        expect((await submit).status).toBe(200);
        const bodies =
            (await prStore.get())?.comments.map((comment) => comment.body) ??
            [];
        expect(bodies).toEqual(["created-while-submitting"]);
    });

    it("GET /api/file-text uses mergeBaseSha for the old version", async () => {
        await prStore.set({ ...baseSession, mergeBaseSha: "merge-base" });
        githubMocks.fetchPrFileContent.mockResolvedValue(Buffer.from("old"));
        await app.fetch(
            new Request(
                "http://localhost/api/file-text?path=src%2Fx.ts&version=old",
            ),
        );
        expect(githubMocks.fetchPrFileContent).toHaveBeenCalledWith(
            expect.objectContaining({ owner: "acme", repo: "widget" }),
            "src/x.ts",
            "merge-base",
        );
    });
});
