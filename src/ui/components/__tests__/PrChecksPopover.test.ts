import { describe, expect, it } from "vitest";
import {
  checksOverallTone,
  checksRefreshInterval,
  type PrCheck,
} from "../PrChecksPopover";

describe("GitHub checks live refresh cadence", () => {
  it("polls frequently while a workflow is pending", () => {
    const checks: PrCheck[] = [
      { name: "build", state: "success" },
      { name: "integration", state: "pending" },
    ];
    expect(checksRefreshInterval(checks)).toBe(8_000);
  });

  it("backs off after every workflow reaches a terminal state", () => {
    const checks: PrCheck[] = [
      { name: "build", state: "success" },
      { name: "integration", state: "failure" },
    ];
    expect(checksRefreshInterval(checks)).toBe(30_000);
  });

  it("does not treat cancelled-only results as overall success", () => {
    expect(checksOverallTone([{ name: "build", state: "cancelled" }])).toBe(
      "neutral",
    );
    expect(checksOverallTone([{ name: "build", state: "unknown" }])).toBe(
      "neutral",
    );
    expect(checksOverallTone([{ name: "build", state: "success" }])).toBe(
      "success",
    );
    expect(checksOverallTone([{ name: "build", state: "failure" }])).toBe(
      "failure",
    );
  });
});
