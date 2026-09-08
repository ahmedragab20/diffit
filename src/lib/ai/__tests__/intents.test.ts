import { describe, expect, it } from "vitest";
import { AiSnapshotError } from "../snapshots.js";
import {
  INTENT_BOUNDS,
  admitIntent,
  checkBudget,
  type ProposalKind,
  type ReviewIntent,
} from "../intents.js";

const intents: ReviewIntent[] = ["ask", "investigate", "propose"];

function expectCode(fn: () => unknown, code: AiSnapshotError["code"]): void {
  try {
    fn();
    throw new Error("expected a snapshot error");
  } catch (error) {
    expect(error).toBeInstanceOf(AiSnapshotError);
    expect((error as AiSnapshotError).code).toBe(code);
  }
}

describe("admitting an activity", () => {
  it("admits ask and investigate without a proposal kind", () => {
    for (const intent of ["ask", "investigate"] as const) {
      const admitted = admitIntent({ intent, trigger: "user" });
      expect(admitted.intent).toBe(intent);
      expect(admitted.proposal).toBeNull();
      expect(admitted.requiresHumanApproval).toBe(false);
    }
  });

  it.each([
    "comment",
    "reply",
    "summary",
    "code-suggestion",
    "plan-revision",
  ] as ProposalKind[])("admits a %s proposal as inert", (proposal) => {
    const admitted = admitIntent({ intent: "propose", trigger: "user", proposal });
    expect(admitted.proposal).toBe(proposal);
    // A proposal is shown for review; it is never an action already taken.
    expect(admitted.requiresHumanApproval).toBe(true);
  });

  it("refuses a proposal that does not say what it drafts", () => {
    expectCode(
      () => admitIntent({ intent: "propose", trigger: "user" }),
      "invalid",
    );
    expectCode(
      () =>
        admitIntent({
          intent: "propose",
          trigger: "user",
          proposal: "merge" as ProposalKind,
        }),
      "invalid",
    );
  });

  it("refuses a proposal kind on a non-proposal activity", () => {
    expectCode(
      () =>
        admitIntent({ intent: "ask", trigger: "user", proposal: "comment" }),
      "invalid",
    );
  });

  it("refuses an unknown activity", () => {
    expectCode(
      () => admitIntent({ intent: "browse" as ReviewIntent, trigger: "user" }),
      "invalid",
    );
  });

  it("refuses anything but an explicit user trigger", () => {
    expectCode(
      () =>
        admitIntent({
          intent: "ask",
          trigger: "background" as "user",
        }),
      "invalid",
    );
  });
});

describe("what each activity must return", () => {
  it("expects citations and explicit unknowns from an answer", () => {
    expect(admitIntent({ intent: "ask", trigger: "user" }).expects).toEqual([
      "citations",
      "unknowns",
    ]);
  });

  it("expects findings, questions and coverage from an investigation", () => {
    expect(
      admitIntent({ intent: "investigate", trigger: "user" }).expects,
    ).toEqual(["findings", "questions", "coverage"]);
  });

  it("expects a cited draft from a proposal", () => {
    expect(
      admitIntent({ intent: "propose", trigger: "user", proposal: "comment" })
        .expects,
    ).toEqual(["draft", "citations"]);
  });
});

describe("bounds", () => {
  it("gives only investigation a step budget above one", () => {
    expect(INTENT_BOUNDS.ask.maxSteps).toBe(1);
    expect(INTENT_BOUNDS.propose.maxSteps).toBe(1);
    expect(INTENT_BOUNDS.investigate.maxSteps).toBeGreaterThan(1);
  });

  it.each(intents)("bounds %s in duration, steps and output", (intent) => {
    const bounds = INTENT_BOUNDS[intent];
    for (const value of [bounds.maxMs, bounds.maxSteps, bounds.maxOutputBytes])
      expect(value).toBeGreaterThan(0);
  });

  it("accepts an activity inside its bounds", () => {
    const admitted = admitIntent({ intent: "investigate", trigger: "user" });
    expect(
      checkBudget(admitted, { steps: 3, elapsedMs: 1000, outputBytes: 10 }),
    ).toEqual({ withinBounds: true, exceeded: null });
  });

  it.each([
    ["steps", { steps: 999, elapsedMs: 0, outputBytes: 0 }],
    ["duration", { steps: 0, elapsedMs: 10 ** 9, outputBytes: 0 }],
    ["output", { steps: 0, elapsedMs: 0, outputBytes: 10 ** 9 }],
  ])("names %s when it is the bound that stopped the activity", (
    exceeded,
    used,
  ) => {
    const admitted = admitIntent({ intent: "investigate", trigger: "user" });
    // Exhaustion is reported, so partial work is never presented as complete.
    expect(checkBudget(admitted, used)).toEqual({
      withinBounds: false,
      exceeded,
    });
  });

  it("stops a second step on a single-step activity", () => {
    const admitted = admitIntent({ intent: "ask", trigger: "user" });
    expect(
      checkBudget(admitted, { steps: 2, elapsedMs: 0, outputBytes: 0 }),
    ).toMatchObject({ withinBounds: false, exceeded: "steps" });
  });

  it.each([
    { steps: -1, elapsedMs: 0, outputBytes: 0 },
    { steps: 0, elapsedMs: Number.NaN, outputBytes: 0 },
    { steps: 0, elapsedMs: 0, outputBytes: Number.POSITIVE_INFINITY },
  ])("refuses a nonsensical budget %j", (used) => {
    const admitted = admitIntent({ intent: "ask", trigger: "user" });
    expectCode(() => checkBudget(admitted, used), "invalid");
  });
});

describe("a proposal cannot act", () => {
  it("carries no apply or publish affordance", () => {
    const admitted = admitIntent({
      intent: "propose",
      trigger: "user",
      proposal: "code-suggestion",
    });
    // The admitted shape is data describing a draft; it exposes no operation.
    expect(Object.keys(admitted).sort()).toEqual([
      "bounds",
      "expects",
      "intent",
      "proposal",
      "requiresHumanApproval",
    ]);
    for (const value of Object.values(admitted))
      expect(typeof value).not.toBe("function");
  });

  it("marks every proposal kind as requiring approval", () => {
    for (const proposal of [
      "comment",
      "reply",
      "summary",
      "code-suggestion",
      "plan-revision",
    ] as ProposalKind[])
      expect(
        admitIntent({ intent: "propose", trigger: "user", proposal })
          .requiresHumanApproval,
      ).toBe(true);
  });
});
