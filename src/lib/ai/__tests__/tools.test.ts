import { describe, expect, it } from "vitest";
import {
  AiSnapshotError,
  ReviewSnapshot,
  sourceHash,
  type SnapshotIdentity,
  type SnapshotSourceInput,
} from "../snapshots.js";
import {
  TOOL_LIMITS,
  diffRead,
  locateInSnapshot,
  reviewMap,
  sourceRead,
  sourceSearch,
} from "../tools.js";

const identity: SnapshotIdentity = {
  kind: "plan",
  planId: "p",
  version: 1,
  bodyHash: sourceHash("body"),
  titleHash: sourceHash("P"),
};

function source(
  overrides: Partial<SnapshotSourceInput> = {},
): SnapshotSourceInput {
  return {
    key: "a.ts",
    path: "src/a.ts",
    side: "new",
    revision: "v1",
    content: "alpha\nbravo\ncharlie\ndelta\n",
    complete: true,
    provenance: "recorded",
    representation: "original",
    ...overrides,
  };
}

function snapshotOf(...inputs: SnapshotSourceInput[]): ReviewSnapshot {
  return new ReviewSnapshot(identity, inputs.length ? inputs : [source()]);
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

describe("review.map", () => {
  it("lists sources and omissions without counting as a read", () => {
    const snapshot = snapshotOf(
      source(),
      source({
        key: "b.ts",
        path: "src/b.ts",
        content: null,
        complete: false,
        provenance: "unknown",
        omission: "binary file",
      }),
    );
    const map = reviewMap(snapshot);
    expect(map.sources.map((entry) => entry.key)).toEqual(["a.ts", "b.ts"]);
    expect(map.sources[1]).toMatchObject({
      complete: false,
      provenance: "unknown",
      omission: "binary file",
    });
    // Listing must never inflate returned-line coverage.
    expect(map.coverage.returnedLines).toBe(0);
    expect(map.coverage.readSourceCount).toBe(0);
    expect(map.nextCursor).toBeNull();
  });

  it("pages with a cursor and stops at the end", () => {
    const snapshot = snapshotOf(
      source({ key: "a.ts" }),
      source({ key: "b.ts" }),
      source({ key: "c.ts" }),
    );
    const first = reviewMap(snapshot, { limit: 2 });
    expect(first.sources.map((entry) => entry.key)).toEqual(["a.ts", "b.ts"]);
    expect(first.nextCursor).toBe("o:2");
    const second = reviewMap(snapshot, { limit: 2, cursor: first.nextCursor! });
    expect(second.sources.map((entry) => entry.key)).toEqual(["c.ts"]);
    expect(second.nextCursor).toBeNull();
  });

  it.each(["", "o:", "nope", "o:-1", "o:99"])(
    "rejects malformed cursor %j",
    (cursor) => expectCode(() => reviewMap(snapshotOf(), { cursor }), "invalid"),
  );

  it.each([0, -1, TOOL_LIMITS.mapPageSize + 1, 1.5])(
    "rejects out-of-range limit %j",
    (limit) => expectCode(() => reviewMap(snapshotOf(), { limit }), "invalid"),
  );
});

describe("source.read", () => {
  it("returns cited text and records coverage", () => {
    const snapshot = snapshotOf();
    const batch = sourceRead(snapshot, [
      { key: "a.ts", startLine: 1, endLine: 2 },
    ]);
    expect(batch.items).toHaveLength(1);
    const [item] = batch.items;
    if (!item.ok) throw new Error("expected a successful read");
    expect(item.value.text).toBe("alpha\nbravo");
    expect(item.value.evidence.startLine).toBe(1);
    expect(item.value.evidence.endLine).toBe(2);
    expect(snapshot.coverage().returnedLines).toBe(2);
  });

  it("reports per-item failures without discarding the batch", () => {
    const batch = sourceRead(snapshotOf(), [
      { key: "a.ts", startLine: 1, endLine: 1 },
      { key: "missing.ts", startLine: 1, endLine: 1 },
      { key: "a.ts", startLine: 9, endLine: 9 },
    ]);
    expect(batch.items[0].ok).toBe(true);
    expect(batch.items[1]).toMatchObject({ ok: false, error: { code: "missing" } });
    expect(batch.items[2]).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("reads a repeated range once and shares the result", () => {
    const snapshot = snapshotOf();
    const batch = sourceRead(snapshot, [
      { key: "a.ts", startLine: 1, endLine: 2 },
      { key: "a.ts", startLine: 1, endLine: 2 },
      { key: "a.ts", startLine: 1, endLine: 2 },
    ]);
    expect(batch.deduplicated).toBe(2);
    expect(batch.items[0]).toBe(batch.items[2]);
    // One read was billed, so the shared bytes are counted once.
    const [item] = batch.items;
    if (!item.ok) throw new Error("expected a successful read");
    expect(batch.budget.usedBytes).toBe(
      Buffer.byteLength(item.value.text, "utf8"),
    );
  });

  it("reports an exhausted budget instead of truncating silently", () => {
    const batch = sourceRead(
      snapshotOf(source({ key: "a.ts" }), source({ key: "b.ts" })),
      [
        { key: "a.ts", startLine: 1, endLine: 4 },
        { key: "b.ts", startLine: 1, endLine: 4 },
      ],
      12,
    );
    expect(batch.budget.exhausted).toBe(true);
    expect(batch.budget.usedBytes).toBeLessThanOrEqual(12);
    expect(batch.items.some((item) => !item.ok)).toBe(true);
  });

  it("refuses to read a patch source as original file lines", () => {
    const snapshot = snapshotOf(
      source({ key: "patch", representation: "unified-patch" }),
    );
    expect(sourceRead(snapshot, [{ key: "patch", startLine: 1, endLine: 1 }]).items[0])
      .toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(diffRead(snapshot, [{ key: "patch", startLine: 1, endLine: 1 }]).items[0])
      .toMatchObject({ ok: true });
  });

  it("refuses to read an original source as a patch", () => {
    expect(diffRead(snapshotOf(), [{ key: "a.ts", startLine: 1, endLine: 1 }]).items[0])
      .toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it.each([
    [[], "empty batch"],
    [Array.from({ length: TOOL_LIMITS.batchItems + 1 }, () => ({
      key: "a.ts",
      startLine: 1,
      endLine: 1,
    })), "oversized batch"],
  ])("rejects an %s", (requests) =>
    expectCode(() => sourceRead(snapshotOf(), requests), "invalid"),
  );

  it.each([0, TOOL_LIMITS.batchBytes + 1])(
    "rejects out-of-range budget %j",
    (maxBytes) =>
      expectCode(
        () =>
          sourceRead(
            snapshotOf(),
            [{ key: "a.ts", startLine: 1, endLine: 1 }],
            maxBytes,
          ),
        "invalid",
      ),
  );
});

describe("source.search", () => {
  it("returns positions only and does not count as a read", () => {
    const snapshot = snapshotOf();
    const found = sourceSearch(snapshot, "bravo");
    expect(found.matches).toEqual([{ key: "a.ts", line: 2 }]);
    expect(snapshot.coverage().returnedLines).toBe(0);
  });

  it("matches case-insensitively only when asked", () => {
    const snapshot = snapshotOf();
    expect(sourceSearch(snapshot, "BRAVO").matches).toEqual([]);
    expect(sourceSearch(snapshot, "BRAVO", { ignoreCase: true }).matches).toEqual(
      [{ key: "a.ts", line: 2 }],
    );
  });

  it("scopes to a single source and rejects an unknown key", () => {
    const snapshot = snapshotOf(
      source({ key: "a.ts" }),
      source({ key: "b.ts" }),
    );
    expect(sourceSearch(snapshot, "alpha", { key: "b.ts" }).matches).toEqual([
      { key: "b.ts", line: 1 },
    ]);
    expectCode(() => sourceSearch(snapshot, "alpha", { key: "nope" }), "missing");
  });

  it("pages matches with a cursor", () => {
    const snapshot = snapshotOf(
      source({ key: "a.ts", content: "hit\nhit\nhit\n" }),
    );
    const first = sourceSearch(snapshot, "hit", { limit: 2 });
    expect(first.matches).toHaveLength(2);
    expect(first.nextCursor).toBe("o:2");
    const second = sourceSearch(snapshot, "hit", {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.matches).toEqual([{ key: "a.ts", line: 3 }]);
    expect(second.nextCursor).toBeNull();
  });

  it.each(["", "x".repeat(513)])("rejects malformed query %j", (query) =>
    expectCode(() => sourceSearch(snapshotOf(), query), "invalid"),
  );
});

describe("locateInSnapshot", () => {
  const root = "/repo";
  const located = (uri: string) =>
    locateInSnapshot(
      snapshotOf(source({ key: "a.ts", path: "src/a.ts" })),
      [{ uri, startLine: 3, endLine: 3 }],
      root,
    )[0];

  it("resolves a location that falls inside the capture", () => {
    expect(located("file:///repo/src/a.ts")).toEqual({
      key: "a.ts",
      path: "src/a.ts",
      startLine: 3,
      endLine: 3,
      inScope: true,
    });
  });

  it("names a location outside the capture without making it readable", () => {
    const outside = located("file:///repo/src/elsewhere.ts");
    expect(outside).toMatchObject({ key: null, inScope: false });
    expect(outside.path).toBe("src/elsewhere.ts");
  });

  it.each([
    ["outside the repository root", "file:///etc/passwd"],
    ["a traversal segment", "file:///repo/../etc/passwd"],
    ["a non-file scheme", "https://example.com/a.ts"],
    ["an untitled buffer", "untitled:Untitled-1"],
  ])("refuses %s", (_label, uri) => {
    expect(located(uri)).toMatchObject({ key: null, inScope: false });
  });

  it("decodes a percent-encoded path", () => {
    expect(located("file:///repo/src/a%2Ets")).toMatchObject({
      key: "a.ts",
      inScope: true,
    });
  });

  it("never resolves a patch source, whose lines are not file lines", () => {
    const found = locateInSnapshot(
      snapshotOf(
        source({ key: "patch", path: "src/a.ts", representation: "unified-patch" }),
      ),
      [{ uri: "file:///repo/src/a.ts", startLine: 1, endLine: 1 }],
      root,
    );
    expect(found[0]).toMatchObject({ key: null, inScope: false });
  });
});
