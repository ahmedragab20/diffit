import { describe, expect, it } from "vitest";
import { renderSnapshotEvidence } from "../snapshot-prompt.js";
import { ReviewSnapshot, sourceHash, type SnapshotIdentity, type SnapshotSourceInput } from "../snapshots.js";

const identity: SnapshotIdentity = { kind: "plan", planId: "p", version: 1, bodyHash: sourceHash("body"), titleHash: sourceHash("title") };
const source = (key: string, content: string | null, extra: Partial<SnapshotSourceInput> = {}): SnapshotSourceInput => ({ key, path: key, side: "document", revision: "v1", content, complete: true, provenance: "recorded", ...extra });

describe("renderSnapshotEvidence", () => {
  it("renders 450 source lines within 64KiB with verified exact references", () => {
    const content = Array.from({ length: 450 }, (_, i) => `line-${i + 1}`).join("\n");
    const snapshot = new ReviewSnapshot(identity, [source("body", content, { representation: "unified-patch" })]);
    const result = renderSnapshotEvidence(snapshot, 64 * 1024);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(64 * 1024); expect(result.coverage.availableLines).toBe(450); expect(result.coverage.returnedLines).toBe(450); expect(result.truncated).toBe(false); expect(result.text).toContain('"representation":"unified-patch"');
    const lines = content.split("\n");
    for (const ref of result.references) { const slice = lines.slice(ref.startLine - 1, ref.endLine).join("\n"); expect(result.text).toContain(slice); expect(ref.excerptHash).toBe(sourceHash(slice)); expect(snapshot.verify(ref, snapshot.manifest.revision).anchorValid).toBe(true); }
  });
  it("returns some but not all long lines under a bounded exact byte budget", () => {
    const content = Array.from({ length: 200 }, (_, i) => `${String(i + 1).padStart(3, "0")}-${"x".repeat(20)}`).join("\n");
    const snapshot = new ReviewSnapshot(identity, [source("body", content)]);
    const result = renderSnapshotEvidence(snapshot, 2500);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(2500); expect(result.coverage.returnedLines).toBeGreaterThan(0); expect(result.coverage.returnedLines).toBeLessThan(200); expect(result.coverage.returnedLines).toBe(result.references.reduce((n, r) => n + r.endLine - r.startLine + 1, 0)); expect(result.truncated).toBe(true);
    const lines = content.split("\n"); for (const ref of result.references) { const slice = lines.slice(ref.startLine - 1, ref.endLine).join("\n"); expect(result.text).toContain(slice); expect(ref.excerptHash).toBe(sourceHash(slice)); expect(snapshot.verify(ref, snapshot.manifest.revision).anchorValid).toBe(true); }
  });
  it("does zero reads at zero budget, including for a nonempty source, and long lines create no phantom reads", () => {
    const nonempty = new ReviewSnapshot(identity, [source("body", "one\ntwo")]); const zero = renderSnapshotEvidence(nonempty, 0); expect(zero.references).toHaveLength(0); expect(zero.coverage.returnedLines).toBe(0); expect(nonempty.coverage().returnedLines).toBe(0);
    const long = new ReviewSnapshot(identity, [source("long", "x".repeat(100_000))]); const result = renderSnapshotEvidence(long, 1200); expect(result.coverage.returnedLines).toBe(0); expect(result.references).toHaveLength(0); expect(long.coverage().returnedLines).toBe(0);
  });
  it("labels omitted and draft sources honestly and represents empty sources", () => {
    const snapshot = new ReviewSnapshot(identity, [source("missing", null, { complete: false, omission: "not captured" }), source("body-draft", "draft text", { provenance: "draft" }), source("empty", "")], ["omitted source"]);
    const result = renderSnapshotEvidence(snapshot, 20_000);
    expect(result.text).toContain("Source omitted: original unavailable"); expect(result.text).toContain("Unsubmitted plan text (draft, not stored evidence)"); expect(result.text).toContain("[Empty captured source]"); expect(result.coverage.omittedSourceCount).toBe(1); expect(result.coverage.returnedLines).toBe(1); expect(result.truncated).toBe(true); expect(result.references.every(ref => snapshot.verify(ref, snapshot.manifest.revision).anchorValid)).toBe(true);
  });
});
