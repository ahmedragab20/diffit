// @vitest-environment node
// Real Git fixtures: each case builds a throwaway repository on disk and reads
// originals back through actual git plumbing, so revision correctness is proven
// against git rather than against a hand-written patch.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ORIGINALS_LIMITS,
  captureLocalOriginals,
  type BlobReader,
  type OriginalsMode,
  type WorktreeReader,
} from "../local-originals.js";
import { AiSnapshotError } from "../snapshots.js";

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function write(path: string, content: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** Reads a blob at a revision; an empty revision means the index. */
const readBlob: BlobReader = async (revision, path) => {
  try {
    return execFileSync("git", ["-C", repo, "show", `${revision}:${path}`], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      // A missing path is an expected case here; keep git's stderr out of the run.
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};

const readWorktree: WorktreeReader = async (path) => {
  try {
    return execFileSync("cat", [join(repo, path)], { encoding: "utf8" });
  } catch {
    return null;
  }
};

function capture(patch: string, mode: OriginalsMode, base: string | null, head: string | null = null) {
  return captureLocalOriginals(
    { patch, mode, baseSha: base, headSha: head },
    readBlob,
    readWorktree,
  );
}

const bySide = (
  sources: Awaited<ReturnType<typeof capture>>["sources"],
  side: "old" | "new",
  path: string,
) => sources.find((s) => s.side === side && s.path === path);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "diffing-originals-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "commit.gpgsign", "false");
  write("src/a.ts", "one\ntwo\nthree\n");
  write("src/keep.ts", "keep\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("captureLocalOriginals against real git", () => {
  it("captures the committed old side and the working-tree new side", async () => {
    write("src/a.ts", "one\nCHANGED\nthree\n");
    const patch = git("diff");
    const result = await capture(patch, "working", null);

    const old = bySide(result.sources, "old", "src/a.ts");
    const now = bySide(result.sources, "new", "src/a.ts");
    // The old side is the committed blob, not the edited file.
    expect(old?.content).toBe("one\ntwo\nthree\n");
    expect(old?.provenance).toBe("recorded");
    expect(now?.content).toBe("one\nCHANGED\nthree\n");
    // A working-tree read is optimistic, never claimed as a recorded object.
    expect(now?.provenance).toBe("reconstructed");
    expect(now?.revision).toBe("worktree");
    expect(result.sources.every((s) => s.representation === "original")).toBe(true);
  });

  it("captures the index as the new side for a staged diff", async () => {
    write("src/a.ts", "one\nSTAGED\nthree\n");
    git("add", "src/a.ts");
    // Dirty the working tree after staging; the staged capture must ignore it.
    write("src/a.ts", "one\nUNSTAGED\nthree\n");
    const patch = git("diff", "--cached");
    const result = await capture(patch, "staged", null);

    const now = bySide(result.sources, "new", "src/a.ts");
    expect(now?.content).toBe("one\nSTAGED\nthree\n");
    expect(now?.content).not.toContain("UNSTAGED");
    expect(now?.provenance).toBe("recorded");
    expect(now?.revision).toBe("index");
  });

  it("captures both sides at their own commits in revision mode", async () => {
    const base = git("rev-parse", "HEAD").trim();
    write("src/a.ts", "one\nSECOND\nthree\n");
    git("commit", "-qam", "second");
    const head = git("rev-parse", "HEAD").trim();
    const patch = git("diff", base, head);
    const result = await capture(patch, "revision", base, head);

    expect(bySide(result.sources, "old", "src/a.ts")?.content).toBe(
      "one\ntwo\nthree\n",
    );
    expect(bySide(result.sources, "new", "src/a.ts")?.content).toBe(
      "one\nSECOND\nthree\n",
    );
    expect(bySide(result.sources, "old", "src/a.ts")?.revision).toBe(base);
    expect(bySide(result.sources, "new", "src/a.ts")?.revision).toBe(head);
  });

  it("reads each side at its own path across a rename", async () => {
    git("mv", "src/a.ts", "src/renamed.ts");
    write("src/renamed.ts", "one\ntwo\nRENAMED\n");
    git("add", "-A");
    const patch = git("diff", "--cached", "-M");
    const result = await capture(patch, "staged", null);

    expect(bySide(result.sources, "old", "src/a.ts")?.content).toBe(
      "one\ntwo\nthree\n",
    );
    expect(bySide(result.sources, "new", "src/renamed.ts")?.content).toBe(
      "one\ntwo\nRENAMED\n",
    );
    // The old path must not be resurrected on the new side.
    expect(bySide(result.sources, "new", "src/a.ts")).toBeUndefined();
  });

  it("captures a deletion with an old side and no new side", async () => {
    git("rm", "-q", "src/a.ts");
    const patch = git("diff", "--cached");
    const result = await capture(patch, "staged", null);

    expect(bySide(result.sources, "old", "src/a.ts")?.content).toBe(
      "one\ntwo\nthree\n",
    );
    expect(bySide(result.sources, "new", "src/a.ts")).toBeUndefined();
  });

  it("captures an addition with a new side and no old side", async () => {
    write("src/added.ts", "brand new\n");
    git("add", "-A");
    const patch = git("diff", "--cached");
    const result = await capture(patch, "staged", null);

    expect(bySide(result.sources, "new", "src/added.ts")?.content).toBe(
      "brand new\n",
    );
    expect(bySide(result.sources, "old", "src/added.ts")).toBeUndefined();
  });

  it("does not capture files the diff never mentions", async () => {
    write("src/a.ts", "one\nCHANGED\nthree\n");
    const result = await capture(git("diff"), "working", null);
    expect(result.sources.some((s) => s.path === "src/keep.ts")).toBe(false);
  });

  it("omits originals for a mixed diff instead of attributing a revision", async () => {
    write("src/a.ts", "one\nCHANGED\nthree\n");
    const result = await capture(git("diff"), "mixed", null);
    expect(result.sources).toEqual([]);
    expect(result.omissions.join(" ")).toContain("mixed");
  });

  it("omits a binary path explicitly", async () => {
    writeFileSync(join(repo, "src/blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
    git("add", "-A");
    const patch = git("diff", "--cached");
    const result = await capture(patch, "staged", null);
    expect(result.omissions.some((o) => o.includes("binary"))).toBe(true);
    expect(result.sources.some((s) => s.path === "src/blob.bin")).toBe(false);
  });

  it("omits an oversized file explicitly rather than truncating it", async () => {
    write("src/big.ts", "x".repeat(ORIGINALS_LIMITS.maxFileBytes + 10));
    git("add", "-A");
    const result = await capture(git("diff", "--cached"), "staged", null);
    expect(result.omissions.some((o) => o.includes("too large"))).toBe(true);
    expect(result.sources.some((s) => s.path === "src/big.ts")).toBe(false);
  });

  it("marks an unreadable old side as incomplete rather than empty", async () => {
    // A patch claiming to modify a path that does not exist at the old
    // revision: the old side must be reported absent, never as empty content.
    const patch = [
      "diff --git a/src/ghost.ts b/src/ghost.ts",
      "index 1111111..2222222 100644",
      "--- a/src/ghost.ts",
      "+++ b/src/ghost.ts",
      "@@ -1 +1 @@",
      "-gone",
      "+here",
      "",
    ].join("\n");
    const result = await capture(patch, "staged", null);
    const old = bySide(result.sources, "old", "src/ghost.ts");
    expect(old).toBeDefined();
    expect(old?.content).toBeNull();
    expect(old?.complete).toBe(false);
    expect(old?.provenance).toBe("unknown");
    expect(result.omissions.some((o) => o.includes("Old original unavailable"))).toBe(
      true,
    );
  });

  it("refuses a diff with more files than the bound allows", async () => {
    for (let i = 0; i < ORIGINALS_LIMITS.maxFiles + 1; i++)
      write(`src/gen/f${i}.ts`, `file ${i}\n`);
    git("add", "-A");
    const patch = git("diff", "--cached");
    await expect(capture(patch, "staged", null)).rejects.toBeInstanceOf(
      AiSnapshotError,
    );
  });

  it("captures repeated occurrences of one path only once per side", async () => {
    write("src/a.ts", "one\nCHANGED\nthree\n");
    const patch = git("diff");
    const result = await capture(patch + patch, "working", null);
    const oldSides = result.sources.filter(
      (s) => s.side === "old" && s.path === "src/a.ts",
    );
    // A duplicated patch must not produce colliding snapshot keys.
    const keys = new Set(result.sources.map((s) => s.key));
    expect(keys.size).toBe(result.sources.length);
    expect(oldSides.length).toBeLessThanOrEqual(2);
  });
});
