import { describe, expect, it, vi } from "vitest";
import {
  PR_ORIGINALS_LIMITS,
  capturePrOriginals,
  createPrOriginalsCache,
  type PrOriginsIdentity,
} from "../pr-originals.js";

const identity: PrOriginsIdentity = {
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  baseSha: "b".repeat(40),
  headSha: "h".repeat(40),
  mergeBaseSha: "m".repeat(40),
};

const patch = (path: string) =>
  `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

/** Returns per-revision content, and records every fetch it was asked for. */
function fetcher(contents: Record<string, string | null>) {
  const calls: { path: string; sha: string }[] = [];
  const fetch = vi.fn(
    async (
      _target: { host: string; owner: string; repo: string },
      path: string,
      sha: string,
    ) => {
      calls.push({ path, sha });
      const value = contents[`${sha}:${path}`];
      return value === undefined || value === null ? null : Buffer.from(value);
    },
  );
  return { fetch, calls };
}

const bySide = (
  result: Awaited<ReturnType<typeof capturePrOriginals>>,
  side: "old" | "new",
) => result.sources.find((source) => source.side === side);

describe("capturePrOriginals", () => {
  it("reads the old side at the merge base and the new side at head", async () => {
    const { fetch, calls } = fetcher({
      [`${identity.mergeBaseSha}:src/a.ts`]: "old\n",
      [`${identity.headSha}:src/a.ts`]: "new\n",
    });
    const result = await capturePrOriginals(identity, patch("src/a.ts"), fetch);
    expect(bySide(result, "old")?.content).toBe("old\n");
    expect(bySide(result, "new")?.content).toBe("new\n");
    expect(calls.map((call) => call.sha)).toEqual([
      identity.mergeBaseSha,
      identity.headSha,
    ]);
    expect(result.sources.every((s) => s.representation === "original")).toBe(
      true,
    );
  });

  it("falls back to the base commit when no merge base is known", async () => {
    const withoutMergeBase = { ...identity, mergeBaseSha: null };
    const { fetch, calls } = fetcher({
      [`${identity.baseSha}:src/a.ts`]: "old\n",
      [`${identity.headSha}:src/a.ts`]: "new\n",
    });
    await capturePrOriginals(withoutMergeBase, patch("src/a.ts"), fetch);
    expect(calls[0].sha).toBe(identity.baseSha);
  });

  it("reuses the cache instead of re-fetching across captures", async () => {
    const { fetch } = fetcher({
      [`${identity.mergeBaseSha}:src/a.ts`]: "old\n",
      [`${identity.headSha}:src/a.ts`]: "new\n",
    });
    const cache = createPrOriginalsCache();
    await capturePrOriginals(identity, patch("src/a.ts"), fetch, cache);
    expect(fetch).toHaveBeenCalledTimes(2);
    await capturePrOriginals(identity, patch("src/a.ts"), fetch, cache);
    // The second capture must be served entirely from the cache.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not confuse two revisions of one path", async () => {
    const { fetch } = fetcher({
      [`${identity.mergeBaseSha}:src/a.ts`]: "old\n",
      [`${identity.headSha}:src/a.ts`]: "new\n",
    });
    const cache = createPrOriginalsCache();
    const result = await capturePrOriginals(
      identity,
      patch("src/a.ts"),
      fetch,
      cache,
    );
    expect(bySide(result, "old")?.content).not.toBe(
      bySide(result, "new")?.content,
    );
  });

  it("records an unavailable original as incomplete rather than empty", async () => {
    const { fetch } = fetcher({
      [`${identity.headSha}:src/a.ts`]: "new\n",
    });
    const result = await capturePrOriginals(identity, patch("src/a.ts"), fetch);
    const old = bySide(result, "old");
    expect(old?.content).toBeNull();
    expect(old?.complete).toBe(false);
    expect(old?.provenance).toBe("unknown");
    expect(result.omissions.join(" ")).toContain("Old original unavailable");
  });

  it("treats a fetch failure as an absent original, not a capture failure", async () => {
    const failing = vi.fn(async () => {
      throw new Error("rate limited");
    });
    const result = await capturePrOriginals(
      identity,
      patch("src/a.ts"),
      failing,
    );
    expect(result.sources.every((source) => source.content === null)).toBe(true);
    expect(result.omissions.length).toBeGreaterThan(0);
  });

  it("refuses binary content as original-file evidence", async () => {
    const binary = vi.fn(async () => Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const result = await capturePrOriginals(identity, patch("src/a.ts"), binary);
    expect(result.sources.every((source) => source.content === null)).toBe(true);
  });

  it("omits paths past its bound instead of refusing the capture", async () => {
    const paths = Array.from(
      { length: PR_ORIGINALS_LIMITS.maxFiles + 3 },
      (_, index) => `src/f${index}.ts`,
    );
    const contents: Record<string, string> = {};
    for (const path of paths) {
      contents[`${identity.mergeBaseSha}:${path}`] = "old\n";
      contents[`${identity.headSha}:${path}`] = "new\n";
    }
    const { fetch } = fetcher(contents);
    const result = await capturePrOriginals(
      identity,
      paths.map(patch).join(""),
      fetch,
    );
    expect(result.omissions.join(" ")).toContain("3 further path");
    // The bound must actually cap the network reads, not just the output.
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(
      PR_ORIGINALS_LIMITS.maxFiles * 2,
    );
  });

  it("never reads the working tree for a pull request", async () => {
    const { fetch, calls } = fetcher({
      [`${identity.mergeBaseSha}:src/a.ts`]: "old\n",
      [`${identity.headSha}:src/a.ts`]: "new\n",
    });
    const result = await capturePrOriginals(identity, patch("src/a.ts"), fetch);
    expect(result.sources.map((source) => source.revision)).toEqual([
      identity.mergeBaseSha,
      identity.headSha,
    ]);
    expect(calls.every((call) => call.sha.length === 40)).toBe(true);
  });
});
