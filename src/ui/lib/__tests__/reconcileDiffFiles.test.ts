import { describe, expect, it } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import { reconcileDiffFiles } from "../reconcileDiffFiles";

const patch = (text: string) =>
  parsePatchFiles(
    `diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-const n = 0\n+${text}\n`,
  )[0].files[0];

describe("reconcileDiffFiles", () => {
  it("reuses identical parsed files and their cache key", () => {
    const [first] = reconcileDiffFiles([], [patch("const n = 1")]);
    const second = patch("const n = 1");
    const [result] = reconcileDiffFiles([first], [second]);
    expect(result).toBe(first);
    expect(result.cacheKey).toBe(first.cacheKey);
  });

  it("replaces same-count files when text changes", () => {
    const [previous] = reconcileDiffFiles([], [patch("const n = 1")]);
    const incoming = patch("const n = 2");
    const [result] = reconcileDiffFiles([previous], [incoming]);
    expect(result).not.toBe(previous);
    expect(result).toBe(incoming);
    expect(result.cacheKey).not.toBe(previous.cacheKey);
    expect(JSON.stringify(result)).toContain("const n = 2");
  });

  it("replaces a file when prevName changes", () => {
    const previous = patch("const n = 1");
    const incoming = patch("const n = 1");
    previous.prevName = "old.ts";
    incoming.prevName = "new.ts";
    const [result] = reconcileDiffFiles([previous], [incoming]);
    expect(result).not.toBe(previous);
    expect(result.cacheKey).not.toBe(previous.cacheKey);
  });

  it("omits removed files", () => {
    const kept = patch("const n = 1");
    expect(reconcileDiffFiles([kept], [])).toEqual([]);
  });
});
