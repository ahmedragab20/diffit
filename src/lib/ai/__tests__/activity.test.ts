import { describe, expect, it } from "vitest";
import {
  EMPTY_ACTIVITY,
  TERMINAL_PHASES,
  deriveActivity,
  isActive,
  retryOf,
  type ActivityInput,
} from "../activity.js";
import type { AiRunEvent } from "../types.js";

const started: AiRunEvent = {
  type: "start",
  runId: "r1",
  modelId: "codex/test",
};
const delta = (text: string): AiRunEvent => ({ type: "text-delta", text });
const completed = (text: string): AiRunEvent => ({ type: "complete", text });

const at = (overrides: Partial<ActivityInput> = {}): ActivityInput => ({
  now: 5_000,
  startedAt: 1_000,
  ...overrides,
});

describe("the state matrix the plan enumerates", () => {
  it("is disconnected before anything happens", () => {
    expect(EMPTY_ACTIVITY.phase).toBe("disconnected");
    expect(EMPTY_ACTIVITY.succeeded).toBe(false);
  });

  it("is preparing once queued but before the run starts", () => {
    expect(deriveActivity([], at()).phase).toBe("preparing");
  });

  it("is reading after start but before any text", () => {
    expect(deriveActivity([started], at()).phase).toBe("reading");
  });

  it("is responding once text begins", () => {
    const activity = deriveActivity([started, delta("hel")], at());
    expect(activity.phase).toBe("responding");
    expect(activity.text).toBe("hel");
    expect(activity.partial).toBe(true);
  });

  it("is reconnecting while the transport retries", () => {
    expect(
      deriveActivity([started], at({ reconnecting: true })).phase,
    ).toBe("reconnecting");
  });

  it("is cancel-requested before the run confirms", () => {
    expect(
      deriveActivity([started, delta("x")], at({ cancelRequested: true })).phase,
    ).toBe("cancel-requested");
  });

  it("is canceled once the stream ends after a cancel request", () => {
    const activity = deriveActivity(
      [started, delta("half")],
      at({ cancelRequested: true, streamEnded: true }),
    );
    expect(activity.phase).toBe("canceled");
    // Partial output survives cancellation, labelled as partial.
    expect(activity.text).toBe("half");
    expect(activity.partial).toBe(true);
    expect(activity.succeeded).toBe(false);
  });

  it("is interrupted when the stream ends with no terminal event", () => {
    const activity = deriveActivity(
      [started, delta("half")],
      at({ streamEnded: true }),
    );
    expect(activity.phase).toBe("interrupted");
    expect(activity.succeeded).toBe(false);
    expect(activity.text).toBe("half");
  });

  it("is failed when the run reports an error", () => {
    const activity = deriveActivity(
      [started, delta("part"), { type: "error", message: "no", code: "capacity" }],
      at(),
    );
    expect(activity.phase).toBe("failed");
    expect(activity.errorCode).toBe("capacity");
    expect(activity.partial).toBe(true);
  });

  it("defaults an error with no code rather than claiming none", () => {
    const activity = deriveActivity(
      [started, { type: "error", message: "no" }],
      at(),
    );
    expect(activity.errorCode).toBe("provider_failed");
  });

  it("is complete only on a terminal complete event", () => {
    const activity = deriveActivity(
      [started, delta("par"), completed("partial answer")],
      at(),
    );
    expect(activity.phase).toBe("complete");
    expect(activity.succeeded).toBe(true);
    expect(activity.partial).toBe(false);
    // The complete event carries the authoritative text.
    expect(activity.text).toBe("partial answer");
  });
});

describe("no false success", () => {
  it("never reports success from a stream that simply stopped", () => {
    for (const input of [
      at({ streamEnded: true }),
      at({ streamEnded: true, cancelRequested: true }),
    ])
      expect(deriveActivity([started, delta("x")], input).succeeded).toBe(false);
  });

  it("never reports success alongside an error", () => {
    const activity = deriveActivity(
      [started, { type: "error", message: "no", code: "capacity" }],
      at(),
    );
    expect(activity.succeeded).toBe(false);
  });

  it("exposes no progress fraction to render", () => {
    const activity = deriveActivity([started, delta("x")], at());
    const keys = Object.keys(activity);
    // A percentage cannot be invented if none is computed.
    for (const forbidden of ["progress", "percent", "percentage", "fraction"])
      expect(keys).not.toContain(forbidden);
    expect(JSON.stringify(activity)).not.toMatch(/percent|progress/i);
  });

  it("exposes no model reasoning channel", () => {
    const activity = deriveActivity([started, delta("x")], at());
    for (const forbidden of ["reasoning", "thoughts", "chainOfThought"])
      expect(Object.keys(activity)).not.toContain(forbidden);
  });
});

describe("counted facts, not guesses", () => {
  it("measures elapsed time from the injected clock", () => {
    expect(deriveActivity([started], at()).elapsedMs).toBe(4_000);
  });

  it("never reports negative elapsed time from a skewed clock", () => {
    expect(
      deriveActivity([started], at({ now: 0, startedAt: 5_000 })).elapsedMs,
    ).toBe(0);
  });

  it("reports the steps the run actually performed", () => {
    const steps = [
      { label: "source.read a.ts:1-20", outcome: "ok" as const, at: 1 },
      { label: "source.search", outcome: "failed" as const, at: 2 },
    ];
    const activity = deriveActivity([started], at({ steps }));
    expect(activity.steps).toEqual(steps);
    expect(activity.steps.filter((step) => step.outcome === "failed")).toHaveLength(
      1,
    );
  });

  it("collects warnings without turning them into failures", () => {
    const activity = deriveActivity(
      [started, { type: "warning", message: "context truncated" }, completed("a")],
      at(),
    );
    expect(activity.warnings).toEqual(["context truncated"]);
    expect(activity.phase).toBe("complete");
    expect(activity.errorCode).toBeNull();
  });
});

describe("retry is a new attempt", () => {
  it("increments the attempt and does not carry the old text", () => {
    const first = deriveActivity(
      [started, delta("old"), { type: "error", message: "no" }],
      at(),
    );
    const second = retryOf(first);
    expect(second.attempt).toBe(first.attempt + 1);
    expect(second.text).toBe("");
    expect(second.phase).toBe("disconnected");
    // The previous attempt is untouched, not overwritten.
    expect(first.text).toBe("old");
    expect(first.attempt).toBe(1);
  });
});

describe("terminality", () => {
  it.each(TERMINAL_PHASES)("treats %s as no longer active", (phase) => {
    expect(isActive({ ...EMPTY_ACTIVITY, phase })).toBe(false);
  });

  it.each(["preparing", "reading", "responding", "reconnecting", "cancel-requested"] as const)(
    "treats %s as still active",
    (phase) => {
      expect(isActive({ ...EMPTY_ACTIVITY, phase })).toBe(true);
    },
  );
});
