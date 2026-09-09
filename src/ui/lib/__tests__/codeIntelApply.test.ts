import { describe, expect, it } from "vitest";
import { decideCodeIntelApply } from "../codeIntelApply";
import type { CodeIntelEdit } from "../../hooks/useCodeIntel";

const edit = (newText: string): CodeIntelEdit => ({
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  },
  newText,
});

describe("decideCodeIntelApply", () => {
  it("applies a same-file result through applyEdits", () => {
    const decision = decideCodeIntelApply(
      { edits: [edit("b")], otherEdits: 0, otherFiles: 0 },
      "Rename",
    );
    expect(decision).toEqual({
      apply: true,
      edits: [edit("b")],
      notice: "Rename: applied 1 edit in this file.",
    });
  });

  it("applies nothing when the rename spills into other files", () => {
    const decision = decideCodeIntelApply(
      { edits: [edit("b"), edit("c")], otherEdits: 10, otherFiles: 3 },
      "Rename",
    );
    expect(decision.apply).toBe(false);
    if (decision.apply) throw new Error("expected a refusal");
    expect(decision.notice).toBe("12 edits across 4 files — not applied, this file only");
  });

  it("surfaces an unavailable reason without applying", () => {
    expect(decideCodeIntelApply({ reason: "not-configured" }, "Format")).toEqual({
      apply: false,
      notice: "Format unavailable: not-configured",
    });
  });
});
