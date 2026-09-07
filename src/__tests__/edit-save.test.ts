// @vitest-environment node
// Real-helper HTTP tests. File mutations stay inside owned temporary fixtures.
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { readFile, rm } from "node:fs/promises";
import type { Hono } from "hono";
import type { CommentStore } from "../lib/comments.js";
import { closeNativeRepositoryFs } from "../lib/native-fs.js";

// Track real watchers for teardown without replacing filesystem events.
const watchers = vi.hoisted(() => [] as Array<import("node:fs").FSWatcher>);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: (...args: unknown[]) => {
      const w = (
        actual.watch as (...a: unknown[]) => import("node:fs").FSWatcher
      )(...args);
      watchers.push(w);
      return w;
    },
  };
});

// --- Mocked modules (only what the routes need beyond native I/O) ------------

const mockGetGitDiff = vi.fn();
const mockGetCustomGitDiff = vi.fn();
const mockGetRepoName = vi.fn();
const mockGetBranchName = vi.fn();
const mockGetFileContent = vi.fn();
const mockGetTabSizeForFiles = vi.fn();
const mockGetUntrackedFilePaths = vi.fn();
const mockLoadSettings = vi.fn();
const mockSaveSettings = vi.fn();
const mockGetRepoRoot = vi.fn();
const mockGetProjectStorageDir = vi.fn();

const mockGetGitDiffAsync = vi.fn();
const mockGetCustomGitDiffAsync = vi.fn();
const mockGetRepoRootAsync = vi.fn();
const mockGetBranchNameAsync = vi.fn();
const mockGetRepoMetadataAsync = vi.fn();
const mockGetUntrackedFilePathsAsync = vi.fn();
const mockGetShowDiff = vi.fn();
const mockGetCommitSeriesSummary = vi.fn();
const mockGetMergeStatus = vi.fn();
const mockGitAddFile = vi.fn();
const mockListRepoFiles = vi.fn();
const mockRevertHunk = vi.fn();
const mockGetHunkHistory = vi.fn();
const mockIsImageFile = vi.fn();

vi.mock("../lib/git.js", () => ({
  getGitDiff: mockGetGitDiff,
  getCustomGitDiff: mockGetCustomGitDiff,
  getRepoName: mockGetRepoName,
  getBranchName: mockGetBranchName,
  getFileContent: mockGetFileContent,
  getTabSizeForFiles: mockGetTabSizeForFiles,
  getUntrackedFilePaths: mockGetUntrackedFilePaths,
  getGitDiffAsync: mockGetGitDiffAsync,
  getCustomGitDiffAsync: mockGetCustomGitDiffAsync,
  getRepoRootAsync: mockGetRepoRootAsync,
  getBranchNameAsync: mockGetBranchNameAsync,
  getRepoMetadataAsync: mockGetRepoMetadataAsync,
  getUntrackedFilePathsAsync: mockGetUntrackedFilePathsAsync,
  getRepoRoot: mockGetRepoRoot,
  getProjectStorageDir: mockGetProjectStorageDir,
  getShowDiff: mockGetShowDiff,
  getCommitSeriesSummary: mockGetCommitSeriesSummary,
  getMergeStatus: mockGetMergeStatus,
  gitAddFile: mockGitAddFile,
  listRepoFiles: mockListRepoFiles,
  revertHunk: mockRevertHunk,
  getHunkHistory: mockGetHunkHistory,
  isImageFile: mockIsImageFile,
}));

vi.mock("../lib/settings.js", () => ({
  loadSettings: mockLoadSettings,
  saveSettings: mockSaveSettings,
}));

// Real path normalization and native containment remain enabled.

// --- Comment store with an `update` spy --------------------------------------

class MockCommentStore implements CommentStore {
  update = vi.fn(async (_id: string, fields: any) => ({ id: _id, ...fields }));
  async getAll() {
    return [];
  }
  async add(c: any) {
    return c;
  }
  async remove(_id: string) {
    return false;
  }
  async resolveAllOpen() {
    return 0;
  }
  async addReply(_commentId: string, _reply: any) {
    return null;
  }
  async removeReply(_commentId: string, _replyId: string) {
    return null;
  }
  async updateReply(_commentId: string, _replyId: string, _body: string) {
    return null;
  }
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function postSave(app: Hono, body: unknown) {
  return app.fetch(
    new Request("http://localhost/api/edit-save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/edit-save (native helper integration)", () => {
  let app: Hono;
  let mockStore: MockCommentStore;
  let fixtureRoot: string;
  let repoRoot: string;
  let clientDir: string;

  beforeAll(async () => {
    // The native fs client spawns the real `diffing-tui` helper built next to
    // the package root. No skip/install/build here — hard-fail with guidance.
    const { findFileAccessTuiBinary } = await import(
      "../lib/find-tui-binary.js"
    );
    const binary = await findFileAccessTuiBinary(
      new URL("../lib/native-fs.ts", import.meta.url).href,
    );
    if (!binary) {
      throw new Error(
        "Run pnpm build:tui:debug before native integration tests",
      );
    }
  });

  beforeEach(async () => {
    // Fully owned fixture: everything (repo, client dir, storage dir, sentinels)
    // lives under fixtureRoot and is removed in afterEach.
    fixtureRoot = mkdtempSync(join(tmpdir(), "diffing-edit-"));
    repoRoot = join(fixtureRoot, "repo");
    mkdirSync(repoRoot);
    clientDir = join(fixtureRoot, "client");
    mkdirSync(clientDir);

    vi.clearAllMocks();
    mockGetRepoRoot.mockReturnValue(repoRoot);
    mockGetProjectStorageDir.mockReturnValue(join(fixtureRoot, "storage"));
    mockGetRepoName.mockReturnValue("test-repo");
    mockGetBranchName.mockReturnValue("main");
    mockLoadSettings.mockReturnValue({});
    mockSaveSettings.mockImplementation((s: any) => s);
    mockGetTabSizeForFiles.mockReturnValue({});
    mockGetUntrackedFilePaths.mockReturnValue([]);
    mockGetGitDiffAsync.mockResolvedValue("");
    mockGetCustomGitDiffAsync.mockResolvedValue("");
    mockGetRepoRootAsync.mockResolvedValue(repoRoot);
    mockGetBranchNameAsync.mockResolvedValue("main");
    mockGetRepoMetadataAsync.mockResolvedValue({
      repoName: "test-repo",
      branch: "main",
    });
    mockGetUntrackedFilePathsAsync.mockResolvedValue([]);
    mockGetCommitSeriesSummary.mockResolvedValue({
      commitCount: 0,
      truncated: 0,
      subjects: [],
      authors: [],
      fromDate: "2026-01-01T00:00:00+00:00",
      toDate: "2026-02-01T00:00:00+00:00",
    });
    mockStore = new MockCommentStore();
    const { DEFAULTS } = await import("../lib/diff-options.js");
    const { createApp } = await import("../server.js");
    app = createApp(clientDir, DEFAULTS, mockStore);
  });

  afterEach(async () => {
    // Release resources before removing the owned fixture.
    for (const w of watchers.splice(0)) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    await closeNativeRepositoryFs();
    vi.restoreAllMocks();
    await rm(fixtureRoot, { recursive: true, maxRetries: 5, retryDelay: 50 });
  });

  it("400 when filePath is missing", async () => {
    const res = await postSave(app, { content: "hello\n" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid edit-save request");
  });

  it("400 when content is missing", async () => {
    const res = await postSave(app, { filePath: "sub/file.txt" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid edit-save request");
  });

  it("400 with code invalid-path for '../outside.txt' traversal, sentinel untouched", async () => {
    const outsidePath = join(fixtureRoot, "outside.txt");
    writeFileSync(outsidePath, "sentinel\n");

    const res = await postSave(app, {
      filePath: "../outside.txt",
      content: "clobber\n",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid-path");

    // The traversal target (inside the owned fixture, outside the repo) is
    // byte-for-byte untouched.
    expect(readFileSync(outsidePath, "utf-8")).toBe("sentinel\n");
  });

  it("403 in PR mode", async () => {
    const { DEFAULTS } = await import("../lib/diff-options.js");
    const { createApp } = await import("../server.js");
    const prApp = createApp(
      clientDir,
      DEFAULTS,
      mockStore,
      undefined,
      undefined,
      true,
    );
    const res = await postSave(prApp, {
      filePath: "sub/file.txt",
      content: "hello\n",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Editing is not available in this review scope",
    });
  });

  it("403 in custom mode (revisions set)", async () => {
    const { DEFAULTS } = await import("../lib/diff-options.js");
    const { createApp } = await import("../server.js");
    const customApp = createApp(
      clientDir,
      { ...DEFAULTS, revisions: ["HEAD~1"] },
      mockStore,
    );
    const res = await postSave(customApp, {
      filePath: "sub/file.txt",
      content: "hello\n",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Editing is not available in this review scope",
    });
  });

  it("200 writes atomically through the native helper: real bytes, hash, no temp leftovers", async () => {
    const subDir = join(repoRoot, "sub");
    mkdirSync(subDir);
    const content = "hello\n";

    const res = await postSave(app, { filePath: "sub/file.txt", content });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.hash).toBe("string");
    expect(body.hash).toBe(sha256(content));

    const diskPath = join(subDir, "file.txt");
    expect(await readFile(diskPath, "utf-8")).toBe(content);

    // Temp files never survive a completed atomic write — neither the current
    // `.diffing-write-*` prefix nor the retired `.diffing-edit-*` one.
    const entries = readdirSync(repoRoot, { recursive: true });
    expect(
      entries.filter((e) => String(e).includes(".diffing-write-")),
    ).toHaveLength(0);
    expect(
      entries.filter((e) => String(e).includes(".diffing-edit-")),
    ).toHaveLength(0);
    expect(entries).toContain(join("sub", "file.txt"));
  });

  it("409 on base-hash conflict leaves the disk file untouched, then 200 with the right hash", async () => {
    const subDir = join(repoRoot, "sub");
    mkdirSync(subDir);
    const diskPath = join(subDir, "file.txt");
    writeFileSync(diskPath, "original\n");
    const correctHash = sha256("original\n");

    const conflict = await postSave(app, {
      filePath: "sub/file.txt",
      content: "clobber\n",
      baseHash: sha256("wrong content"),
    });
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.json();
    expect(conflictBody.conflict).toBe(true);
    expect(conflictBody.code).toBe("conflict");
    // Disk is unchanged.
    expect(readFileSync(diskPath, "utf-8")).toBe("original\n");

    const ok = await postSave(app, {
      filePath: "sub/file.txt",
      content: "clobber\n",
      baseHash: correctHash,
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
    expect(readFileSync(diskPath, "utf-8")).toBe("clobber\n");
  });

  it("writes without a conflict check when baseHash is absent", async () => {
    const subDir = join(repoRoot, "sub");
    mkdirSync(subDir);
    const diskPath = join(subDir, "file.txt");
    writeFileSync(diskPath, "seeded\n");

    const res = await postSave(app, {
      filePath: "sub/file.txt",
      content: "replaced\n",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(readFileSync(diskPath, "utf-8")).toBe("replaced\n");
  });

  it("applies anchorUpdates: only the two valid anchors reach store.update", async () => {
    const res = await postSave(app, {
      filePath: "f.txt",
      content: "x\n",
      anchorUpdates: [
        { id: "a", side: "additions", lineNumber: 5 },
        { id: "b", side: "deletions", lineNumber: 3, startLineNumber: 1 },
      ],
    });
    expect(res.status).toBe(200);

    expect(mockStore.update).toHaveBeenCalledTimes(2);
    expect(mockStore.update).toHaveBeenNthCalledWith(1, "a", {
      side: "additions",
      lineNumber: 5,
      startLineNumber: undefined,
    });
    expect(mockStore.update).toHaveBeenNthCalledWith(2, "b", {
      side: "deletions",
      lineNumber: 3,
      startLineNumber: 1,
    });
  });

  it.each([
    { name: "missing lineNumber", anchor: { id: "a" } },
    { name: "missing id", anchor: { lineNumber: 9 } },
    {
      name: "start after end",
      anchor: { id: "c", side: "additions", lineNumber: 5, startLineNumber: 7 },
    },
  ])(
    "rejects an anchor with $name before any file or store mutation",
    async ({ anchor }) => {
      const res = await postSave(app, {
        filePath: "f.txt",
        content: "x\n",
        anchorUpdates: [anchor],
      });
      expect(res.status).toBe(400);

      expect(mockStore.update).not.toHaveBeenCalled();
      // Nothing was written to disk either.
      expect(existsSync(join(repoRoot, "f.txt"))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "403: a leaf file symlinked outside the repo cannot be written through the API",
    async () => {
      const outsidePath = join(fixtureRoot, "outside.txt");
      writeFileSync(outsidePath, "sentinel\n");
      const leafLink = join(repoRoot, "leaf.txt");
      symlinkSync(outsidePath, leafLink);

      const res = await postSave(app, {
        filePath: "leaf.txt",
        content: "clobber\n",
      });
      expect(res.status).toBe(403);
      expect(readFileSync(outsidePath, "utf-8")).toBe("sentinel\n");
      expect(mockStore.update).not.toHaveBeenCalled();
    },
  );

  it("403: a symlinked parent directory pointing outside the repo cannot be written through", async () => {
    const outsideDir = join(fixtureRoot, "outside-dir");
    mkdirSync(outsideDir);
    const sentinel = join(outsideDir, "file.txt");
    writeFileSync(sentinel, "sentinel\n");

    // On Windows a directory junction; on POSIX a normal directory symlink.
    const linkPath = join(repoRoot, "linked");
    symlinkSync(
      outsideDir,
      linkPath,
      process.platform === "win32" ? "junction" : undefined,
    );

    const res = await postSave(app, {
      filePath: join("linked", "file.txt"),
      content: "clobber\n",
    });
    expect(res.status).toBe(403);
    expect(readFileSync(sentinel, "utf-8")).toBe("sentinel\n");
    expect(mockStore.update).not.toHaveBeenCalled();
  });

  it("SSE: broadcasts a `change` event after a successful edit-save", async () => {
    const subDir = join(repoRoot, "sub");
    mkdirSync(subDir);

    const res = await app.fetch(new Request("http://localhost/api/live"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No body stream on /api/live");
    const decoder = new TextDecoder();

    const readUntil = (
      predicate: (chunk: string) => boolean,
      timeoutMs: number,
    ) =>
      new Promise<"match" | "timeout" | "done" | "error">((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), timeoutMs);
        const pump = async () => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              clearTimeout(timer);
              resolve("done");
              return;
            }
            const text = decoder.decode(value, { stream: true });
            if (predicate(text)) {
              clearTimeout(timer);
              resolve("match");
              return;
            }
            pump();
          } catch {
            clearTimeout(timer);
            resolve("error");
          }
        };
        pump();
      });

    try {
      // Confirm the connection is registered (heartbeat arrives on open).
      const heartbeat = await readUntil(
        (t) => t.includes("event: heartbeat"),
        3000,
      );
      expect(heartbeat).toBe("match");

      // Now mutate the watched tree through the API; the repo watcher should
      // broadcast `change` (debounced) shortly after the atomic write.
      const save = await postSave(app, {
        filePath: "sub/file.txt",
        content: "sse\n",
      });
      expect(save.status).toBe(200);

      const change = await readUntil((t) => t.includes("event: change"), 3000);
      expect(change).toBe("match");
    } finally {
      // Always cancel the SSE body so no reader/stream leaks into teardown.
      await reader.cancel().catch(() => undefined);
    }
  });
});
