// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AiSnapshotError,
  ReviewSnapshot,
  sourceHash,
  type SnapshotIdentity,
} from "../snapshots.js";
import { sourceRead } from "../tools.js";
import { AiStorage } from "../storage.js";
import { NotebookStore } from "../notebook-store.js";
import type { NotebookEntryInput } from "../notebook.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "diffing-notebook-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function snapshotOf(planId = "p"): ReviewSnapshot {
  const identity: SnapshotIdentity = {
    kind: "plan",
    planId,
    version: 1,
    bodyHash: sourceHash(planId),
    titleHash: sourceHash("P"),
  };
  return new ReviewSnapshot(identity, [
    {
      key: "a.ts",
      path: "src/a.ts",
      side: "new",
      revision: "v1",
      content: "alpha\nbravo\n",
      complete: true,
      provenance: "recorded",
      representation: "original",
    },
  ]);
}

function entryFor(
  snapshot: ReviewSnapshot,
  overrides: Partial<NotebookEntryInput> = {},
): NotebookEntryInput {
  const batch = sourceRead(snapshot, [
    { key: "a.ts", startLine: 1, endLine: 1 },
  ]);
  const item = batch.items[0];
  if (!item.ok) throw new Error("expected a successful read");
  return {
    id: "e1",
    kind: "finding",
    title: "Something worth noting",
    body: "Details.",
    uncertainty: "low",
    citations: [
      {
        key: "a.ts",
        startLine: 1,
        endLine: 1,
        quote: item.value.text,
        evidenceId: item.value.evidence.id,
      },
    ],
    ...overrides,
  };
}

const storeFor = () => new NotebookStore(new AiStorage(dir));

describe("authoring", () => {
  it("stores a validated entry and reads it back", async () => {
    const snapshot = snapshotOf();
    const store = storeFor();
    await store.author(snapshot, entryFor(snapshot));
    const read = store.read(snapshot.manifest.id);
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]).toMatchObject({ id: "e1", decision: null });
  });

  it("never stores an entry that cannot cite the capture", async () => {
    const snapshot = snapshotOf();
    const store = storeFor();
    const forged = entryFor(snapshot);
    forged.citations[0].quote = "never said this";
    await expect(store.author(snapshot, forged)).rejects.toBeInstanceOf(
      AiSnapshotError,
    );
    // Validation runs before the write, so nothing was journaled.
    expect(store.read(snapshot.manifest.id).entries).toEqual([]);
  });

  it("survives a restart", async () => {
    const snapshot = snapshotOf();
    await storeFor().author(snapshot, entryFor(snapshot));
    expect(storeFor().read(snapshot.manifest.id).entries).toHaveLength(1);
  });

  it("keeps notebooks for different captures apart", async () => {
    const mine = snapshotOf("mine");
    const theirs = snapshotOf("theirs");
    const store = storeFor();
    await store.author(mine, entryFor(mine));
    expect(store.read(mine.manifest.id).entries).toHaveLength(1);
    expect(store.read(theirs.manifest.id).entries).toEqual([]);
  });

  it("is idempotent for the same entry id", async () => {
    const snapshot = snapshotOf();
    const store = storeFor();
    await store.author(snapshot, entryFor(snapshot));
    await store.author(snapshot, entryFor(snapshot, { title: "Changed" }));
    const entries = store.read(snapshot.manifest.id).entries;
    expect(entries).toHaveLength(1);
    // The first write wins; a repeat does not silently replace it.
    expect(entries[0].title).toBe("Something worth noting");
  });
});

describe("deciding", () => {
  it("records a decision separately from the entry", async () => {
    const snapshot = snapshotOf();
    const store = storeFor();
    await store.author(snapshot, entryFor(snapshot));
    // The authored entry carries no outcome of its own.
    expect(store.read(snapshot.manifest.id).entries[0].decision).toBeNull();
    await store.decide(
      snapshot.manifest.id,
      "e1",
      "accepted",
      "reviewer",
      () => 500,
    );
    expect(store.read(snapshot.manifest.id).entries[0]).toMatchObject({
      decision: "accepted",
      decidedBy: "reviewer",
      decidedAt: 500,
    });
  });

  it("applies the latest decision and keeps the earlier one journaled", async () => {
    const snapshot = snapshotOf();
    const storage = new AiStorage(dir);
    const store = new NotebookStore(storage);
    await store.author(snapshot, entryFor(snapshot));
    await store.decide(snapshot.manifest.id, "e1", "accepted", "a", () => 100);
    await store.decide(snapshot.manifest.id, "e1", "rejected", "b", () => 200);
    expect(store.read(snapshot.manifest.id).entries[0]).toMatchObject({
      decision: "rejected",
      decidedBy: "b",
    });
    // Changing your mind is a new record, never an erasure.
    const decisions = storage
      .list(snapshot.manifest.id)
      .filter(
        (record) =>
          (record.payload as { kind?: string }).kind === "notebook-decision",
      );
    expect(decisions).toHaveLength(2);
  });

  it("refuses a decision on an entry that does not exist", async () => {
    const snapshot = snapshotOf();
    const store = storeFor();
    await expect(
      store.decide(snapshot.manifest.id, "ghost", "accepted", "reviewer"),
    ).rejects.toMatchObject({ code: "missing" });
  });

  it.each([
    ["an unknown decision", "maybe", "reviewer"],
    ["a blank decider", "accepted", ""],
  ])("refuses %s", async (_label, decision, decidedBy) => {
    const snapshot = snapshotOf();
    const store = storeFor();
    await store.author(snapshot, entryFor(snapshot));
    await expect(
      store.decide(
        snapshot.manifest.id,
        "e1",
        decision as "accepted",
        decidedBy,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("survives a restart with its decision applied", async () => {
    const snapshot = snapshotOf();
    const store = storeFor();
    await store.author(snapshot, entryFor(snapshot));
    await store.decide(snapshot.manifest.id, "e1", "deferred", "reviewer");
    expect(storeFor().read(snapshot.manifest.id).entries[0].decision).toBe(
      "deferred",
    );
  });
});
