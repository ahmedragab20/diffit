import { describe, expect, it } from "vitest";
import { capturePrReview } from "../pr-snapshot.js";
import {
  AiSnapshotError,
  ReviewSnapshot,
  sourceHash,
  type SnapshotIdentity,
  type SnapshotSourceInput,
} from "../snapshots.js";
import type { PrSession } from "../../pr-session.js";

const identity: SnapshotIdentity = {
  kind: "plan",
  planId: "p",
  version: 1,
  bodyHash: sourceHash("one\ntwo\nthree\n"),
  titleHash: sourceHash("P"),
};
function input(
  overrides: Partial<SnapshotSourceInput> = {},
): SnapshotSourceInput {
  return {
    key: "plan",
    path: "plan/p",
    side: "document",
    revision: "v1",
    content: "one\ntwo\nthree\n",
    complete: true,
    provenance: "recorded",
    ...overrides,
  };
}
function expectCode(fn: () => unknown, code: AiSnapshotError["code"]): void {
  try {
    fn();
    throw new Error("expected snapshot error");
  } catch (error) {
    expect(error).toBeInstanceOf(AiSnapshotError);
    expect((error as AiSnapshotError).code).toBe(code);
  }
}

describe("ReviewSnapshot", () => {
  it("captures immutable manifests, bounded evidence, and union coverage", () => {
    const capturedIdentity: SnapshotIdentity = { ...identity };
    const capturedInput = input();
    const snapshot = new ReviewSnapshot(capturedIdentity, [capturedInput]);
    capturedIdentity.planId = "mutated";
    capturedInput.content = "changed";
    const manifest = snapshot.manifest;
    expect(manifest.sources[0].lines).toBe(3);
    expect(snapshot.coverage().returnedLines).toBe(0);
    const first = snapshot.read("plan", 1, 3, 7);
    expect(first.text).toBe("one\ntwo");
    expect(first.evidence.endLine).toBe(2);
    expect(first.truncated).toBe(true);
    snapshot.read("plan", 2, 3);
    expect(snapshot.coverage().returnedLines).toBe(3);
    const verified = snapshot.verify(first.evidence, manifest.revision);
    expect(verified).toEqual({
      anchorValid: true,
      sourceVerified: true,
      provenance: "recorded",
    });
    manifest.sources[0].path = "mutated";
    expect(snapshot.manifest.sources[0].path).toBe("plan/p");
  });

  it("rejects forged, stale, duplicate, and invalid evidence", () => {
    const snapshot = new ReviewSnapshot(identity, [input()]);
    const evidence = snapshot.read("plan", 1, 1).evidence;
    expectCode(
      () =>
        snapshot.verify(
          { ...evidence, endLine: 2 },
          snapshot.manifest.revision,
        ),
      "invalid",
    );
    expectCode(
      () =>
        snapshot.verify(
          { ...evidence, sourceHash: "bad" },
          snapshot.manifest.revision,
        ),
      "invalid",
    );
    expectCode(() => snapshot.verify(evidence, "changed"), "stale");
    expect(
      () => new ReviewSnapshot(identity, [input(), input({ key: "plan" })]),
    ).toThrow();
    expectCode(() => snapshot.read("plan", 0, 1), "invalid");
    expectCode(() => snapshot.read("plan", 1, 4), "invalid");
    expectCode(() => snapshot.read("plan", 1, 1, 256 * 1024 + 1), "invalid");
  });

  it("keeps old and new sources distinct and records unavailable provenance", () => {
    const snapshot = new ReviewSnapshot(identity, [
      input({ key: "old", side: "old", revision: "a", content: "old" }),
      input({ key: "new", side: "new", revision: "b", content: "new" }),
      input({
        key: "binary",
        content: null,
        complete: false,
        omission: "binary",
        provenance: "recorded",
      }),
      input({ key: "draft", content: "draft", provenance: "draft" }),
      input({
        key: "unknown",
        content: "historical unknown",
        complete: true,
        provenance: "unknown",
      }),
      input({
        key: "reconstructed",
        content: "historical reconstructed",
        complete: true,
        provenance: "reconstructed",
      }),
    ]);
    expect(
      snapshot.manifest.sources.find((source) => source.key === "old")?.hash,
    ).not.toBe(
      snapshot.manifest.sources.find((source) => source.key === "new")?.hash,
    );
    expect(snapshot.manifest.sources.map((source) => source.key)).toEqual([
      "old",
      "new",
      "binary",
      "draft",
      "unknown",
      "reconstructed",
    ]);
    expect(snapshot.coverage().omittedSourceCount).toBe(1);
    expectCode(() => snapshot.read("binary", 1, 1), "missing");
    expect(snapshot.read("draft", 1, 1).provenance).toBe("draft");
    expect(snapshot.read("draft", 1, 1).evidence.sourceHash).toBe(
      sourceHash("draft"),
    );
    expect(
      snapshot.verify(
        snapshot.read("draft", 1, 1).evidence,
        snapshot.manifest.revision,
      ).sourceVerified,
    ).toBe(false);
    expect(
      snapshot.verify(
        snapshot.read("unknown", 1, 1).evidence,
        snapshot.manifest.revision,
      ).sourceVerified,
    ).toBe(false);
    expect(
      snapshot.verify(
        snapshot.read("reconstructed", 1, 1).evidence,
        snapshot.manifest.revision,
      ).sourceVerified,
    ).toBe(false);
  });

  it("rejects evidence issued by a foreign snapshot", () => {
    const first = new ReviewSnapshot(identity, [input()]);
    const second = new ReviewSnapshot(identity, [input()]);
    const evidence = second.read("plan", 1, 1).evidence;
    expectCode(
      () => first.verify(evidence, first.manifest.revision),
      "invalid",
    );
  });

  it("bounds row allocation and each returned page", () => {
    expectCode(
      () =>
        new ReviewSnapshot(identity, [
          input({ content: "\n".repeat(100_001) }),
        ]),
      "limit",
    );
    const snapshot = new ReviewSnapshot(identity, [
      input({ content: "line\n".repeat(202) }),
    ]);
    const page = snapshot.read("plan", 1, 202);
    expect(page.evidence.endLine).toBe(200);
    expect(page.truncated).toBe(true);
    expect(snapshot.coverage().returnedLines).toBe(200);
  });

  it("enforces source, aggregate snapshot, range, and issued-reference limits", () => {
    expect(
      () =>
        new ReviewSnapshot(identity, [
          input({ content: "x".repeat(4 * 1024 * 1024 + 1) }),
        ]),
    ).toThrow();
    expect(
      () =>
        new ReviewSnapshot(identity, [
          input({ key: "one", content: "x".repeat(3 * 1024 * 1024) }),
          input({ key: "two", content: "x".repeat(3 * 1024 * 1024) }),
          input({ key: "three", content: "x".repeat(3 * 1024 * 1024) }),
        ]),
    ).toThrow();
    const snapshot = new ReviewSnapshot(identity, [input({ content: "x" })]);
    for (let index = 0; index < 2048; index++) snapshot.read("plan", 1, 1);
    expectCode(() => snapshot.read("plan", 1, 1), "limit");
  });
});

describe("capturePrReview", () => {
  function session(overrides: Partial<PrSession> = {}): PrSession {
    return {
      ref: "#1",
      owner: "o",
      repo: "r",
      pullNumber: 1,
      headSha: "head",
      baseSha: "base",
      title: "T",
      url: "u",
      author: null,
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      diff: "diff",
      comments: [],
      existingComments: [],
      ...overrides,
    };
  }
  it("pins identity and cache keys and detects session mutation", () => {
    const source = session();
    const captured = capturePrReview(source);
    const key = captured.cacheKey("a.ts");
    source.headSha = "new-head";
    expect(captured.cacheKey("a.ts")).toBe(key);
    expect(() => captured.assertFresh(source)).toThrow();
    expect(() => captured.assertFresh(session({ owner: "x" }))).toThrow();
    expect(() => captured.assertFresh(session({ repo: "x" }))).toThrow();
    expect(() =>
      captured.assertFresh(session({ host: "git.example" })),
    ).toThrow();
  });
  it("reports merge-base and omitted patch omissions without fetching", () => {
    const captured = capturePrReview(
      session({ diffCompleteness: { listedFiles: 1, omittedPatches: 2 } }),
    );
    expect(captured.omissions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("merge-base"),
        expect.stringContaining("omits 2"),
      ]),
    );
  });
});
