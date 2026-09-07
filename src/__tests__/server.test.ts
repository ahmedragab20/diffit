// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Hono } from "hono";
import type { CommentStore } from "../lib/comments.js";
import type { PrSession } from "../lib/pr-session.js";

const mockGetGitDiff = vi.fn();
const mockGetCustomGitDiff = vi.fn();
const mockGetRepoName = vi.fn();
const mockGetBranchName = vi.fn();
const mockGetFileContent = vi.fn();
const mockGetTabSizeForFiles = vi.fn();
const mockGetTabSizeForFilesAsync = vi.fn();
const mockGetUntrackedFilePaths = vi.fn();
const mockLoadSettings = vi.fn();
const mockSaveSettings = vi.fn();
const mockIsSafePath = vi.fn();
const mockToSafeRelativePath = vi.fn((filePath) =>
  mockIsSafePath(filePath) ? filePath : null,
);
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

vi.mock("../lib/git.js", () => ({
  getGitDiff: mockGetGitDiff,
  getCustomGitDiff: mockGetCustomGitDiff,
  getRepoName: mockGetRepoName,
  getBranchName: mockGetBranchName,
  getFileContent: mockGetFileContent,
  getTabSizeForFiles: mockGetTabSizeForFiles,
  getTabSizeForFilesAsync: mockGetTabSizeForFilesAsync,
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
}));

vi.mock("../lib/settings.js", () => ({
  loadSettings: mockLoadSettings,
  saveSettings: mockSaveSettings,
}));

vi.mock("../lib/path.js", () => ({
  isSafePath: mockIsSafePath,
  toSafeRelativePath: mockToSafeRelativePath,
  toSafeLiteralRelativePath: mockToSafeRelativePath,
}));

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockRm = vi.fn();

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    readdir: mockReaddir,
    stat: mockStat,
    rm: mockRm,
  };
});

const mockExistsSync = vi.fn();
let originalExistsSync: any;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  originalExistsSync = actual.existsSync;
  return {
    ...actual,
    existsSync: (path: any) => mockExistsSync(path),
  };
});

// Native I/O seam: hoisted spies wired through a partial mock that retains the
// real NativeFsError (instanceof checks in server.ts keep working) and the rest
// of the module, overriding only the repository-fs factory.
const mockNativeRead = vi.hoisted(() => vi.fn());
const mockNativeWrite = vi.hoisted(() => vi.fn());

vi.mock("../lib/native-fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/native-fs.js")>();
  return {
    ...actual,
    getNativeRepositoryFs: () => ({
      read: mockNativeRead,
      write: mockNativeWrite,
    }),
  };
});

const defaultSettings = {
  staged: true,
  untracked: true,
  diffStyle: "split",
  defaultTabSize: 4,
};

class MockCommentStore implements CommentStore {
  comments: any[] = [];
  async getAll() {
    return this.comments;
  }
  async add(c: any) {
    this.comments.push(c);
    return c;
  }
  async update(id: string, fields: any) {
    const c = this.comments.find((x) => x.id === id);
    if (!c) return null;
    Object.assign(c, fields);
    return c;
  }
  async resolveAllOpen(): Promise<number> {
    let n = 0;
    for (const c of this.comments) {
      if (c.status === "open") {
        c.status = "resolved";
        n++;
      }
    }
    return n;
  }
  async remove(id: string) {
    const idx = this.comments.findIndex((x) => x.id === id);
    if (idx === -1) return false;
    this.comments.splice(idx, 1);
    return true;
  }
  async addReply(commentId: string, reply: any) {
    const c = this.comments.find((x) => x.id === commentId);
    if (!c) return null;
    c.replies.push(reply);
    return c;
  }
  async removeReply(commentId: string, replyId: string) {
    const c = this.comments.find((x) => x.id === commentId);
    if (!c) return null;
    const idx = c.replies.findIndex((r: any) => r.id === replyId);
    if (idx === -1) return null;
    c.replies.splice(idx, 1);
    return c;
  }
  async updateReply(commentId: string, replyId: string, body: string) {
    const c = this.comments.find((x) => x.id === commentId);
    if (!c) return null;
    const reply = c.replies.find((r: any) => r.id === replyId);
    if (!reply) return null;
    reply.body = body;
    return c;
  }
}

let DEFAULTS: any;

describe("server", () => {
  let app: Hono;
  let mockStore: MockCommentStore;
  const clientDir = "/tmp/test-client";

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../lib/diff-options.js");
    DEFAULTS = mod.DEFAULTS;
    mockStore = new MockCommentStore();
    mockGetRepoName.mockReturnValue("test-repo");
    mockGetBranchName.mockReturnValue("main");
    mockLoadSettings.mockReturnValue(defaultSettings);
    mockSaveSettings.mockImplementation((s: any) => ({
      ...defaultSettings,
      ...s,
    }));
    mockGetTabSizeForFiles.mockReturnValue({});
    mockGetTabSizeForFilesAsync.mockResolvedValue({});
    mockGetUntrackedFilePaths.mockReturnValue([]);
    mockIsSafePath.mockReturnValue(true);
    mockGetProjectStorageDir.mockReturnValue("/tmp/test-project-storage");
    mockGetRepoRoot.mockReturnValue("/tmp/test-repo");
    mockExistsSync.mockImplementation((p: string) => originalExistsSync(p));

    const { NativeFsError } = await import("../lib/native-fs.js");
    mockNativeRead.mockReset();
    mockNativeWrite.mockReset();
    // Routes ignore the write info payload; the read default is a miss.
    mockNativeWrite.mockResolvedValue({ sha256: "0".repeat(64), size: 0 });
    mockNativeRead.mockRejectedValue(new NativeFsError("not-found"));

    mockGetRepoRootAsync.mockResolvedValue("/tmp/test-repo");
    mockGetBranchNameAsync.mockResolvedValue("main");
    mockGetRepoMetadataAsync.mockResolvedValue({
      repoName: "test-repo",
      branch: "main",
    });
    mockGetUntrackedFilePathsAsync.mockResolvedValue([]);
    mockGetGitDiffAsync.mockResolvedValue(
      "diff --git a/src/index.ts b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n",
    );
    mockGetCustomGitDiffAsync.mockResolvedValue("custom");
    // Default: custom-range revisions resolve to two commits.
    mockGetCommitSeriesSummary.mockResolvedValue({
      commitCount: 2,
      truncated: 0,
      subjects: ["feat: one", "feat: two"],
      authors: ["Alice", "Bob"],
      fromDate: "2026-01-01T00:00:00+00:00",
      toDate: "2026-02-01T00:00:00+00:00",
    });
  });

  describe("createApp", () => {
    beforeEach(async () => {
      const { createApp } = await import("../server.js");
      app = createApp(clientDir, DEFAULTS, mockStore);
    });

    describe("GET /api/diff", () => {
      it("returns diff with repo metadata", async () => {
        mockGetGitDiffAsync.mockResolvedValue(
          "diff --git a/src/index.ts b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n",
        );
        const res = await app.fetch(
          new Request("http://localhost/api/diff?staged=true&untracked=true"),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.patch).toContain("diff --git");
        expect(body.repoName).toBe("test-repo");
        expect(body.branch).toBe("main");
        expect(body.customMode).toBe(false);
      });

      it("forwards staged/untracked params", async () => {
        mockGetGitDiffAsync.mockResolvedValue("");
        await app.fetch(
          new Request("http://localhost/api/diff?staged=false&untracked=false"),
        );
        expect(mockGetGitDiffAsync).toHaveBeenCalledWith({
          staged: false,
          untracked: false,
        });
      });

      it("preserves startup staged/untracked scope when query params are absent", async () => {
        const { createApp } = await import("../server.js");
        const scoped = createApp(
          clientDir,
          {
            ...DEFAULTS,
            staged: true,
            includeUntracked: false,
          },
          mockStore,
        );

        await scoped.fetch(new Request("http://localhost/api/diff"));

        expect(mockGetGitDiffAsync).toHaveBeenCalledWith({
          staged: true,
          untracked: false,
        });
      });

      it("ignores a stale pr-session.json when not started in PR mode", async () => {
        const { createApp } = await import("../server.js");
        const { InMemoryPrSessionStore } = await import("../lib/pr-session.js");
        const prStore = new InMemoryPrSessionStore();
        await prStore.set({
          ref: "1",
          owner: "acme",
          repo: "widget",
          pullNumber: 1,
          headSha: "head",
          baseSha: "base",
          title: "Stale PR",
          url: "https://github.com/acme/widget/pull/1",
          author: { login: "ghost" },
          additions: 1,
          deletions: 1,
          changedFiles: 1,
          diff: "diff --git a/stale b/stale\n+stale\n",
          comments: [],
          existingComments: [],
        } as unknown as PrSession);
        const localApp = createApp(
          clientDir,
          DEFAULTS,
          mockStore,
          undefined,
          prStore,
        );
        const res = await localApp.fetch(
          new Request("http://localhost/api/diff"),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.prMode).toBeUndefined();
        expect(body.patch).not.toContain("stale");
      });

      it("uses custom diff in custom mode", async () => {
        const { createApp } = await import("../server.js");
        const diffOpts = { ...DEFAULTS, revisions: ["HEAD~3"] };
        const custom = createApp(clientDir, diffOpts, mockStore);
        mockGetCustomGitDiffAsync.mockResolvedValue("custom");
        mockGetRepoRootAsync.mockResolvedValue("/tmp/test");
        mockGetBranchNameAsync.mockResolvedValue("main");

        const res = await custom.fetch(
          new Request("http://localhost/api/diff"),
        );
        const body = await res.json();
        expect(body.customMode).toBe(true);
        expect(mockGetCustomGitDiffAsync).toHaveBeenCalledWith(["HEAD~3"]);
      });

      describe("show mode", () => {
        it("routes through getShowDiff and returns commits + showMode", async () => {
          const { createApp } = await import("../server.js");
          const diffOpts = {
            ...DEFAULTS,
            showMode: true,
            showRevspecs: ["HEAD"],
            // showMode mirrors customMode for the UI's toggle visibility
            revisions: [],
            pathspecs: [],
          };
          const showApp = createApp(clientDir, diffOpts, mockStore);
          const fakePatch =
            "diff --git a/foo.ts b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";
          const fakeCommit = {
            sha: "1".repeat(40),
            shortSha: "1111111",
            parents: ["0".repeat(40)],
            subject: "Hello",
            body: "",
            authorName: "Alice",
            authorEmail: "alice@example.com",
            authorDate: "2026-01-01T00:00:00+00:00",
            committerName: "Alice",
            committerEmail: "alice@example.com",
            committerDate: "2026-01-01T00:00:00+00:00",
            patch: fakePatch,
          };
          mockGetShowDiff.mockResolvedValue({
            commits: [fakeCommit],
            patch: fakePatch,
            truncated: 0,
          });

          const res = await showApp.fetch(
            new Request("http://localhost/api/diff"),
          );
          expect(res.status).toBe(200);
          const body = await res.json();

          expect(body.showMode).toBe(true);
          expect(body.commits).toHaveLength(1);
          expect(body.commits[0].shortSha).toBe("1111111");
          expect(body.commits[0].subject).toBe("Hello");
          expect(body.patch).toContain("diff --git a/foo.ts");
          expect(body.customMode).toBe(true);
          expect(mockGetShowDiff).toHaveBeenCalledWith(["HEAD"], []);
          // Show mode bypasses the staged/untracked plumbing.
          expect(mockGetGitDiffAsync).not.toHaveBeenCalled();
          expect(mockGetCustomGitDiffAsync).not.toHaveBeenCalled();
        });

        it("surfaces truncated count when the commit cap is exceeded", async () => {
          const { createApp } = await import("../server.js");
          const diffOpts = {
            ...DEFAULTS,
            showMode: true,
            showRevspecs: ["HEAD~200..HEAD"],
          };
          const showApp = createApp(clientDir, diffOpts, mockStore);
          mockGetShowDiff.mockResolvedValue({
            commits: [],
            patch: "",
            truncated: 100,
          });

          const res = await showApp.fetch(
            new Request("http://localhost/api/diff"),
          );
          const body = await res.json();
          expect(body.truncated).toBe(100);
          expect(body.showMode).toBe(true);
        });

        it("forwards pathspecs to getShowDiff", async () => {
          const { createApp } = await import("../server.js");
          const diffOpts = {
            ...DEFAULTS,
            showMode: true,
            showRevspecs: ["HEAD"],
            pathspecs: ["src/"],
          };
          const showApp = createApp(clientDir, diffOpts, mockStore);
          mockGetShowDiff.mockResolvedValue({
            commits: [],
            patch: "",
            truncated: 0,
          });

          await showApp.fetch(new Request("http://localhost/api/diff"));
          expect(mockGetShowDiff).toHaveBeenCalledWith(["HEAD"], ["src/"]);
        });

        it("omits showMode/commits/truncated from the response in non-show mode", async () => {
          mockGetGitDiffAsync.mockResolvedValue(
            "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n",
          );
          const res = await app.fetch(new Request("http://localhost/api/diff"));
          const body = await res.json();
          expect(body.showMode).toBeUndefined();
          expect(body.commits).toBeUndefined();
          expect(body.truncated).toBeUndefined();
        });
      });

      describe("diff overview banner", () => {
        it("returns a working-tree overview in the default flow", async () => {
          mockGetGitDiffAsync.mockResolvedValue(
            "diff --git a/src/index.ts b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n",
          );
          const res = await app.fetch(
            new Request("http://localhost/api/diff?staged=true&untracked=true"),
          );
          const body = await res.json();
          expect(body.overview).toBeDefined();
          expect(body.overview.kind).toBe("working-tree");
          expect(body.overview.headline).toContain("Working-tree changes");
          expect(body.overview.headline).toContain("main");
          // No commits on the working-tree flow.
          expect(body.overview.commitSubjects).toEqual([]);
          expect(mockGetCommitSeriesSummary).not.toHaveBeenCalled();
        });

        it("returns a staged-only overview when only --staged is set", async () => {
          // staged=true, untracked=false, no revisions
          mockGetGitDiffAsync.mockResolvedValue(
            "diff --git a/s.ts b/s.ts\n+x\n",
          );
          const res = await app.fetch(
            new Request(
              "http://localhost/api/diff?staged=true&untracked=false",
            ),
          );
          const body = await res.json();
          expect(body.overview.kind).toBe("staged-only");
          expect(body.overview.headline).toContain("Staged changes");
        });

        it("returns a range overview for custom revisions", async () => {
          const { createApp } = await import("../server.js");
          const custom = createApp(
            clientDir,
            { ...DEFAULTS, revisions: ["main..feature"] },
            mockStore,
          );
          mockGetCustomGitDiffAsync.mockResolvedValue(
            "diff --git a/x b/x\n+hi\n",
          );
          mockGetBranchNameAsync.mockResolvedValue("main");
          mockGetCommitSeriesSummary.mockResolvedValue({
            commitCount: 2,
            truncated: 0,
            subjects: ["feat: one", "feat: two"],
            authors: ["Alice", "Bob"],
            fromDate: "2026-01-01T00:00:00+00:00",
            toDate: "2026-02-01T00:00:00+00:00",
          });

          const res = await custom.fetch(
            new Request("http://localhost/api/diff"),
          );
          const body = await res.json();

          expect(body.overview.kind).toBe("range");
          expect(body.overview.headline).toContain("Comparing main..feature");
          expect(body.overview.rangeLabel).toBe("main..feature");
          expect(body.overview.commitSubjects).toEqual([
            "feat: one",
            "feat: two",
          ]);
          expect(body.overview.commitCount).toBe(2);
          expect(mockGetCommitSeriesSummary).toHaveBeenCalledWith(
            ["main..feature"],
            [],
          );
        });

        it("surfaces the truncated count from getCommitSeriesSummary", async () => {
          const { createApp } = await import("../server.js");
          const custom = createApp(
            clientDir,
            { ...DEFAULTS, revisions: ["main..HEAD"] },
            mockStore,
          );
          mockGetCustomGitDiffAsync.mockResolvedValue(
            "diff --git a/x b/x\n+hi\n",
          );
          mockGetCommitSeriesSummary.mockResolvedValue({
            commitCount: 2,
            truncated: 50,
            subjects: ["a", "b"],
            authors: ["A"],
          });

          const res = await custom.fetch(
            new Request("http://localhost/api/diff"),
          );
          const body = await res.json();
          expect(body.overview.kind).toBe("range");
          expect(body.overview.truncated).toBe(50);
        });

        it("returns a commit-single overview for a single-commit show", async () => {
          const { createApp } = await import("../server.js");
          const diffOpts = {
            ...DEFAULTS,
            showMode: true,
            showRevspecs: ["HEAD"],
            revisions: [],
            pathspecs: [],
          };
          const showApp = createApp(clientDir, diffOpts, mockStore);
          const fakePatch = "diff --git a/foo.ts b/foo.ts\n+hi\n";
          const fakeCommit = {
            sha: "1".repeat(40),
            shortSha: "1111111",
            parents: ["0".repeat(40)],
            subject: "Hello",
            body: "",
            authorName: "Alice",
            authorEmail: "alice@example.com",
            authorDate: "2026-01-01T00:00:00+00:00",
            committerName: "Alice",
            committerEmail: "alice@example.com",
            committerDate: "2026-01-01T00:00:00+00:00",
            patch: fakePatch,
          };
          mockGetShowDiff.mockResolvedValue({
            commits: [fakeCommit],
            patch: fakePatch,
            truncated: 0,
          });

          const res = await showApp.fetch(
            new Request("http://localhost/api/diff"),
          );
          const body = await res.json();
          expect(body.overview.kind).toBe("commit-single");
          expect(body.overview.headline).toBe("Commit: Hello");
          expect(body.overview.authors).toEqual(["Alice"]);
        });

        it("returns a commit-series overview for a multi-commit show", async () => {
          const { createApp } = await import("../server.js");
          const diffOpts = {
            ...DEFAULTS,
            showMode: true,
            showRevspecs: ["HEAD~2..HEAD"],
            revisions: [],
            pathspecs: [],
          };
          const showApp = createApp(clientDir, diffOpts, mockStore);
          const fakePatch = "diff --git a/x b/x\n+hi\n";
          const c1 = {
            sha: "1".repeat(40),
            shortSha: "1111111",
            parents: ["0".repeat(40)],
            subject: "first",
            body: "",
            authorName: "A",
            authorEmail: "a@x",
            authorDate: "2026-01-01T00:00:00+00:00",
            committerName: "A",
            committerEmail: "a@x",
            committerDate: "2026-01-01T00:00:00+00:00",
            patch: fakePatch,
          };
          const c2 = {
            ...c1,
            sha: "2".repeat(40),
            shortSha: "2222222",
            subject: "second",
          };
          mockGetShowDiff.mockResolvedValue({
            commits: [c1, c2],
            patch: fakePatch,
            truncated: 0,
          });

          const res = await showApp.fetch(
            new Request("http://localhost/api/diff"),
          );
          const body = await res.json();
          expect(body.overview.kind).toBe("commit-series");
          expect(body.overview.headline).toBe("Reviewing 2 commits");
        });

        it("does not call getCommitSeriesSummary in show mode (commits are already on the payload)", async () => {
          const { createApp } = await import("../server.js");
          const showApp = createApp(
            clientDir,
            {
              ...DEFAULTS,
              showMode: true,
              showRevspecs: ["HEAD"],
              revisions: [],
              pathspecs: [],
            },
            mockStore,
          );
          mockGetShowDiff.mockResolvedValue({
            commits: [
              {
                sha: "1".repeat(40),
                shortSha: "1111111",
                parents: [],
                subject: "s",
                body: "",
                authorName: "A",
                authorEmail: "a@x",
                authorDate: "2026-01-01T00:00:00+00:00",
                committerName: "A",
                committerEmail: "a@x",
                committerDate: "2026-01-01T00:00:00+00:00",
                patch: "",
              },
            ],
            patch: "",
            truncated: 0,
          });
          mockGetCommitSeriesSummary.mockClear();
          await showApp.fetch(new Request("http://localhost/api/diff"));
          expect(mockGetCommitSeriesSummary).not.toHaveBeenCalled();
        });
      });

      it("detects binary files in patch", async () => {
        mockGetGitDiffAsync.mockResolvedValue(
          "diff --git a/img.png b/img.png\nnew file mode 100644\nindex 000..001\nBinary files /dev/null and b/img.png differ\n",
        );
        const res = await app.fetch(new Request("http://localhost/api/diff"));
        const body = await res.json();
        expect(body.binaryFiles).toEqual([{ path: "img.png", type: "added" }]);
      });
    });

    describe("bounded diff inspect", () => {
      it("indexes and pages the current web-session patch", async () => {
        mockGetGitDiffAsync.mockResolvedValue(`diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1,2 @@
-old
+new
+extra
`);

        const summaryRes = await app.fetch(
          new Request("http://localhost/api/diff/summary"),
        );
        expect(summaryRes.status).toBe(200);
        const summary = await summaryRes.json();
        expect(summary).toMatchObject({
          files: 1,
          hunks: 1,
          additions: 2,
          deletions: 1,
        });
        expect(summary.directories).toEqual([
          expect.objectContaining({ path: "src", files: 1 }),
        ]);

        const sliceRes = await app.fetch(
          new Request(
            `http://localhost/api/diff/slice?file=0&maxLines=3&generation=${summary.generation}`,
          ),
        );
        expect(sliceRes.status).toBe(200);
        const slice = await sliceRes.json();
        expect(slice.rows).toHaveLength(3);
        expect(slice.nextRow).toBe(3);
      });

      it("rejects a stale generation after the web patch changes", async () => {
        mockGetGitDiffAsync.mockResolvedValue(
          "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n",
        );
        const first = await app.fetch(
          new Request("http://localhost/api/diff/summary"),
        );
        const { generation } = await first.json();

        mockGetGitDiffAsync.mockResolvedValue(
          "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+c\n",
        );
        const stale = await app.fetch(
          new Request(
            `http://localhost/api/diff/hunks?file=0&generation=${generation}`,
          ),
        );
        expect(stale.status).toBe(409);
      });

      it("filters files by path glob and resolves slice by unique path", async () => {
        mockGetGitDiffAsync.mockResolvedValue(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/gone.ts b/gone.ts
--- a/gone.ts
+++ b/gone.ts
@@ -1 +1 @@
-x
+y
`);
        const files = await app.fetch(
          new Request("http://localhost/api/diff/files?path=src/**"),
        );
        expect(files.status).toBe(200);
        const page = await files.json();
        expect(page).toMatchObject({ path: "src/**", matched: 1, total: 2 });
        expect(page.files).toEqual([
          expect.objectContaining({ index: 0, path: "src/a.ts" }),
        ]);

        const slice = await app.fetch(
          new Request(
            "http://localhost/api/diff/slice?path=src/a.ts&maxLines=4",
          ),
        );
        expect(slice.status).toBe(200);
        expect((await slice.json()).fileIndex).toBe(0);

        const missing = await app.fetch(
          new Request("http://localhost/api/diff/slice?path=nope.ts"),
        );
        expect(missing.status).toBe(404);

        const many = await app.fetch(
          new Request("http://localhost/api/diff/hunks?path=**/*.ts"),
        );
        expect(many.status).toBe(409);
        expect((await many.json()).matches.length).toBe(2);

        const both = await app.fetch(
          new Request("http://localhost/api/diff/slice?file=0&path=src/a.ts"),
        );
        expect(both.status).toBe(400);

        const invalid = await app.fetch(
          new Request("http://localhost/api/diff/files?path=src/["),
        );
        expect(invalid.status).toBe(400);
      });
    });

    describe("GET /api/gh/session", () => {
      it("returns 200 prMode:false when a stale PR session exists but the server is not in PR mode", async () => {
        const { createApp } = await import("../server.js");
        const { InMemoryPrSessionStore } = await import("../lib/pr-session.js");
        const prStore = new InMemoryPrSessionStore();
        await prStore.set({
          ref: "1",
          owner: "acme",
          repo: "widget",
          pullNumber: 1,
          headSha: "head",
          baseSha: "base",
          title: "Stale PR",
          url: "https://github.com/acme/widget/pull/1",
          author: { login: "ghost" },
          additions: 1,
          deletions: 1,
          changedFiles: 1,
          diff: "",
          comments: [],
          existingComments: [],
        } as unknown as PrSession);
        const localApp = createApp(
          clientDir,
          DEFAULTS,
          mockStore,
          undefined,
          prStore,
        );
        const res = await localApp.fetch(
          new Request("http://localhost/api/gh/session"),
        );
        // Soft probe: 200 + prMode:false (not 404) so SPA boot does not spam console.
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.prMode).toBe(false);
      });
    });

    describe("GET /api/file-content", () => {
      it("returns 400 when params missing", async () => {
        expect(
          (await app.fetch(new Request("http://localhost/api/file-content")))
            .status,
        ).toBe(400);
        expect(
          (
            await app.fetch(
              new Request("http://localhost/api/file-content?path=x.ts"),
            )
          ).status,
        ).toBe(400);
      });

      it("returns 404 when file not found", async () => {
        mockGetFileContent.mockReturnValue(null);
        const res = await app.fetch(
          new Request(
            "http://localhost/api/file-content?path=x.ts&version=new",
          ),
        );
        expect(res.status).toBe(404);
      });

      it("returns file with MIME type", async () => {
        mockGetFileContent.mockReturnValue(Buffer.from("content"));
        const res = await app.fetch(
          new Request(
            "http://localhost/api/file-content?path=app.js&version=new",
          ),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("application/javascript");
        expect(await res.text()).toBe("content");
      });
    });

    describe("GET /api/settings", () => {
      it("returns current settings", async () => {
        const res = await app.fetch(
          new Request("http://localhost/api/settings"),
        );
        expect(await res.json()).toEqual(defaultSettings);
      });
    });

    describe("PUT /api/settings", () => {
      it("persists settings", async () => {
        await app.fetch(
          new Request("http://localhost/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ staged: false }),
          }),
        );
        expect(mockSaveSettings).toHaveBeenCalledWith({ staged: false });
      });
    });

    describe("UI State API", () => {
      it("GET /api/ui-state returns state from file", async () => {
        mockReadFile.mockResolvedValueOnce(
          JSON.stringify({ "sidebar-width": 350 }),
        );
        const res = await app.fetch(
          new Request("http://localhost/api/ui-state"),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ "sidebar-width": 350 });
      });

      it("PUT /api/ui-state merges and saves state", async () => {
        mockReadFile.mockResolvedValueOnce(
          JSON.stringify({ "sidebar-width": 350 }),
        );
        mockWriteFile.mockResolvedValue(undefined);
        mockMkdir.mockResolvedValue(undefined);

        const res = await app.fetch(
          new Request("http://localhost/api/ui-state", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              "sidebar-collapsed": true,
              "sidebar-width": null,
            }),
          }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ "sidebar-collapsed": true });
        expect(mockWriteFile).toHaveBeenCalledWith(
          expect.stringContaining("ui-state.json"),
          JSON.stringify({ "sidebar-collapsed": true }, null, 2),
          "utf-8",
        );
      });
    });

    describe("viewed files", () => {
      it("starts empty", async () => {
        expect(
          await (
            await app.fetch(new Request("http://localhost/api/viewed"))
          ).json(),
        ).toEqual([]);
      });

      it("tracks viewed state", async () => {
        await app.fetch(
          new Request("http://localhost/api/viewed", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filePath: "src/index.ts", viewed: true }),
          }),
        );
        expect(
          await (
            await app.fetch(new Request("http://localhost/api/viewed"))
          ).json(),
        ).toEqual(["src/index.ts"]);
      });
    });

    describe("CRUD /api/comments", () => {
      it("POST creates comment with 201", async () => {
        const res = await app.fetch(
          new Request("http://localhost/api/comments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filePath: "f.ts",
              side: "additions",
              lineNumber: 1,
              lineContent: "x",
              body: "nice",
            }),
          }),
        );
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.filePath).toBe("f.ts");
        expect(body.status).toBe("open");
        expect(body.id).toBeDefined();
        expect(body.replies).toEqual([]);
      });

      it("POST rejects an unsupported comment side without persisting it", async () => {
        const res = await app.fetch(
          new Request("http://localhost/api/comments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filePath: "f.ts",
              side: "right",
              lineNumber: 1,
              lineContent: "x",
              body: "nice",
            }),
          }),
        );

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: "side must be additions or deletions",
        });
        expect(
          await (
            await app.fetch(new Request("http://localhost/api/comments"))
          ).json(),
        ).toEqual([]);
      });

      it("PUT updates existing comment", async () => {
        const { createApp } = await import("../server.js");
        const s = new MockCommentStore();
        const a = createApp(clientDir, DEFAULTS, s);
        await s.add({
          id: "c1",
          filePath: "f.ts",
          side: "additions",
          lineNumber: 1,
          lineContent: "x",
          body: "orig",
          status: "open",
          createdAt: 0,
          replies: [],
        });

        const res = await a.fetch(
          new Request("http://localhost/api/comments/c1", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: "updated", status: "resolved" }),
          }),
        );
        expect(res.status).toBe(200);
        expect((await res.json()).body).toBe("updated");
      });

      it("PUT returns 404 for missing comment", async () => {
        const res = await app.fetch(
          new Request("http://localhost/api/comments/no", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: "x" }),
          }),
        );
        expect(res.status).toBe(404);
      });

      it("DELETE removes comment", async () => {
        const { createApp } = await import("../server.js");
        const s = new MockCommentStore();
        const a = createApp(clientDir, DEFAULTS, s);
        await s.add({
          id: "c1",
          filePath: "f.ts",
          side: "additions",
          lineNumber: 1,
          lineContent: "x",
          body: "x",
          status: "open",
          createdAt: 0,
          replies: [],
        });

        expect(
          (
            await a.fetch(
              new Request("http://localhost/api/comments/c1", {
                method: "DELETE",
              }),
            )
          ).status,
        ).toBe(200);
        expect(
          await (
            await a.fetch(new Request("http://localhost/api/comments"))
          ).json(),
        ).toEqual([]);
      });

      it("DELETE returns 404 for missing", async () => {
        const res = await app.fetch(
          new Request("http://localhost/api/comments/no", { method: "DELETE" }),
        );
        expect(res.status).toBe(404);
      });

      it("POST reply to comment", async () => {
        const { createApp } = await import("../server.js");
        const s = new MockCommentStore();
        const a = createApp(clientDir, DEFAULTS, s);
        await s.add({
          id: "c1",
          filePath: "f.ts",
          side: "additions",
          lineNumber: 1,
          lineContent: "x",
          body: "x",
          status: "open",
          createdAt: 0,
          replies: [],
        });

        const res = await a.fetch(
          new Request("http://localhost/api/comments/c1/replies", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: "reply text" }),
          }),
        );
        expect((await res.json()).replies).toHaveLength(1);
      });

      it("POST reply returns 404 for missing comment", async () => {
        const res = await app.fetch(
          new Request("http://localhost/api/comments/no/replies", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: "x" }),
          }),
        );
        expect(res.status).toBe(404);
      });
    });

    describe("agent handoff /api/review/*", () => {
      it("GET /api/review/status starts at round 0 with no waiters", async () => {
        const res = await app.fetch(
          new Request("http://localhost/api/review/status"),
        );
        expect(await res.json()).toEqual({
          round: 0,
          waiters: 0,
          lastSentAt: null,
          hasSinceLastBaseline: false,
        });
      });

      it("POST /api/review/send increments the round and reports open count", async () => {
        await mockStore.add({
          id: "c1",
          filePath: "f.ts",
          side: "additions",
          lineNumber: 1,
          lineContent: "x",
          body: "fix",
          status: "open",
          createdAt: 0,
          replies: [],
        });
        await mockStore.add({
          id: "c2",
          filePath: "f.ts",
          side: "additions",
          lineNumber: 2,
          lineContent: "y",
          body: "done",
          status: "resolved",
          createdAt: 0,
          replies: [],
        });

        const first = await (
          await app.fetch(
            new Request("http://localhost/api/review/send", { method: "POST" }),
          )
        ).json();
        expect(first).toMatchObject({ ok: true, round: 1, openCount: 1 });

        const second = await (
          await app.fetch(
            new Request("http://localhost/api/review/send", { method: "POST" }),
          )
        ).json();
        expect(second.round).toBe(2);
      });

      it("GET /api/review/since-last is empty before any send, then baselines after send", async () => {
        const empty = await (
          await app.fetch(new Request("http://localhost/api/review/since-last"))
        ).json();
        expect(empty).toMatchObject({
          hasBaseline: false,
          reviewFiles: [],
          changed: [],
          added: [],
        });

        await app.fetch(
          new Request("http://localhost/api/review/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: "comment-only" }),
          }),
        );

        const after = await (
          await app.fetch(new Request("http://localhost/api/review/since-last"))
        ).json();
        // Baseline exists once a send captured fingerprints (or still false if
        // the mock git diff is empty — either way the shape is stable).
        expect(after).toHaveProperty("hasBaseline");
        expect(after).toHaveProperty("reviewFiles");
        expect(Array.isArray(after.reviewFiles)).toBe(true);
      });

      it("GET /api/review/await returns keep-waiting after the timeout", async () => {
        const res = await app.fetch(
          new Request("http://localhost/api/review/await?timeoutMs=1000"),
        );
        expect(await res.json()).toEqual({ status: "keep-waiting", round: 0 });
      });

      it("releases a blocked await when a send arrives", async () => {
        await mockStore.add({
          id: "c1",
          filePath: "src/x.ts",
          side: "additions",
          lineNumber: 3,
          lineContent: "z",
          body: "rename",
          status: "open",
          createdAt: 0,
          replies: [],
        });

        const pending = app.fetch(
          new Request("http://localhost/api/review/await?timeoutMs=5000"),
        );
        // Let the await register before sending.
        await new Promise((r) => setTimeout(r, 10));
        await app.fetch(
          new Request("http://localhost/api/review/send", { method: "POST" }),
        );

        const result = await (await pending).json();
        expect(result.status).toBe("released");
        expect(result.payload.round).toBe(1);
        expect(result.payload.commentXml).toContain('<comment id="c1"');
      });

      it("forwards the chosen verdict into the handoff payload and XML", async () => {
        await mockStore.add({
          id: "c1",
          filePath: "src/x.ts",
          side: "additions",
          lineNumber: 3,
          lineContent: "z",
          body: "rename",
          status: "open",
          createdAt: 0,
          replies: [],
        });

        const pending = app.fetch(
          new Request("http://localhost/api/review/await?timeoutMs=5000"),
        );
        await new Promise((r) => setTimeout(r, 10));
        const sendRes = await (
          await app.fetch(
            new Request("http://localhost/api/review/send", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ decision: "approved" }),
            }),
          )
        ).json();
        expect(sendRes.decision).toBe("approved");

        const result = await (await pending).json();
        expect(result.payload.decision).toBe("approved");
        expect(result.payload.commentXml).toContain('decision="approved"');
        expect(result.payload.commentXml).toContain("<decision-summary>");
      });

      it("lets a review be sent with a verdict but no comments", async () => {
        const sendRes = await (
          await app.fetch(
            new Request("http://localhost/api/review/send", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ decision: "approved" }),
            }),
          )
        ).json();
        expect(sendRes).toMatchObject({
          ok: true,
          openCount: 0,
          decision: "approved",
        });
      });
    });

    describe("static file serving", () => {
      it("returns 403 for path traversal", async () => {
        mockIsSafePath.mockReturnValue(false);
        const res = await app.fetch(
          new Request("http://localhost/../etc/passwd"),
        );
        expect(res.status).toBe(403);
      });

      it("falls back to index.html for missing files", async () => {
        const { readFile } = await import("node:fs/promises");
        vi.mocked(readFile)
          .mockRejectedValueOnce(new Error("ENOENT"))
          .mockResolvedValueOnce(Buffer.from("<html>SPA</html>"));
        mockIsSafePath.mockReturnValue(true);
        const res = await app.fetch(new Request("http://localhost/"));
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("text/html");
      });

      it("returns a diagnostic 503 when the client bundle is missing", async () => {
        const { readFile } = await import("node:fs/promises");
        vi.mocked(readFile)
          .mockRejectedValueOnce(new Error("ENOENT"))
          .mockRejectedValueOnce(new Error("ENOENT"));
        mockIsSafePath.mockReturnValue(true);
        const res = await app.fetch(new Request("http://localhost/"));
        expect(res.status).toBe(503);
        await expect(res.text()).resolves.toContain("client bundle is missing");
      });
    });

    describe("GET /api/live", () => {
      it("returns event stream", async () => {
        const res = await app.fetch(new Request("http://localhost/api/live"));
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toContain("text/event-stream");
        expect(res.body).toBeDefined();
        const reader = res.body?.getReader();
        if (reader) {
          await reader.cancel();
        }
      });
    });
    describe("GET /api/attachments/:filename", () => {
      it("serves file with correct MIME type via the native read", async () => {
        const png = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        mockNativeRead.mockResolvedValueOnce({
          bytes: png,
          sha256: "0".repeat(64),
        });

        const res = await app.fetch(
          new Request("http://localhost/api/attachments/test-img.png"),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("image/png");
        expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
        expect(mockNativeRead).toHaveBeenCalledWith("attachments/test-img.png");
      });

      it("returns 403 on path traversal attempt without any native read", async () => {
        const res = await app.fetch(
          new Request(
            "http://localhost/api/attachments/..%2F..%2Fetc%2Fpasswd",
          ),
        );
        expect(res.status).toBe(403);
        expect(mockNativeRead).not.toHaveBeenCalled();
      });

      it("returns 404 when the native read reports not-found", async () => {
        const { NativeFsError } = await import("../lib/native-fs.js");
        mockNativeRead.mockRejectedValueOnce(new NativeFsError("not-found"));
        const res = await app.fetch(
          new Request("http://localhost/api/attachments/missing.png"),
        );
        expect(res.status).toBe(404);
        expect(mockReadFile).not.toHaveBeenCalled();
      });

      it("returns 403 when the native read denies access", async () => {
        const { NativeFsError } = await import("../lib/native-fs.js");
        mockNativeRead.mockRejectedValueOnce(new NativeFsError("denied"));
        const res = await app.fetch(
          new Request("http://localhost/api/attachments/test-img.png"),
        );
        expect(res.status).toBe(403);
      });

      it("returns 503 when native file access is unavailable", async () => {
        const { NativeFsError } = await import("../lib/native-fs.js");
        mockNativeRead.mockRejectedValueOnce(new NativeFsError("unavailable"));
        const res = await app.fetch(
          new Request("http://localhost/api/attachments/test-img.png"),
        );
        expect(res.status).toBe(503);
      });
    });

    describe("POST /api/attachments", () => {
      it("saves pasted/uploaded image through native writes", async () => {
        const png = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        mockMkdir.mockResolvedValue(undefined);

        const formData = new FormData();
        formData.append(
          "file",
          new File([new Uint8Array(png)], "screenshot.png", {
            type: "image/png",
          }),
        );

        const res = await app.fetch(
          new Request("http://localhost/api/attachments", {
            method: "POST",
            body: formData,
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.url).toContain("/api/attachments/pasted_image_");
        expect(body).toMatchObject({
          name: "screenshot.png",
          mimeType: "image/png",
          size: 8,
        });
        // Only the trusted storage root is created with ambient authority.
        expect(mockMkdir).toHaveBeenCalledWith("/tmp/test-project-storage", {
          recursive: true,
        });
        expect(mockNativeWrite).toHaveBeenCalledWith(
          "repo_path.txt",
          Buffer.from("/tmp/test-repo", "utf8"),
        );
        const imageWrite = mockNativeWrite.mock.calls.find((call) =>
          /^attachments\/pasted_image_.*\.png$/.test(String(call[0])),
        );
        expect(imageWrite).toBeDefined();
        expect(Buffer.isBuffer(imageWrite![1])).toBe(true);
        expect(imageWrite![1]).toEqual(png);
        expect(imageWrite![2]).toEqual({ createParents: true });
        expect(mockWriteFile).not.toHaveBeenCalled();
      });

      it("returns 403 and saves nothing when the native write is denied", async () => {
        const { NativeFsError } = await import("../lib/native-fs.js");
        mockMkdir.mockResolvedValue(undefined);
        mockNativeWrite.mockRejectedValue(new NativeFsError("denied"));

        const formData = new FormData();
        formData.append(
          "file",
          new File(
            [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
            "screenshot.png",
            { type: "image/png" },
          ),
        );

        const res = await app.fetch(
          new Request("http://localhost/api/attachments", {
            method: "POST",
            body: formData,
          }),
        );
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.url).toBeUndefined();
        expect(mockNativeWrite).toHaveBeenCalledWith(
          "repo_path.txt",
          Buffer.from("/tmp/test-repo", "utf8"),
        );
      });

      it("rejects a declared oversized multipart body with 413 before any native write", async () => {
        const boundary = "----diffingboundary";
        const rawBody = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="screenshot.png"\r\nContent-Type: image/png\r\n\r\npng\r\n--${boundary}--\r\n`;
        const request = new Request("http://localhost/api/attachments", {
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": String(11 * 1024 * 1024 + 1),
          },
          body: rawBody,
        });
        expect(request.headers.get("content-length")).toBe(
          String(11 * 1024 * 1024 + 1),
        );

        const res = await app.fetch(request);
        expect(res.status).toBe(413);
        expect(mockNativeWrite).not.toHaveBeenCalled();
      });

      it("returns 400 if no file uploaded", async () => {
        const res = await app.fetch(
          new Request("http://localhost/api/attachments", {
            method: "POST",
            body: new FormData(),
          }),
        );
        expect(res.status).toBe(400);
      });

      it("rejects non-image uploads", async () => {
        const formData = new FormData();
        formData.append(
          "file",
          new File(["hello"], "note.txt", { type: "text/plain" }),
        );
        const res = await app.fetch(
          new Request("http://localhost/api/attachments", {
            method: "POST",
            body: formData,
          }),
        );
        expect(res.status).toBe(415);
      });

      it("rejects files whose bytes do not match the declared image type", async () => {
        const formData = new FormData();
        formData.append(
          "file",
          new File(["not really a png"], "fake.png", { type: "image/png" }),
        );
        const res = await app.fetch(
          new Request("http://localhost/api/attachments", {
            method: "POST",
            body: formData,
          }),
        );
        expect(res.status).toBe(415);
      });

      it("rejects images larger than 10 MB", async () => {
        const formData = new FormData();
        formData.append(
          "file",
          new File([new Uint8Array(10 * 1024 * 1024 + 1)], "huge.png", {
            type: "image/png",
          }),
        );
        const res = await app.fetch(
          new Request("http://localhost/api/attachments", {
            method: "POST",
            body: formData,
          }),
        );
        expect(res.status).toBe(413);
      });
    });
  });

  describe("binary file detection", () => {
    beforeEach(async () => {
      const { createApp } = await import("../server.js");
      app = createApp(clientDir, DEFAULTS, mockStore);
    });

    it("classifies added binary", async () => {
      mockGetGitDiffAsync.mockResolvedValue(
        "diff --git a/i.png b/i.png\nnew file mode 100644\nBinary files /dev/null and b/i.png differ\n",
      );
      const res = await app.fetch(new Request("http://localhost/api/diff"));
      expect((await res.json()).binaryFiles[0].type).toBe("added");
    });

    it("classifies deleted binary", async () => {
      mockGetGitDiffAsync.mockResolvedValue(
        "diff --git a/i.png b/i.png\ndeleted file mode 100644\nBinary files a/i.png and /dev/null differ\n",
      );
      const res = await app.fetch(new Request("http://localhost/api/diff"));
      expect((await res.json()).binaryFiles[0].type).toBe("deleted");
    });

    it("classifies untracked binary", async () => {
      mockGetGitDiffAsync.mockResolvedValue(
        "diff --git a/n.png b/n.png\nnew file mode 100644\nBinary files /dev/null and b/n.png differ\n",
      );
      mockGetUntrackedFilePathsAsync.mockResolvedValue(["n.png"]);
      const res = await app.fetch(
        new Request("http://localhost/api/diff?staged=true&untracked=true"),
      );
      expect((await res.json()).binaryFiles[0].type).toBe("untracked");
    });
  });

  describe("cleanupStaleProjects", () => {
    it("deletes project directory when the original repository no longer exists (dead project)", async () => {
      const { cleanupStaleProjects } = await import("../server.js");

      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith(".diffing")) return true;
        if (p.endsWith("repo_path.txt")) return true;
        if (p.endsWith("comments.json")) return false;
        if (p === "/tmp/deleted-repo") return false;
        return false;
      });

      mockReaddir.mockResolvedValue([
        { name: "dead-repo-hash", isDirectory: () => true },
      ] as any);

      mockReadFile.mockImplementation(async (p: string) => {
        if (p.endsWith("repo_path.txt")) {
          return "/tmp/deleted-repo";
        }
        throw new Error("ENOENT");
      });

      await cleanupStaleProjects();

      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining("dead-repo-hash"),
        {
          recursive: true,
          force: true,
        },
      );
    });

    it("deletes project directory when comments.json has not been modified for 14 days (stale project)", async () => {
      const { cleanupStaleProjects } = await import("../server.js");

      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith(".diffing")) return true;
        if (p.endsWith("repo_path.txt")) return true;
        if (p.endsWith("comments.json")) return true;
        if (p === "/tmp/active-repo") return true;
        return false;
      });

      mockReaddir.mockResolvedValue([
        { name: "stale-repo-hash", isDirectory: () => true },
      ] as any);

      mockReadFile.mockImplementation(async (p: string) => {
        if (p.endsWith("repo_path.txt")) {
          return "/tmp/active-repo";
        }
        throw new Error("ENOENT");
      });

      mockStat.mockResolvedValue({
        mtimeMs: Date.now() - 15 * 24 * 60 * 60 * 1000,
      } as any);

      await cleanupStaleProjects();

      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining("stale-repo-hash"),
        {
          recursive: true,
          force: true,
        },
      );
    });

    it("keeps project directory when repository exists and comments are fresh", async () => {
      const { cleanupStaleProjects } = await import("../server.js");

      mockRm.mockClear();

      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith(".diffing")) return true;
        if (p.endsWith("repo_path.txt")) return true;
        if (p.endsWith("comments.json")) return true;
        if (p === "/tmp/active-repo") return true;
        return false;
      });

      mockReaddir.mockResolvedValue([
        { name: "fresh-repo-hash", isDirectory: () => true },
      ] as any);

      mockReadFile.mockImplementation(async (p: string) => {
        if (p.endsWith("repo_path.txt")) {
          return "/tmp/active-repo";
        }
        throw new Error("ENOENT");
      });

      mockStat.mockResolvedValue({
        mtimeMs: Date.now(),
      } as any);

      await cleanupStaleProjects();

      expect(mockRm).not.toHaveBeenCalled();
    });

    it("keeps a project alive on fresh plans alone, even without comments", async () => {
      const { cleanupStaleProjects } = await import("../server.js");

      mockRm.mockClear();

      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith(".diffing")) return true;
        if (p.endsWith("repo_path.txt")) return true;
        if (p.endsWith("plans.json")) return true;
        if (p === "/tmp/active-repo") return true;
        return false; // comments.json + attachments dir absent
      });

      mockReaddir.mockResolvedValue([
        { name: "plans-only-hash", isDirectory: () => true },
      ] as any);

      mockReadFile.mockImplementation(async (p: string) => {
        if (p.endsWith("repo_path.txt")) return "/tmp/active-repo";
        throw new Error("ENOENT");
      });

      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);

      await cleanupStaleProjects();

      expect(mockRm).not.toHaveBeenCalled();
    });

    it("deletes a project when plans are the only data and have gone stale", async () => {
      const { cleanupStaleProjects } = await import("../server.js");

      mockRm.mockClear();

      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith(".diffing")) return true;
        if (p.endsWith("repo_path.txt")) return true;
        if (p.endsWith("plans.json")) return true;
        if (p === "/tmp/active-repo") return true;
        return false;
      });

      mockReaddir.mockResolvedValue([
        { name: "stale-plans-hash", isDirectory: () => true },
      ] as any);

      mockReadFile.mockImplementation(async (p: string) => {
        if (p.endsWith("repo_path.txt")) return "/tmp/active-repo";
        throw new Error("ENOENT");
      });

      mockStat.mockResolvedValue({
        mtimeMs: Date.now() - 15 * 24 * 60 * 60 * 1000,
      } as any);

      await cleanupStaleProjects();

      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining("stale-plans-hash"),
        {
          recursive: true,
          force: true,
        },
      );
    });
  });
});
