// @vitest-environment node
// In-memory HTTP validation tests for the /api/comments endpoints: each test
// injects a fresh InMemoryCommentStore and mocks fs/git so no real state is touched.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Hono } from "hono";
import { InMemoryCommentStore } from "../lib/comments.js";
import type { ReviewComment } from "../lib/types.js";

// Partially mock node:fs: keep every real export, only replace `watch` so
// createApp's repo/storage watchers get a disposable handle.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: vi.fn(() => ({ unref() {} })),
  };
});

// Mock repo I/O so createApp never touches the real git repo or storage dir.
vi.mock("../lib/git.js", () => ({
  getFileContent: vi.fn(() => ""),
  getRepoRoot: vi.fn(() => "/tmp/test-repo"),
  getProjectStorageDir: vi.fn(() => "/tmp/test-project-storage"),
  getMergeStatus: vi.fn(() => ({})),
  gitAddFile: vi.fn(),
  listRepoFiles: vi.fn(() => []),
  revertHunk: vi.fn(),
  getHunkHistory: vi.fn(() => []),
}));

vi.mock("../lib/settings.js", () => ({
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn((s: unknown) => s),
}));

vi.mock("../lib/path.js", () => ({
  isSafePath: vi.fn(() => true),
  toSafeRelativePath: vi.fn((p: string) => p),
}));

const VALID_CREATE = {
  filePath: "src/file.ts",
  side: "additions",
  lineNumber: 2,
  lineContent: "const value = 1",
  body: "Review this",
};

async function makeApp(): Promise<{ app: Hono; store: InMemoryCommentStore }> {
  const { createApp } = await import("../server.js");
  const { DEFAULTS } = await import("../lib/diff-options.js");
  const store = new InMemoryCommentStore();
  const app = createApp("/unused-client", DEFAULTS, store);
  return { app, store };
}

const BASE = "http://localhost";

async function postJson(
  app: Hono,
  url: string,
  payload: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`${BASE}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }),
  );
}

async function putJson(
  app: Hono,
  url: string,
  payload: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`${BASE}${url}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

async function listComments(app: Hono): Promise<ReviewComment[]> {
  const res = await app.fetch(new Request(`${BASE}/api/comments`));
  expect(res.status).toBe(200);
  return (await res.json()) as ReviewComment[];
}

/** A valid POST that must round-trip through the store and return 201. */
async function seedValidComment(app: Hono): Promise<ReviewComment> {
  const res = await postJson(app, "/api/comments", VALID_CREATE);
  expect(res.status).toBe(201);
  return (await res.json()) as ReviewComment;
}

describe("POST /api/comments validation", () => {
  let app: Hono;

  beforeEach(async () => {
    app = (await makeApp()).app;
  });

  it("accepts a fully valid inline comment and preserves body/context", async () => {
    const created = await seedValidComment(app);
    expect(created.filePath).toBe("src/file.ts");
    expect(created.side).toBe("additions");
    expect(created.lineNumber).toBe(2);
    expect(created.lineContent).toBe("const value = 1");
    expect(created.body).toBe("Review this");
    expect(created.status).toBe("open");

    const comments = await listComments(app);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      filePath: "src/file.ts",
      side: "additions",
      lineNumber: 2,
      lineContent: "const value = 1",
      body: "Review this",
    });
  });

  it("accepts a valid line range comment (startLineNumber 1 / lineNumber 2)", async () => {
    const res = await postJson(app, "/api/comments", {
      ...VALID_CREATE,
      startLineNumber: 1,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as ReviewComment;
    expect(created.startLineNumber).toBe(1);
    expect(created.lineNumber).toBe(2);

    const comments = await listComments(app);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ startLineNumber: 1, lineNumber: 2 });
  });

  it("accepts a file-level comment (lineNumber 0) and preserves it", async () => {
    const res = await postJson(app, "/api/comments", {
      ...VALID_CREATE,
      lineNumber: 0,
      lineContent: undefined,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as ReviewComment;
    expect(created.lineNumber).toBe(0);
    expect(created.body).toBe("Review this");

    const comments = await listComments(app);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ lineNumber: 0 });
  });

  it("does not reject a comment that is missing only lineContent (legacy compatibility)", async () => {
    const { lineContent: _omitted, ...payload } = VALID_CREATE;
    const res = await postJson(app, "/api/comments", payload);
    // Legacy clients omit lineContent; this must be accepted.
    expect(res.status).toBe(201);
  });

  describe.each([
    {
      name: "only side provided",
      payload: { side: "additions" },
    },
    {
      name: "missing filePath, lineNumber and body",
      payload: { side: "additions", lineContent: "const value = 1" },
    },
    {
      name: "missing filePath",
      payload: {
        side: "additions",
        lineNumber: 2,
        lineContent: "const value = 1",
        body: "Review this",
      },
    },
    {
      name: "missing lineNumber",
      payload: {
        filePath: "src/file.ts",
        side: "additions",
        lineContent: "const value = 1",
        body: "Review this",
      },
    },
    {
      name: "missing body",
      payload: {
        filePath: "src/file.ts",
        side: "additions",
        lineNumber: 2,
        lineContent: "const value = 1",
      },
    },
    {
      name: "empty string filePath",
      payload: { ...VALID_CREATE, filePath: "" },
    },
    {
      name: "non-string filePath",
      payload: { ...VALID_CREATE, filePath: 42 },
    },
    {
      name: "empty string body",
      payload: { ...VALID_CREATE, body: "" },
    },
    {
      name: "non-string body",
      payload: { ...VALID_CREATE, body: 123 },
    },
    {
      name: "invalid side",
      payload: { ...VALID_CREATE, side: "both" },
    },
    {
      name: "negative lineNumber",
      payload: { ...VALID_CREATE, lineNumber: -1 },
    },
    {
      name: "fractional lineNumber",
      payload: { ...VALID_CREATE, lineNumber: 2.5 },
    },
    {
      name: "non-number lineNumber",
      payload: { ...VALID_CREATE, lineNumber: "2" },
    },
    {
      name: "startLineNumber greater than lineNumber",
      payload: { ...VALID_CREATE, startLineNumber: 3 },
    },
    {
      name: "startLineNumber 0",
      payload: { ...VALID_CREATE, startLineNumber: 0 },
    },
    {
      name: "startLineNumber on a file-level (lineNumber 0) comment",
      payload: { ...VALID_CREATE, lineNumber: 0, startLineNumber: 1 },
    },
    {
      name: "non-string lineContent",
      payload: { ...VALID_CREATE, lineContent: 42 },
    },
    {
      name: "body of 65537 ASCII characters",
      payload: { ...VALID_CREATE, body: "a".repeat(65537) },
    },
  ])("rejects: $name", ({ payload }) => {
    it("returns 400 and the store stays empty", async () => {
      const res = await postJson(app, "/api/comments", payload);
      expect(res.status).toBe(400);
      expect(await listComments(app)).toEqual([]);
    });
  });

  it("rejects malformed JSON with 400 and the store stays empty", async () => {
    const res = await postJson(app, "/api/comments", "{not json");
    expect(res.status).toBe(400);
    expect(await listComments(app)).toEqual([]);
  });
});

describe("PUT /api/comments/:id validation", () => {
  let app: Hono;
  let commentId: string;
  let original: ReviewComment;

  beforeEach(async () => {
    app = (await makeApp()).app;
    original = await seedValidComment(app);
    commentId = original.id;
  });

  const expectUnchanged = async () => {
    const comments = await listComments(app);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      id: commentId,
      body: "Review this",
      status: "open",
    });
  };

  it("rejects an empty-string body with 400 and leaves the comment unchanged", async () => {
    const res = await putJson(app, `/api/comments/${commentId}`, { body: "" });
    expect(res.status).toBe(400);
    await expectUnchanged();
  });

  it("rejects a non-string body with 400 and leaves the comment unchanged", async () => {
    const res = await putJson(app, `/api/comments/${commentId}`, { body: 42 });
    expect(res.status).toBe(400);
    await expectUnchanged();
  });

  it("rejects an invalid status with 400 and leaves the comment unchanged", async () => {
    const res = await putJson(app, `/api/comments/${commentId}`, {
      status: "archived",
    });
    expect(res.status).toBe(400);
    await expectUnchanged();
  });

  it("rejects an empty update (no body, no status) with 400 and leaves the comment unchanged", async () => {
    const res = await putJson(app, `/api/comments/${commentId}`, {});
    expect(res.status).toBe(400);
    await expectUnchanged();
  });

  it("applies a valid body update", async () => {
    const res = await putJson(app, `/api/comments/${commentId}`, {
      body: "Updated review note",
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as ReviewComment;
    expect(updated.body).toBe("Updated review note");
    expect(updated.status).toBe("open");
  });

  it("applies a valid status update", async () => {
    const res = await putJson(app, `/api/comments/${commentId}`, {
      status: "resolved",
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as ReviewComment;
    expect(updated.status).toBe("resolved");
    expect(updated.body).toBe("Review this");
  });

  it("returns 404 for a valid update to an absent comment", async () => {
    const res = await putJson(app, "/api/comments/does-not-exist", {
      body: "Updated review note",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/comments/:id/replies validation", () => {
  let app: Hono;
  let commentId: string;

  beforeEach(async () => {
    app = (await makeApp()).app;
    const seeded = await seedValidComment(app);
    commentId = seeded.id;
  });

  const expectNoReplies = async () => {
    const comments = await listComments(app);
    expect(comments).toHaveLength(1);
    expect(comments[0].replies).toEqual([]);
  };

  it.each([
    { name: "missing body", payload: {} },
    { name: "blank body", payload: { body: "" } },
    { name: "non-string body", payload: { body: 42 } },
    { name: "invalid role", payload: { body: "hello", role: "robot" } },
    { name: "non-string model", payload: { body: "hello", model: 42 } },
  ])("rejects a reply with $name", async ({ payload }) => {
    const res = await postJson(
      app,
      `/api/comments/${commentId}/replies`,
      payload,
    );
    expect(res.status).toBe(400);
    await expectNoReplies();
  });

  it("accepts a valid user reply", async () => {
    const res = await postJson(app, `/api/comments/${commentId}/replies`, {
      body: "user note",
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as ReviewComment;
    expect(updated.replies).toHaveLength(1);
    expect(updated.replies[0]).toMatchObject({
      body: "user note",
      role: "user",
    });
  });

  it("accepts a valid agent reply carrying a model", async () => {
    const res = await postJson(app, `/api/comments/${commentId}/replies`, {
      body: "agent note",
      model: "gpt-5.6-sol",
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as ReviewComment;
    expect(updated.replies).toHaveLength(1);
    expect(updated.replies[0]).toMatchObject({
      body: "agent note",
      role: "agent",
      model: "gpt-5.6-sol",
    });
  });

  it("returns 404 for a valid reply to an absent comment", async () => {
    const res = await postJson(app, "/api/comments/does-not-exist/replies", {
      body: "user note",
    });
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/comments/:id/replies/:replyId validation", () => {
  let app: Hono;
  let commentId: string;
  let replyId: string;
  let originalBody: string;

  beforeEach(async () => {
    app = (await makeApp()).app;
    const seeded = await seedValidComment(app);
    commentId = seeded.id;
    const res = await postJson(app, `/api/comments/${commentId}/replies`, {
      body: "original reply",
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as ReviewComment;
    replyId = updated.replies[0].id;
    originalBody = updated.replies[0].body;
  });

  const expectReplyUnchanged = async () => {
    const comments = await listComments(app);
    expect(comments).toHaveLength(1);
    const replies = comments[0].replies;
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toBe(originalBody);
  };

  it("rejects a blank body with 400 and preserves the original reply", async () => {
    const res = await putJson(
      app,
      `/api/comments/${commentId}/replies/${replyId}`,
      { body: "" },
    );
    expect(res.status).toBe(400);
    await expectReplyUnchanged();
  });

  it("rejects a non-string body with 400 and preserves the original reply", async () => {
    const res = await putJson(
      app,
      `/api/comments/${commentId}/replies/${replyId}`,
      { body: 42 },
    );
    expect(res.status).toBe(400);
    await expectReplyUnchanged();
  });

  it("applies a valid body update to the reply", async () => {
    const res = await putJson(
      app,
      `/api/comments/${commentId}/replies/${replyId}`,
      { body: "edited reply" },
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as ReviewComment;
    expect(updated.replies[0].body).toBe("edited reply");
  });
});
