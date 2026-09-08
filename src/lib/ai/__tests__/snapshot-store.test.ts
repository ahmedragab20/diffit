import { describe, expect, it } from "vitest";
import {
  AiSnapshotError,
  ReviewSnapshot,
  sourceHash,
  type SnapshotIdentity,
} from "../snapshots.js";
import { SnapshotStore } from "../snapshot-store.js";

function snapshot(planId = "p"): ReviewSnapshot {
  const identity: SnapshotIdentity = {
    kind: "plan",
    planId,
    version: 1,
    bodyHash: sourceHash(planId),
    titleHash: sourceHash("P"),
  };
  return new ReviewSnapshot(identity, [
    {
      key: "plan",
      path: `plan/${planId}`,
      side: "document",
      revision: "v1",
      content: "one\ntwo\n",
      complete: true,
      provenance: "recorded",
    },
  ]);
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

describe("SnapshotStore", () => {
  it("retains a capture and resolves it by id", () => {
    const store = new SnapshotStore();
    const captured = snapshot();
    const { id, revision } = store.put(captured);
    expect(store.get(id)).toBe(captured);
    expect(store.get(id, revision)).toBe(captured);
  });

  it("reports an unknown id as missing", () =>
    expectCode(() => new SnapshotStore().get("nope"), "missing"));

  it("reports a pinned revision mismatch as stale, never a substitution", () => {
    const store = new SnapshotStore();
    const { id } = store.put(snapshot());
    expectCode(() => store.get(id, "some-other-revision"), "stale");
  });

  it("evicts the least recently used capture past its bound", () => {
    const store = new SnapshotStore(2);
    const first = store.put(snapshot("a"));
    const second = store.put(snapshot("b"));
    // Touching the first makes the second the eviction candidate.
    store.get(first.id);
    const third = store.put(snapshot("c"));
    expect(store.size).toBe(2);
    expect(store.get(first.id)).toBeDefined();
    expect(store.get(third.id)).toBeDefined();
    expectCode(() => store.get(second.id), "missing");
  });

  it("expires a capture once its retention window passes", () => {
    let clock = 1_000;
    const store = new SnapshotStore(8, 500, () => clock);
    const { id } = store.put(snapshot());
    clock += 499;
    expect(store.get(id)).toBeDefined();
    clock += 501;
    expectCode(() => store.get(id), "missing");
    expect(store.size).toBe(0);
  });

  it("refreshes retention when the same snapshot is re-put", () => {
    let clock = 1_000;
    const store = new SnapshotStore(8, 500, () => clock);
    const captured = snapshot();
    store.put(captured);
    clock += 400;
    const { id } = store.put(captured);
    clock += 400;
    expect(store.get(id)).toBe(captured);
  });

  it("lists retained captures without exposing their content", () => {
    const store = new SnapshotStore();
    store.put(snapshot("a"));
    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ identityKind: "plan", sourceCount: 1 });
    expect(JSON.stringify(listed)).not.toContain("one\ntwo");
  });

  it("deletes and clears", () => {
    const store = new SnapshotStore();
    const { id } = store.put(snapshot());
    expect(store.delete(id)).toBe(true);
    expect(store.delete(id)).toBe(false);
    store.put(snapshot("b"));
    store.clear();
    expect(store.size).toBe(0);
  });

  it.each([
    [0, 1000],
    [1, 0],
    [1.5, 1000],
  ])("rejects invalid bounds (%j, %j)", (maxEntries, ttlMs) =>
    expectCode(() => new SnapshotStore(maxEntries, ttlMs), "invalid"),
  );
});
