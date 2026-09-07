// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockExecFileSync = vi.fn();
const mockExecFile = vi.fn();
const mockReadFileSync = vi.fn();
const mockIsSafePath = vi.fn();
const mockParseEditorConfig = vi.fn();
const mockToSafeRelativePath = vi.fn((filePath) =>
  mockIsSafePath(filePath) ? filePath : null,
);

type BufferExecCallback = (
  error: Error | null,
  result?: { stdout: Buffer; stderr: Buffer },
) => void;

const mockNativeRead = vi.hoisted(() => vi.fn());
const mockNativeClose = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: mockExecFileSync, execFile: mockExecFile };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: mockReadFileSync };
});

vi.mock("../lib/path.js", () => ({
  isSafePath: mockIsSafePath,
  toSafeRelativePath: mockToSafeRelativePath,
  toSafeLiteralRelativePath: mockToSafeRelativePath,
}));
// Keep real error semantics without starting a filesystem helper.
vi.mock("../lib/native-fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/native-fs.js")>();
  return {
    ...actual,
    getNativeRepositoryFs: () => ({ read: mockNativeRead }),
    closeNativeRepositoryFs: mockNativeClose,
  };
});
vi.mock("editorconfig", () => ({ parseSync: mockParseEditorConfig }));

describe("git", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockNativeRead.mockReset();
    const { _resetRepoRootCache } = await import("../lib/git.js");
    _resetRepoRootCache();
  });

  describe("isImageFile", () => {
    it("returns true for common image extensions", async () => {
      const { isImageFile } = await import("../lib/git.js");
      for (const ext of [
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "svg",
        "ico",
        "bmp",
        "avif",
      ]) {
        expect(isImageFile(`file.${ext}`)).toBe(true);
      }
    });

    it("handles uppercase extensions", async () => {
      const { isImageFile } = await import("../lib/git.js");
      expect(isImageFile("photo.PNG")).toBe(true);
      expect(isImageFile("photo.JPG")).toBe(true);
    });

    it("returns false for non-image extensions", async () => {
      const { isImageFile } = await import("../lib/git.js");
      for (const ext of ["ts", "jsx", "css", "md", "txt", "json"]) {
        expect(isImageFile(`file.${ext}`)).toBe(false);
      }
    });

    it("returns false for files without extension", async () => {
      const { isImageFile } = await import("../lib/git.js");
      expect(isImageFile("Makefile")).toBe(false);
    });
  });

  describe("isGitRepo", () => {
    it("returns true when execFileSync succeeds", async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(""));
      const { isGitRepo } = await import("../lib/git.js");
      expect(isGitRepo()).toBe(true);
    });

    it("returns false when execFileSync throws", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not a repo");
      });
      const { isGitRepo } = await import("../lib/git.js");
      expect(isGitRepo()).toBe(false);
    });
  });

  describe("getRepoRoot", () => {
    it("returns trimmed root path", async () => {
      mockExecFileSync.mockReturnValue("/home/user/project\n");
      const { getRepoRoot } = await import("../lib/git.js");
      expect(getRepoRoot()).toBe("/home/user/project");
    });
  });

  describe("getRepoName", () => {
    it("returns basename", async () => {
      mockExecFileSync.mockReturnValue("/home/user/my-project\n");
      const { getRepoName } = await import("../lib/git.js");
      expect(getRepoName()).toBe("my-project");
    });
  });

  describe("getBranchName", () => {
    it("returns branch on success", async () => {
      mockExecFileSync.mockReturnValue("main\n");
      const { getBranchName } = await import("../lib/git.js");
      expect(getBranchName()).toBe("main");
    });

    it("returns empty string on error", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("no head");
      });
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args?.[0] === "rev-parse" && args?.[1] === "--show-toplevel") {
          return "/home/user/project\n";
        }
        throw new Error("error");
      });
      const { getBranchName } = await import("../lib/git.js");
      expect(getBranchName()).toBe("");
    });
  });

  describe("getCustomGitDiff", () => {
    it("forwards args with DIFF_FLAGS", async () => {
      mockExecFileSync.mockReturnValue("output");
      const { getCustomGitDiff } = await import("../lib/git.js");
      const result = getCustomGitDiff(["HEAD~3", "--", "*.ts"]);
      expect(result).toBe("output");
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "HEAD~3",
          "--",
          "*.ts",
        ],
        { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
      );
    });
  });

  describe("getGitDiff", () => {
    it("returns unstaged + staged when both enabled", async () => {
      mockExecFileSync
        .mockReturnValueOnce("unstaged\n")
        .mockReturnValueOnce("staged\n");
      const { getGitDiff } = await import("../lib/git.js");
      expect(getGitDiff({ staged: true, untracked: false })).toBe(
        "unstaged\n\nstaged\n",
      );
    });

    it("skips empty staged section", async () => {
      mockExecFileSync
        .mockReturnValueOnce("unstaged\n")
        .mockReturnValueOnce("");
      const { getGitDiff } = await import("../lib/git.js");
      expect(getGitDiff({ staged: true, untracked: false })).toBe("unstaged\n");
    });

    it("returns only unstaged with no options", async () => {
      mockExecFileSync.mockReturnValueOnce("unstaged diff");
      const { getGitDiff } = await import("../lib/git.js");
      expect(getGitDiff()).toBe("unstaged diff");
    });
  });

  describe("getTabSizeForFiles", () => {
    it("uses tab_width from editorconfig", async () => {
      mockExecFileSync.mockReturnValue("/repo\n");
      mockParseEditorConfig.mockReturnValue({ tab_width: 2, indent_size: 2 });
      const { getTabSizeForFiles } = await import("../lib/git.js");
      expect(getTabSizeForFiles(["src/index.ts"])).toEqual({
        "src/index.ts": 2,
      });
    });

    it("falls back to indent_size", async () => {
      mockExecFileSync.mockReturnValue("/repo\n");
      mockParseEditorConfig.mockReturnValue({ indent_size: 4 });
      const { getTabSizeForFiles } = await import("../lib/git.js");
      expect(getTabSizeForFiles(["src/index.ts"])).toEqual({
        "src/index.ts": 4,
      });
    });

    it("skips files on error", async () => {
      mockExecFileSync.mockReturnValue("/repo\n");
      mockParseEditorConfig.mockImplementation(() => {
        throw new Error("fail");
      });
      const { getTabSizeForFiles } = await import("../lib/git.js");
      expect(getTabSizeForFiles(["src/index.ts"])).toEqual({});
    });
  });

  describe("getUntrackedFilePaths", () => {
    it("splits output by newline", async () => {
      mockExecFileSync.mockReturnValue("a.ts\nb.ts\n");
      const { getUntrackedFilePaths } = await import("../lib/git.js");
      expect(getUntrackedFilePaths()).toEqual(["a.ts", "b.ts"]);
    });

    it("returns empty array for empty output", async () => {
      mockExecFileSync.mockReturnValue("");
      const { getUntrackedFilePaths } = await import("../lib/git.js");
      expect(getUntrackedFilePaths()).toEqual([]);
    });
  });

  describe("getFileContent", () => {
    it("rejects with invalid-path code for unsafe path", async () => {
      mockIsSafePath.mockReturnValue(false);
      mockExecFileSync.mockReturnValue("/repo\n");
      const { getFileContent } = await import("../lib/git.js");
      await expect(
        getFileContent("../etc/passwd", "new"),
      ).rejects.toMatchObject({ code: "invalid-path" });
    });

    it("reads new content through the capability-backed native fs", async () => {
      mockIsSafePath.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("/repo\n");
      mockNativeRead.mockResolvedValue({
        bytes: Buffer.from("file"),
        sha256:
          "3b9c358f36f0a31b6ad3e14f309c7cf198ac9246e8316f9ce543d5b19ac02b80",
      });
      const { getFileContent } = await import("../lib/git.js");
      expect(await getFileContent("src/index.ts", "new")).toEqual(
        Buffer.from("file"),
      );
      expect(mockNativeRead).toHaveBeenCalledWith("src/index.ts");
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    it("returns null when native read reports not-found", async () => {
      mockIsSafePath.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("/repo\n");
      const { NativeFsError } = await import("../lib/native-fs.js");
      mockNativeRead.mockRejectedValue(new NativeFsError("not-found"));
      const { getFileContent } = await import("../lib/git.js");
      expect(await getFileContent("src/index.ts", "new")).toBeNull();
    });

    it("propagates native read denial instead of returning null", async () => {
      mockIsSafePath.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("/repo\n");
      const { NativeFsError } = await import("../lib/native-fs.js");
      mockNativeRead.mockRejectedValue(new NativeFsError("denied"));
      const { getFileContent } = await import("../lib/git.js");
      await expect(getFileContent("src/index.ts", "new")).rejects.toMatchObject(
        { code: "denied", status: 403 },
      );
    });

    it("propagates native unavailability instead of returning null", async () => {
      mockIsSafePath.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("/repo\n");
      const { NativeFsError } = await import("../lib/native-fs.js");
      mockNativeRead.mockRejectedValue(new NativeFsError("unavailable"));
      const { getFileContent } = await import("../lib/git.js");
      await expect(getFileContent("src/index.ts", "new")).rejects.toMatchObject(
        { code: "unavailable", status: 503 },
      );
    });

    it("reads old content from git via promisified execFile", async () => {
      mockIsSafePath.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("/repo\n");
      // The generic promisify mock resolves a single callback result.
      mockExecFile.mockImplementationOnce(
        (
          _cmd: string,
          _args: string[] | undefined,
          _opts: unknown,
          cb: BufferExecCallback,
        ) => {
          cb(null, {
            stdout: Buffer.from("old content"),
            stderr: Buffer.alloc(0),
          });
        },
      );
      const { getFileContent } = await import("../lib/git.js");
      expect(await getFileContent("src/index.ts", "old")).toEqual(
        Buffer.from("old content"),
      );
      // Avoid printing exec options, which contain the inherited environment.
      expect(mockExecFile.mock.calls[0][0]).toBe("git");
      expect(mockExecFile.mock.calls[0][1]).toEqual([
        "show",
        "HEAD:src/index.ts",
      ]);
    });

    it("returns null when the old file lookup errors", async () => {
      mockIsSafePath.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("/repo\n");
      mockExecFile.mockImplementationOnce(
        (
          _cmd: string,
          _args: string[] | undefined,
          _opts: unknown,
          cb: BufferExecCallback,
        ) => {
          cb(new Error("fatal: path does not exist"));
        },
      );
      const { getFileContent } = await import("../lib/git.js");
      expect(await getFileContent("newfile.ts", "old")).toBeNull();
    });
  });

  describe("getProjectStorageDir", () => {
    it("returns correct path format under homedir", async () => {
      mockExecFileSync.mockReturnValue("/Users/user/projects/my-repo\n");
      const { getProjectStorageDir } = await import("../lib/git.js");
      const dir = getProjectStorageDir();
      expect(dir).toContain(".diffing");
      expect(dir).toContain("my-repo-");
    });

    it("respects customRepoRoot when provided", async () => {
      const { getProjectStorageDir } = await import("../lib/git.js");
      const dir = getProjectStorageDir("/custom/path/some-repo");
      expect(dir).toContain(".diffing");
      expect(dir).toContain("some-repo-");
    });
  });

  describe("getFilePatch — CRLF handling", () => {
    // The untracked-file synthesizer reads the file from disk and emits one
    // `+line` per source line. Before the fix it split on a literal `'\n'`,
    // which on Windows left a trailing `\r` on every line and inflated the
    // hunk header's line count when the file ended in CRLF.

    it("strips trailing CR from CRLF-terminated untracked file", async () => {
      mockIsSafePath.mockReturnValue(true);
      mockExecFileSync
        .mockReturnValueOnce("") // `git diff` -> no output (untracked)
        .mockReturnValueOnce("/repo\n"); // getRepoRoot inside the untracked branch
      mockReadFileSync.mockImplementation((p: string) =>
        p === "/repo/new-windows-file.ts"
          ? "line one\r\nline two\r\nline three\r\n"
          : Buffer.from(""),
      );
      const { getFilePatch } = await import("../lib/git.js");
      const patch = getFilePatch("new-windows-file.ts");

      // No stray \r at the end of any added line.
      for (const line of patch.split("\n").filter((l) => l.startsWith("+"))) {
        expect(line.endsWith("\r")).toBe(false);
      }

      // The header should match the actual line count after CRLF-aware split:
      // ["line one", "line two", "line three", ""] → 4 elements.
      expect(patch).toContain("@@ -0,0 +1,4 @@");
      expect(patch).toContain("+line one");
      expect(patch).toContain("+line two");
      expect(patch).toContain("+line three");
    });

    it("handles plain LF file unchanged", async () => {
      mockIsSafePath.mockReturnValue(true);
      mockExecFileSync.mockReturnValueOnce("").mockReturnValueOnce("/repo\n");
      mockReadFileSync.mockImplementation((p: string) =>
        p === "/repo/posix-file.ts" ? "a\nb\nc\n" : Buffer.from(""),
      );
      const { getFilePatch } = await import("../lib/git.js");
      const patch = getFilePatch("posix-file.ts");

      expect(patch).toContain("@@ -0,0 +1,4 @@");
      expect(patch).toContain("+a\n+b\n+c\n+");
    });

    it("handles legacy CR-only line endings", async () => {
      // Classic Mac line endings — vanishingly rare but legal, and a stray
      // \r in the middle of the diff stream would corrupt the UI just like
      // CRLF does.
      mockIsSafePath.mockReturnValue(true);
      mockExecFileSync.mockReturnValueOnce("").mockReturnValueOnce("/repo\n");
      mockReadFileSync.mockImplementation((p: string) =>
        p === "/repo/classic-mac.txt" ? "foo\rbar\rbaz" : Buffer.from(""),
      );
      const { getFilePatch } = await import("../lib/git.js");
      const patch = getFilePatch("classic-mac.txt");

      expect(patch).toContain("@@ -0,0 +1,3 @@");
      expect(patch).toContain("+foo");
      expect(patch).toContain("+bar");
      expect(patch).toContain("+baz");
      // No stray \r anywhere in the synthesized output.
      expect(patch.includes("\r")).toBe(false);
    });

    it("handles mixed CRLF/LF in one file", async () => {
      mockIsSafePath.mockReturnValue(true);
      mockExecFileSync.mockReturnValueOnce("").mockReturnValueOnce("/repo\n");
      mockReadFileSync.mockImplementation((p: string) =>
        p === "/repo/mixed.txt" ? "win\r\nposix\nmac\r\n" : Buffer.from(""),
      );
      const { getFilePatch } = await import("../lib/git.js");
      const patch = getFilePatch("mixed.txt");

      expect(patch).toContain("+win");
      expect(patch).toContain("+posix");
      expect(patch).toContain("+mac");
      expect(patch.includes("\r")).toBe(false);
    });
  });

  describe("getCommitSeriesSummary", () => {
    // The async helper goes through `execFile` (callback-style) which
    // `promisify` wraps. Mock the underlying callback to keep the test
    // path identical to the real one.
    function queueExecFile(stdout: string, stderr = "") {
      // Node's `util.promisify(execFile)` installs a custom callback shim that
      // wraps the `(stdout, stderr)` pair into a single `{ stdout, stderr }`
      // object before resolving. Our mock would otherwise pass three args to
      // the callback, which `promisify` would turn into the *array*
      // `[stdout, stderr]` — and `const { stdout } = await …` destructures
      // that to `undefined`, making every subsequent `.split()` throw.
      // Passing a single object argument keeps the resolved value in the
      // shape the production code expects.
      mockExecFile.mockImplementationOnce(
        (
          _cmd: string,
          _args: string[] | undefined,
          _opts: unknown,
          cb: any,
        ) => {
          cb(null, { stdout, stderr });
        },
      );
    }

    it("returns an empty summary when called with no revspecs", async () => {
      const { getCommitSeriesSummary } = await import("../lib/git.js");
      const result = await getCommitSeriesSummary([]);
      expect(result).toEqual({
        commitCount: 0,
        truncated: 0,
        subjects: [],
        authors: [],
      });
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("summarises a single SHA revspec", async () => {
      // First `git rev-list` returns just the one commit, then the
      // metadata fetch returns subject/author/date NUL-separated.
      queueExecFile("1111111111111111111111111111111111111111\n");
      queueExecFile("first commit\u0000Alice\u00002026-01-02T10:00:00+00:00\n");

      const { getCommitSeriesSummary } = await import("../lib/git.js");
      const result = await getCommitSeriesSummary(["HEAD"]);

      expect(result.commitCount).toBe(1);
      expect(result.truncated).toBe(0);
      expect(result.subjects).toEqual(["first commit"]);
      expect(result.authors).toEqual(["Alice"]);
      expect(result.fromDate).toBe("2026-01-02T10:00:00+00:00");
      expect(result.toDate).toBe("2026-01-02T10:00:00+00:00");

      // First call: `rev-list --no-walk --reverse HEAD` (no pathspec → no `--`).
      expect(mockExecFile.mock.calls[0][0]).toBe("git");
      expect(mockExecFile.mock.calls[0][1]).toEqual([
        "rev-list",
        "--no-walk",
        "--reverse",
        "HEAD",
      ]);
    });

    it("summarises a range revspec and passes pathspecs through", async () => {
      queueExecFile("aaa\naaa\n");
      queueExecFile(
        "one\u0000Alice\u00002026-01-01T00:00:00+00:00\n" +
          "two\u0000Bob\u00002026-02-01T00:00:00+00:00\n",
      );

      const { getCommitSeriesSummary } = await import("../lib/git.js");
      const result = await getCommitSeriesSummary(["main..feature"], ["src/"]);

      expect(result.commitCount).toBe(2);
      expect(result.subjects).toEqual(["one", "two"]);
      expect(result.authors).toEqual(["Alice", "Bob"]);
      expect(result.fromDate).toBe("2026-01-01T00:00:00+00:00");
      expect(result.toDate).toBe("2026-02-01T00:00:00+00:00");

      // rev-list call: range + pathspec via `--`.
      expect(mockExecFile.mock.calls[0][1]).toEqual([
        "rev-list",
        "--no-walk",
        "--reverse",
        "main..feature",
        "--",
        "src/",
      ]);
      // metadata call: includes the standardised DIFF_FLAGS so we never
      // re-invoke the user's diff.external / textconv drivers.
      expect(mockExecFile.mock.calls[1][1]).toEqual([
        "log",
        "--no-walk",
        "--reverse",
        "--pretty=%s%x00%an%x00%aI",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "aaa",
        "aaa",
        "--",
        "src/",
      ]);
    });

    it("reports truncated when the range resolves to more than MAX_SHOW_COMMITS", async () => {
      // 105 SHAs returned by rev-list; only 100 (MAX_SHOW_COMMITS) should
      // be passed to the metadata fetch.
      const shas =
        Array.from({ length: 105 }, (_, i) => `sha-${i}`).join("\n") + "\n";
      queueExecFile(shas);
      // The metadata call gets the trimmed 100 SHAs.
      const trimmedShas =
        Array.from({ length: 100 }, (_, i) => `sha-${i}`).join("\n") + "\n";
      queueExecFile(trimmedShas);

      const { getCommitSeriesSummary, MAX_SHOW_COMMITS } = await import(
        "../lib/git.js"
      );
      const result = await getCommitSeriesSummary(["main..HEAD"]);

      expect(result.commitCount).toBe(105);
      expect(result.truncated).toBe(5);
      expect(result.subjects.length).toBe(MAX_SHOW_COMMITS);
    });

    it("returns an empty summary when rev-list yields nothing", async () => {
      queueExecFile("");
      const { getCommitSeriesSummary } = await import("../lib/git.js");
      const result = await getCommitSeriesSummary(["nonexistent..HEAD"]);

      expect(result).toEqual({
        commitCount: 0,
        truncated: 0,
        subjects: [],
        authors: [],
      });
    });

    it("returns an empty summary when rev-list throws (bad revspec)", async () => {
      mockExecFile.mockImplementationOnce(
        (_cmd: string, _args: unknown, _opts: unknown, cb: any) => {
          cb(new Error("unknown revision"), "", "");
        },
      );
      const { getCommitSeriesSummary } = await import("../lib/git.js");
      const result = await getCommitSeriesSummary(["nope..also-nope"]);
      expect(result.commitCount).toBe(0);
    });

    it("returns an empty subjects list (but accurate totals) when the metadata fetch fails", async () => {
      // rev-list succeeds with 3 SHAs …
      queueExecFile("a\nb\nc\n");
      // … but the log call throws.
      mockExecFile.mockImplementationOnce(
        (_cmd: string, _args: unknown, _opts: unknown, cb: any) => {
          cb(new Error("boom"), "", "");
        },
      );
      const { getCommitSeriesSummary } = await import("../lib/git.js");
      const result = await getCommitSeriesSummary(["main..HEAD"]);

      expect(result.commitCount).toBe(3);
      expect(result.subjects).toEqual([]);
      expect(result.authors).toEqual([]);
    });
  });
});
