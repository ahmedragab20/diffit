import { describe, expect, it } from "vitest";
import {
  AiSnapshotError,
  ReviewSnapshot,
  sourceHash,
  type SnapshotIdentity,
  type SnapshotSourceInput,
} from "../snapshots.js";
import { sourceRead } from "../tools.js";
import {
  NOTEBOOK_LIMITS,
  authorEntry,
  buildNotebook,
  decide,
  reviewStaleness,
  type NotebookEntryInput,
} from "../notebook.js";

const identity = (planId = "p"): SnapshotIdentity => ({
  kind: "plan",
  planId,
  version: 1,
  bodyHash: sourceHash(planId),
  titleHash: sourceHash("P"),
});

function source(
  overrides: Partial<SnapshotSourceInput> = {},
): SnapshotSourceInput {
  return {
    key: "a.ts",
    path: "src/a.ts",
    side: "new",
    revision: "v1",
    content: "alpha\nbravo\ncharlie\n",
    complete: true,
    provenance: "recorded",
    representation: "original",
    ...overrides,
  };
}

const snapshotOf = (planId = "p", ...inputs: SnapshotSourceInput[]) =>
  new ReviewSnapshot(identity(planId), inputs.length ? inputs : [source()]);

/** Produces a citation by actually reading, as a run would. */
function cite(
  snapshot: ReviewSnapshot,
  key = "a.ts",
  startLine = 1,
  endLine = 1,
) {
  const batch = sourceRead(snapshot, [{ key, startLine, endLine }]);
  const item = batch.items[0];
  if (!item.ok) throw new Error("expected a successful read");
  return {
    key,
    startLine,
    endLine,
    quote: item.value.text,
    evidenceId: item.value.evidence.id,
  };
}

function entry(
  snapshot: ReviewSnapshot,
  overrides: Partial<NotebookEntryInput> = {},
): NotebookEntryInput {
  return {
    id: "e1",
    kind: "finding",
    title: "Cents conversion is inverted",
    body: "The call site divides where it should multiply.",
    uncertainty: "medium",
    citations: [cite(snapshot)],
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: AiSnapshotError["code"]): void {
  try {
    fn();
    throw new Error("expected a snapshot error");
  } catch (error) {
    expect(error).toBeInstanceOf(AiSnapshotError);
    expect((error as AiSnapshotError).code).toBe(code);
  }
}

describe("cited artifacts", () => {
  it("accepts an entry whose quote matches the capture", () => {
    const snapshot = snapshotOf();
    const authored = authorEntry(snapshot, entry(snapshot));
    expect(authored.citations[0].quote).toBe("alpha");
    expect(authored.snapshotRevision).toBe(snapshot.manifest.revision);
    expect(authored.decision).toBeNull();
  });

  it("rejects an entry with no citation at all", () => {
    const snapshot = snapshotOf();
    expectCode(
      () => authorEntry(snapshot, entry(snapshot, { citations: [] })),
      "invalid",
    );
  });

  it("rejects a fabricated quote", () => {
    const snapshot = snapshotOf();
    const forged = entry(snapshot);
    forged.citations[0].quote = "something the file never said";
    expectCode(() => authorEntry(snapshot, forged), "invalid");
  });

  it("rejects a citation to a source the capture does not hold", () => {
    const snapshot = snapshotOf();
    const wrong = entry(snapshot);
    wrong.citations[0].key = "not-a-source";
    expectCode(() => authorEntry(snapshot, wrong), "missing");
  });

  it("rejects a citation reaching past the captured lines", () => {
    const snapshot = snapshotOf();
    const past = entry(snapshot);
    past.citations[0].endLine = 999;
    expectCode(() => authorEntry(snapshot, past), "missing");
  });

  it("rejects a citation minted against another capture", () => {
    const mine = snapshotOf("mine");
    const theirs = snapshotOf("theirs");
    const foreign = entry(mine, { citations: [cite(theirs)] });
    expectCode(() => authorEntry(mine, foreign), "invalid");
  });

  it.each([
    ["a blank title", { title: "" }],
    ["an oversized body", { body: "x".repeat(NOTEBOOK_LIMITS.maxBodyBytes + 1) }],
    ["an unknown kind", { kind: "rumour" as NotebookEntryInput["kind"] }],
    ["a missing uncertainty", { uncertainty: "none" as never }],
  ])("rejects %s", (_label, overrides) => {
    const snapshot = snapshotOf();
    expectCode(
      () => authorEntry(snapshot, entry(snapshot, overrides)),
      "invalid",
    );
  });
});

describe("uncertainty and coverage", () => {
  it("requires an explicit uncertainty on every entry", () => {
    const snapshot = snapshotOf();
    const notebook = buildNotebook(snapshot, [
      entry(snapshot, { id: "e1", uncertainty: "high" }),
    ]);
    expect(notebook.entries[0].uncertainty).toBe("high");
  });

  it("reports coverage as returned lines, never as quality", () => {
    const snapshot = snapshotOf();
    const notebook = buildNotebook(snapshot, [entry(snapshot)]);
    expect(notebook.coverage.basis).toBe("returned-source-lines");
    expect(notebook.coverage.returnedLines).toBeGreaterThan(0);
    expect(notebook.coverage.citedSources).toBe(1);
    expect(notebook.coverage.returnedLines).toBeLessThanOrEqual(
      notebook.coverage.availableLines,
    );
  });

  it("does not inflate coverage by verifying a quote", () => {
    const snapshot = snapshotOf();
    const input = entry(snapshot);
    const before = snapshot.coverage().returnedLines;
    buildNotebook(snapshot, [input]);
    // Verification re-reads lines already returned, so the union is unchanged.
    expect(snapshot.coverage().returnedLines).toBe(before);
  });
});

describe("provenance and links", () => {
  it("records the capture an entry was written against", () => {
    const snapshot = snapshotOf();
    const notebook = buildNotebook(snapshot, [entry(snapshot)]);
    expect(notebook.snapshotId).toBe(snapshot.manifest.id);
    expect(notebook.entries[0].snapshotRevision).toBe(
      snapshot.manifest.revision,
    );
  });

  it("resolves an explicit link between entries", () => {
    const snapshot = snapshotOf();
    const notebook = buildNotebook(snapshot, [
      entry(snapshot, { id: "e1" }),
      entry(snapshot, { id: "e2", links: ["e1"] }),
    ]);
    expect(notebook.entries[1].links).toEqual(["e1"]);
  });

  it("rejects a link to an entry that is not there", () => {
    const snapshot = snapshotOf();
    expectCode(
      () =>
        buildNotebook(snapshot, [entry(snapshot, { id: "e1", links: ["ghost"] })]),
      "invalid",
    );
  });

  it("rejects an entry linking to itself", () => {
    const snapshot = snapshotOf();
    expectCode(
      () => buildNotebook(snapshot, [entry(snapshot, { id: "e1", links: ["e1"] })]),
      "invalid",
    );
  });

  it("rejects duplicate entry ids", () => {
    const snapshot = snapshotOf();
    expectCode(
      () =>
        buildNotebook(snapshot, [
          entry(snapshot, { id: "same" }),
          entry(snapshot, { id: "same" }),
        ]),
      "invalid",
    );
  });
});

describe("user decisions", () => {
  it("records who decided and when, separately from authoring", () => {
    const snapshot = snapshotOf();
    const notebook = buildNotebook(snapshot, [entry(snapshot)]);
    // Authoring never sets an outcome.
    expect(notebook.entries[0].decision).toBeNull();
    const decided = decide(notebook, "e1", "accepted", "reviewer", () => 42);
    expect(decided.entries[0]).toMatchObject({
      decision: "accepted",
      decidedBy: "reviewer",
      decidedAt: 42,
    });
    // The original notebook is not mutated.
    expect(notebook.entries[0].decision).toBeNull();
  });

  it("rejects an unknown entry and an unknown decision", () => {
    const snapshot = snapshotOf();
    const notebook = buildNotebook(snapshot, [entry(snapshot)]);
    expectCode(() => decide(notebook, "ghost", "accepted", "reviewer"), "missing");
    expectCode(
      () => decide(notebook, "e1", "maybe" as never, "reviewer"),
      "invalid",
    );
    expectCode(() => decide(notebook, "e1", "accepted", ""), "invalid");
  });
});

describe("stale-evidence re-review", () => {
  it("reports a notebook built on another capture as stale", () => {
    const original = snapshotOf("one");
    const notebook = buildNotebook(original, [entry(original)]);
    const replaced = snapshotOf("two");
    const review = reviewStaleness(notebook, replaced);
    expect(review.stale).toBe(true);
    expect(review.entryIds).toEqual(["e1"]);
    expect(review.reason).toContain("replaced");
  });

  it("reports drifted source text as stale for that entry only", () => {
    const snapshot = snapshotOf();
    const notebook = buildNotebook(snapshot, [
      entry(snapshot, { id: "e1", citations: [cite(snapshot, "a.ts", 1, 1)] }),
      entry(snapshot, { id: "e2", citations: [cite(snapshot, "a.ts", 2, 2)] }),
    ]);
    // Tamper with one stored quote to stand for source drift.
    notebook.entries[0].citations[0].quote = "moved";
    const review = reviewStaleness(notebook, snapshot);
    expect(review.stale).toBe(true);
    expect(review.entryIds).toEqual(["e1"]);
    expect(review.reason).toContain("no longer matches");
  });

  it("reports a notebook still anchored to its capture as fresh", () => {
    const snapshot = snapshotOf();
    const notebook = buildNotebook(snapshot, [entry(snapshot)]);
    expect(reviewStaleness(notebook, snapshot)).toEqual({
      stale: false,
      entryIds: [],
      reason: null,
    });
  });
});
