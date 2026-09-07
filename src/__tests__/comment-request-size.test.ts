// @vitest-environment node
// In-memory checks for declared and streamed comment request-size limits.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Hono } from "hono";
import { InMemoryCommentStore } from "../lib/comments.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: vi.fn(() => ({ unref() {} })),
  };
});

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

/** 1 MiB + 1 ASCII characters: exactly over the request-size ceiling. */
const OVERSIZE_FILLER = "a".repeat(1024 * 1024 + 1);

async function makeApp(): Promise<{ app: Hono; store: InMemoryCommentStore }> {
  const { createApp } = await import("../server.js");
  const { DEFAULTS } = await import("../lib/diff-options.js");
  const store = new InMemoryCommentStore();
  const app = createApp("/unused-client", DEFAULTS, store);
  return { app, store };
}

const BASE = "http://localhost";

async function listComments(app: Hono): Promise<unknown[]> {
  const res = await app.fetch(new Request(`${BASE}/api/comments`));
  expect(res.status).toBe(200);
  return (await res.json()) as unknown[];
}

describe("POST /api/comments request size", () => {
  let app: Hono;

  beforeEach(async () => {
    app = (await makeApp()).app;
  });

  it("rejects a valid comment plus a 1MiB+1 filler field with 413 and an empty store", async () => {
    const payload = { ...VALID_CREATE, filler: OVERSIZE_FILLER };
    const res = await app.fetch(
      new Request(`${BASE}/api/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    expect(res.status).toBe(413);
    expect(await listComments(app)).toHaveLength(0);
  });

  it("rejects a request that declares an oversized Content-Length with 413 and an empty store", async () => {
    const request = new Request(`${BASE}/api/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(1024 * 1024 + 1),
      },
      body: JSON.stringify(VALID_CREATE),
    });
    expect(request.headers.get("content-length")).toBe(String(1024 * 1024 + 1));
    const res = await app.fetch(request);
    expect(res.status).toBe(413);
    expect(await listComments(app)).toHaveLength(0);
  });

  it("still accepts a small valid comment with 201", async () => {
    const res = await app.fetch(
      new Request(`${BASE}/api/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_CREATE),
      }),
    );
    expect(res.status).toBe(201);
    expect(await listComments(app)).toHaveLength(1);
  });
});
