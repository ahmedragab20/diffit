// @vitest-environment node
// Isolated HTTP regressions for the native file routes (/api/save-file,
// /api/edit-save, /api/comments/:id/apply-suggestion, /api/file-content,
// /api/file-text). Git/settings/fs are mocked per comment-validation.test.ts;
// lib/path.ts stays REAL. The native fs client is a partial mock: the real
// NativeFsError mapping is retained, only getNativeRepositoryFs is overridden
// with read/write spies — no real I/O, programs, network, or state.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Hono } from "hono";
import { createHash } from "node:crypto";
import { InMemoryCommentStore } from "../lib/comments.js";
import type { ReviewComment } from "../lib/types.js";
import { MAX_FILE_REQUEST_BYTES } from "../lib/file-schema.js";
import { NativeFsError } from "../lib/native-fs.js";

// ── Hoisted spies ────────────────────────────────────────────────────────────
const spies = vi.hoisted(() => {
  const read = vi.fn();
  const write = vi.fn();
  return {
    read,
    write,
    /** One shared fake client handle returned for every repo root. */
    nativeFs: { read, write },
    gitAddFile: vi.fn(),
    getFileContent: vi.fn(),
  };
});

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
  getFileContent: spies.getFileContent,
  getRepoRoot: vi.fn(() => "/tmp/test-repo"),
  getProjectStorageDir: vi.fn(() => "/tmp/test-project-storage"),
  getMergeStatus: vi.fn(() => ({})),
  gitAddFile: spies.gitAddFile,
  listRepoFiles: vi.fn(() => []),
  revertHunk: vi.fn(),
  getHunkHistory: vi.fn(() => []),
}));

vi.mock("../lib/settings.js", () => ({
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn((s: unknown) => s),
}));

// Partial mock of the native fs module: keep the REAL NativeFsError (its
// code→status mapping and outcomeUnknown flag) and everything else; only
// getNativeRepositoryFs is overridden to hand back the spies. The constructor
// shape (code, outcomeUnknown) is never guessed from errno/message.
vi.mock("../lib/native-fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/native-fs.js")>();
  return {
    ...actual,
    getNativeRepositoryFs: vi.fn(() => spies.nativeFs),
  };
});

// lib/path.ts is intentionally NOT mocked — literal-path handling
// (toSafeLiteralRelativePath) must behave exactly as in production.

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const OLD = Buffer.from("old\n");
const OLD_SHA = hash(OLD);
const NEW = Buffer.from("new\n");
const NEW_SHA = hash(NEW);

/** Default read result: existing on-disk bytes + their hash. */
const READ_RESULT = { bytes: OLD, sha256: OLD_SHA };

async function makeApp(
  diffOptsOverrides?: Record<string, unknown>,
  prMode = false,
): Promise<{ app: Hono; store: InMemoryCommentStore }> {
  const { createApp } = await import("../server.js");
  const { DEFAULTS } = await import("../lib/diff-options.js");
  const store = new InMemoryCommentStore();
  const app = createApp(
    "/unused-client",
    { ...DEFAULTS, ...diffOptsOverrides },
    store,
    undefined,
    undefined,
    prMode,
  );
  return { app, store };
}

const BASE = "http://localhost";

async function postJson(
  app: Hono,
  url: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request(`${BASE}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }),
  );
}

async function get(app: Hono, url: string): Promise<Response> {
  return app.fetch(new Request(`${BASE}${url}`));
}

async function listComments(app: Hono): Promise<ReviewComment[]> {
  const res = await get(app, "/api/comments");
  expect(res.status).toBe(200);
  return (await res.json()) as ReviewComment[];
}

/** Seed the typed suggestion comment exactly as the store would hold it. */
async function seedSuggestionComment(
  store: InMemoryCommentStore,
): Promise<void> {
  const comment: ReviewComment = {
    id: "c1",
    filePath: "a.txt",
    side: "additions",
    lineNumber: 1,
    lineContent: "old",
    body: "```suggestion\nnew\n```",
    status: "open",
    replies: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z").getTime(),
  };
  await store.add(comment);
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.getFileContent.mockReset();
  // Default native behaviour: reading an existing file succeeds; writes echo
  // the hash/size of exactly the bytes the caller handed over.
  spies.read.mockResolvedValue(READ_RESULT);
  spies.write.mockImplementation(async (_path: string, bytes: Buffer) => ({
    sha256: hash(bytes),
    size: bytes.length,
  }));
  spies.gitAddFile.mockReturnValue(undefined);
});

describe("POST /api/save-file", () => {
  let app: Hono;

  beforeEach(async () => {
    app = (await makeApp()).app;
  });

  it("writes a valid save through the native client with the unchanged literal path", async () => {
    const res = await postJson(app, "/api/save-file", {
      filePath: "literal%2fname.txt",
      content: "new\n",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(spies.write).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenBytes] = spies.write.mock.calls[0];
    // The literal path must survive untouched (no URL decoding, no rename).
    expect(writtenPath).toBe("literal%2fname.txt");
    expect(Buffer.isBuffer(writtenBytes)).toBe(true);
    expect((writtenBytes as Buffer).toString("utf8")).toBe("new\n");
    expect(spies.gitAddFile).not.toHaveBeenCalled();
  });

  describe.each([
    {
      name: "non-string filePath",
      payload: { filePath: 42, content: "new\n" },
    },
    {
      name: "empty-string filePath",
      payload: { filePath: "", content: "new\n" },
    },
    {
      name: "non-string content",
      payload: { filePath: "a.txt", content: 123 },
    },
    {
      name: "non-boolean gitAdd",
      payload: { filePath: "a.txt", content: "new\n", gitAdd: "yes" },
    },
  ])("rejects: $name", ({ payload }) => {
    it("returns 400 and the native client is never called", async () => {
      const res = await postJson(app, "/api/save-file", payload);
      expect(res.status).toBe(400);
      expect(spies.write).not.toHaveBeenCalled();
      expect(spies.read).not.toHaveBeenCalled();
    });
  });

  it("rejects malformed JSON with 400 and no write", async () => {
    const res = await postJson(app, "/api/save-file", "{not json");
    expect(res.status).toBe(400);
    expect(spies.write).not.toHaveBeenCalled();
  });

  it("rejects a null body with 400 and no write", async () => {
    const res = await postJson(app, "/api/save-file", null);
    expect(res.status).toBe(400);
    expect(spies.write).not.toHaveBeenCalled();
  });

  it("still reports ok:true with a gitAddError string when gitAddFile throws after a successful write", async () => {
    spies.gitAddFile.mockImplementation(() => {
      throw new Error("synthetic git add failure");
    });
    const res = await postJson(app, "/api/save-file", {
      filePath: "a.txt",
      content: "new\n",
      gitAdd: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.gitAddError).toBe("string");
    // The file itself was still saved exactly once, with the exact bytes.
    expect(spies.write).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenBytes] = spies.write.mock.calls[0];
    expect(writtenPath).toBe("a.txt");
    expect(Buffer.isBuffer(writtenBytes)).toBe(true);
    expect((writtenBytes as Buffer).equals(NEW)).toBe(true);
  });

  it("returns 413 for an explicit Content-Length over the 70 MiB request bound, without allocating", async () => {
    // Only a header is sent: bodyLimit rejects on Content-Length before the
    // body is consumed, so no 70 MiB payload is ever built.
    const res = await postJson(
      app,
      "/api/save-file",
      { filePath: "a.txt", content: "x" },
      { "Content-Length": String(MAX_FILE_REQUEST_BYTES + 1) },
    );
    expect(res.status).toBe(413);
    expect(spies.write).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit-save", () => {
  let app: Hono;

  beforeEach(async () => {
    app = (await makeApp()).app;
  });

  it("forwards a valid baseHash as expectedSha256 and returns the saved hash", async () => {
    spies.write.mockResolvedValue({ sha256: NEW_SHA, size: NEW.length });
    const res = await postJson(app, "/api/edit-save", {
      filePath: "a.txt",
      content: "new\n",
      baseHash: OLD_SHA,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hash: NEW_SHA });
    expect(spies.write).toHaveBeenCalledWith("a.txt", NEW, {
      expectedSha256: OLD_SHA,
    });
  });

  describe.each([
    { name: "malformed baseHash", baseHash: "not-a-hash" },
    { name: "empty baseHash", baseHash: "" },
    { name: "short baseHash", baseHash: "deadbeef" },
    { name: "non-hex baseHash", baseHash: "z".repeat(64) },
  ])("rejects: $name", ({ baseHash }) => {
    it("returns 400 and nothing is written", async () => {
      const res = await postJson(app, "/api/edit-save", {
        filePath: "a.txt",
        content: "new\n",
        baseHash,
      });
      expect(res.status).toBe(400);
      expect(spies.write).not.toHaveBeenCalled();
    });
  });

  it("rejects an invalid anchor range with 400 and no write", async () => {
    const res = await postJson(app, "/api/edit-save", {
      filePath: "a.txt",
      content: "new\n",
      anchorUpdates: [{ id: "a", lineNumber: 1, startLineNumber: 2 }],
    });
    expect(res.status).toBe(400);
    expect(spies.write).not.toHaveBeenCalled();
  });

  it("maps a native conflict to 409 with conflict:true", async () => {
    spies.write.mockRejectedValue(new NativeFsError("conflict"));
    const res = await postJson(app, "/api/edit-save", {
      filePath: "a.txt",
      content: "new\n",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.conflict).toBe(true);
    expect(body.code).toBe("conflict");
  });

  it("maps a native denial to 403 and unavailability to 503", async () => {
    spies.write.mockRejectedValue(new NativeFsError("denied"));
    const denied = await postJson(app, "/api/edit-save", {
      filePath: "a.txt",
      content: "new\n",
    });
    expect(denied.status).toBe(403);

    spies.write.mockRejectedValue(new NativeFsError("unavailable"));
    const unavailable = await postJson(app, "/api/edit-save", {
      filePath: "a.txt",
      content: "new\n",
    });
    expect(unavailable.status).toBe(503);
  });

  it("returns 500 with fileSaved:true and the saved hash when anchor metadata persistence fails after the write", async () => {
    // Own app+store pair so the spy targets the exact store instance the
    // route uses for anchorUpdates persistence.
    const { app: localApp, store } = await makeApp();
    const updateSpy = vi
      .spyOn(store, "update")
      .mockRejectedValue(new Error("synthetic metadata failure"));
    const res = await postJson(localApp, "/api/edit-save", {
      filePath: "a.txt",
      content: "new\n",
      anchorUpdates: [{ id: "c1", lineNumber: 1 }],
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    // The file bytes were committed before the metadata failure: report the
    // saved state, never a success envelope.
    expect(body.fileSaved).toBe(true);
    expect(body.hash).toBe(NEW_SHA);
    expect(body.ok).toBeUndefined();
    // Exactly one native write, with the full new bytes.
    expect(spies.write).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenBytes] = spies.write.mock.calls[0];
    expect(writtenPath).toBe("a.txt");
    expect((writtenBytes as Buffer).equals(NEW)).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("maps a pending-write timeout to 504 with outcomeUnknown:true and no success", async () => {
    spies.write.mockRejectedValue(new NativeFsError("timeout", true));
    const res = await postJson(app, "/api/edit-save", {
      filePath: "a.txt",
      content: "new\n",
    });
    expect(res.status).toBe(504);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.outcomeUnknown).toBe(true);
    expect(body.code).toBe("timeout");
    expect(body.ok).toBeUndefined();
  });
});

describe("POST /api/comments/:id/apply-suggestion", () => {
  let app: Hono;
  let store: InMemoryCommentStore;

  beforeEach(async () => {
    ({ app, store } = await makeApp());
    await seedSuggestionComment(store);
  });

  it("reads via the native client, writes with the read sha as expectedSha256, and resolves the comment", async () => {
    const res = await postJson(app, "/api/comments/c1/apply-suggestion", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, replacedLines: 1 });

    expect(spies.read).toHaveBeenCalledTimes(1);
    expect(spies.read).toHaveBeenCalledWith("a.txt");
    expect(spies.write).toHaveBeenCalledTimes(1);
    expect(spies.write).toHaveBeenCalledWith("a.txt", NEW, {
      expectedSha256: OLD_SHA,
    });

    const comments = await listComments(app);
    expect(comments[0].status).toBe("resolved");
  });

  it("leaves the comment open when the native write is denied", async () => {
    spies.write.mockRejectedValue(new NativeFsError("denied"));
    const res = await postJson(app, "/api/comments/c1/apply-suggestion", {});
    expect(res.status).toBe(403);
    const comments = await listComments(app);
    expect(comments[0].status).toBe("open");
  });

  it("returns 500 with fileSaved:true and leaves the comment open when comment persistence fails after the write", async () => {
    const updateSpy = vi
      .spyOn(store, "update")
      .mockRejectedValue(new Error("synthetic metadata failure"));
    const res = await postJson(app, "/api/comments/c1/apply-suggestion", {});
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.fileSaved).toBe(true);
    expect(body.ok).toBeUndefined();
    // The native replacement succeeded exactly once, but the comment must
    // stay open so the user can retry resolving it.
    expect(spies.write).toHaveBeenCalledTimes(1);
    const comments = await listComments(app);
    expect(comments[0].status).toBe("open");
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves the comment open when the native write conflicts", async () => {
    spies.write.mockRejectedValue(new NativeFsError("conflict"));
    const res = await postJson(app, "/api/comments/c1/apply-suggestion", {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.conflict).toBe(true);
    const comments = await listComments(app);
    expect(comments[0].status).toBe("open");
  });
});

describe.each([
  {
    name: "PR mode",
    make: () => makeApp(undefined, true),
  },
  {
    name: "revision mode",
    make: () => makeApp({ revisions: ["HEAD~1", "HEAD"] }),
  },
])("review scope ($name) blocks every mutating route", ({ make }) => {
  let app: Hono;
  let store: InMemoryCommentStore;

  beforeEach(async () => {
    ({ app, store } = await make());
    await seedSuggestionComment(store);
  });

  it("POST /api/save-file returns 403 with no native I/O", async () => {
    const res = await postJson(app, "/api/save-file", {
      filePath: "a.txt",
      content: "new\n",
    });
    expect(res.status).toBe(403);
    expect(spies.read).not.toHaveBeenCalled();
    expect(spies.write).not.toHaveBeenCalled();
  });

  it("POST /api/edit-save returns 403 with no native I/O", async () => {
    const res = await postJson(app, "/api/edit-save", {
      filePath: "a.txt",
      content: "new\n",
      baseHash: OLD_SHA,
    });
    expect(res.status).toBe(403);
    expect(spies.read).not.toHaveBeenCalled();
    expect(spies.write).not.toHaveBeenCalled();
  });

  it("POST /api/comments/:id/apply-suggestion returns 403 with no native I/O and the store is unchanged", async () => {
    const res = await postJson(app, "/api/comments/c1/apply-suggestion", {});
    expect(res.status).toBe(403);
    expect(spies.read).not.toHaveBeenCalled();
    expect(spies.write).not.toHaveBeenCalled();
    const comments = await listComments(app);
    expect(comments).toHaveLength(1);
    expect(comments[0].status).toBe("open");
  });
});

describe("GET /api/file-content and /api/file-text native errors", () => {
  let app: Hono;

  beforeEach(async () => {
    app = (await makeApp()).app;
  });

  it.each([
    { url: "/api/file-content?path=a.txt&version=new", name: "file-content" },
    { url: "/api/file-text?path=a.txt&version=new", name: "file-text" },
  ])("$name maps a native denial to 403", async ({ url }) => {
    spies.getFileContent.mockRejectedValue(new NativeFsError("denied"));
    const res = await get(app, url);
    expect(res.status).toBe(403);
  });

  it.each([
    { url: "/api/file-content?path=a.txt&version=new", name: "file-content" },
    { url: "/api/file-text?path=a.txt&version=new", name: "file-text" },
  ])("$name maps native unavailability to 503", async ({ url }) => {
    spies.getFileContent.mockRejectedValue(new NativeFsError("unavailable"));
    const res = await get(app, url);
    expect(res.status).toBe(503);
  });

  it.each([
    {
      url: "/api/file-content?path=a.txt&version=middle",
      name: "file-content",
    },
    { url: "/api/file-text?path=a.txt&version=middle", name: "file-text" },
  ])(
    "$name rejects an invalid version with 400 and reads no file",
    async ({ url }) => {
      const res = await get(app, url);
      expect(res.status).toBe(400);
      expect(spies.getFileContent).not.toHaveBeenCalled();
    },
  );

  it("serves an SVG with image/svg+xml, sandboxed CSP, and byte-for-byte content", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    spies.getFileContent.mockResolvedValue(svg);
    const res = await get(app, "/api/file-content?path=sample.svg&version=new");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("sandbox");
    expect(csp).toContain("default-src 'none'");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(svg)).toBe(true);
  });
});
