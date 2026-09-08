import { describe, expect, it } from "vitest";
import { resolveDiffSnapshot } from "../diff-snapshot.js";
import { AiSnapshotError, sourceHash } from "../snapshots.js";
import type { AiDiffContext } from "../types.js";

const identity = { kind: "local" as const, repositoryId: "repo", mode: "working" as const, baseSha: null, headSha: null, indexHash: null, patchHash: "" };
const patch = (oldPath: string, newPath = oldPath, body = "@@ -1 +1 @@\n-old\n+new\n") => `diff --git a/${oldPath} b/${newPath}\nindex 1111111..2222222 100644\n--- a/${oldPath}\n+++ b/${newPath}\n${body}`;
function capture(text: string, omissions: string[] = []) { return { identity: { ...identity, patchHash: sourceHash(text) }, patch: text, omissions }; }
function code(fn: () => unknown, expected: AiSnapshotError["code"]) { try { fn(); throw new Error("expected error"); } catch (e) { expect(e).toBeInstanceOf(AiSnapshotError); expect((e as AiSnapshotError).code).toBe(expected); } }
const context = (overrides: Partial<AiDiffContext> = {}): AiDiffContext => ({ kind: "diff", patch: "forged browser text", ...overrides });

describe("resolveDiffSnapshot", () => {
  it("uses captured patch, keeps focused diff whole, and preserves duplicate occurrences", () => {
    const text = patch("same.ts", "same.ts", "@@ -1 +1 @@\n-a\n+b\n") + patch("same.ts", "same.ts", "@@ -4 +4 @@\n-c\n+d\n");
    const resolved = resolveDiffSnapshot(context({ focusedFilePath: "other.ts" }), capture(text), "/repo");
    expect(resolved.context.patch).toBe(text);
    expect(resolved.context.patch).not.toContain("forged");
    expect(resolved.snapshot.manifest.sources).toHaveLength(2);
    expect(resolved.snapshot.manifest.sources.every(s => s.complete === false && s.representation === "unified-patch")).toBe(true);
    expect(resolved.snapshot.coverage().returnedLines).toBe(0);
  });
  it("matches either side of renames and supports Git quoted paths", () => {
    const renamed = patch("old name.ts", "new name.ts");
    expect(resolveDiffSnapshot(context({ kind: "file", filePath: "old name.ts" }), capture(renamed), "/repo").snapshot.manifest.sources).toHaveLength(1);
    expect(resolveDiffSnapshot(context({ kind: "file", filePath: "new name.ts" }), capture(renamed), "/repo").snapshot.manifest.sources).toHaveLength(1);
    const quoted = 'diff --git "a/weird\\303\\251 name.ts" "b/weird\\303\\251 name.ts"\n--- "a/weird\\303\\251 name.ts"\n+++ "b/weird\\303\\251 name.ts"\n';
    expect(resolveDiffSnapshot(context({ kind: "file", filePath: "weirdé name.ts" }), capture(quoted), "/repo").snapshot.manifest.sources).toHaveLength(1);
  });
  it("carries captured originals alongside the patch and says offsets are not file lines", () => {
    const text = patch("src/a.ts");
    const originals = [
      { key: "old:src/a.ts", path: "src/a.ts", side: "old" as const, revision: "HEAD", content: "old\n", complete: true, provenance: "recorded" as const, representation: "original" as const },
      { key: "new:src/a.ts", path: "src/a.ts", side: "new" as const, revision: "worktree", content: "new\n", complete: true, provenance: "reconstructed" as const, representation: "original" as const },
    ];
    const resolved = resolveDiffSnapshot(context(), { ...capture(text), originals }, "/repo");
    const sources = resolved.snapshot.manifest.sources;
    expect(sources.filter((s) => s.representation === "original")).toHaveLength(2);
    expect(sources.filter((s) => s.representation === "unified-patch")).toHaveLength(1);
    // With originals present the capture must stop claiming no coverage.
    expect(resolved.snapshot.manifest.omissions.join(" ")).toContain("cite original-file lines");
    expect(resolved.snapshot.manifest.omissions.join(" ")).not.toContain("Original-file coverage is not established");
    // The original lines are real file lines and are readable as such.
    expect(resolved.snapshot.read("new:src/a.ts", 1, 1).text).toBe("new");
  });
  it("keeps only the scoped path's originals and refuses an unsafe original path", () => {
    const text = patch("src/a.ts") + patch("src/b.ts");
    const original = (path: string) => ({ key: `new:${path}`, path, side: "new" as const, revision: "worktree", content: "x\n", complete: true, provenance: "recorded" as const, representation: "original" as const });
    const scoped = resolveDiffSnapshot(context({ kind: "file", filePath: "src/a.ts" }), { ...capture(text), originals: [original("src/a.ts"), original("src/b.ts")] }, "/repo");
    expect(scoped.snapshot.manifest.sources.filter((s) => s.representation === "original").map((s) => s.path)).toEqual(["src/a.ts"]);
    code(() => resolveDiffSnapshot(context(), { ...capture(text), originals: [original("../escape.ts")] }, "/repo"), "invalid");
  });
  it("rejects unsafe paths, missing scope, stale hashes, malformed/combined patches, and oversized patches", () => {
    code(() => resolveDiffSnapshot(context({ kind: "file", filePath: "../x" }), capture(patch("x")), "/repo"), "invalid");
    code(() => resolveDiffSnapshot(context({ kind: "file", filePath: "missing.ts" }), capture(patch("x")), "/repo"), "missing");
    code(() => resolveDiffSnapshot(context(), { ...capture(patch("x")), identity: { ...identity, patchHash: "bad" } }), "stale");
    code(() => resolveDiffSnapshot(context(), capture("diff --combined a.ts\n")), "unsupported");
    code(() => resolveDiffSnapshot(context(), capture("not a patch\n")), "unsupported");
    const huge = "diff --git a/x b/x\n" + "x".repeat(4 * 1024 * 1024);
    code(() => resolveDiffSnapshot(context(), capture(huge), "/repo"), "limit");
    code(() => resolveDiffSnapshot(context(), capture(patch("../outside")), "/repo"), "invalid");
  });
});
