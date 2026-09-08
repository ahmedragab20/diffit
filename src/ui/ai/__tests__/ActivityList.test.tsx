import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityList } from "../ActivityList";
import { EMPTY_ACTIVITY, type RunActivity } from "../../../lib/ai/activity";

function activity(overrides: Partial<RunActivity> = {}): RunActivity {
  return {
    ...EMPTY_ACTIVITY,
    phase: "responding",
    elapsedMs: 2500,
    steps: [
      { label: "source.read a.ts:1-20", outcome: "ok", at: 1 },
      { label: "source.search", outcome: "failed", at: 2 },
    ],
    ...overrides,
  };
}

describe("what the activity reports", () => {
  it("names the phase and counts the steps it actually ran", () => {
    render(<ActivityList activity={activity()} />);
    expect(screen.getByText("2 steps, 1 failed")).toBeInTheDocument();
    expect(screen.getAllByText("Responding").length).toBeGreaterThan(0);
  });

  it("reports elapsed time as a measurement", () => {
    render(<ActivityList activity={activity({ elapsedMs: 2500 })} />);
    expect(screen.getByText("2.5s")).toBeInTheDocument();
  });

  it("lists the steps and their outcomes when expanded", () => {
    render(<ActivityList activity={activity()} defaultExpanded />);
    expect(screen.getByText("source.read a.ts:1-20")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("collapses and expands on request", () => {
    render(<ActivityList activity={activity()} />);
    const toggle = screen.getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("source.search")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("source.search")).toBeInTheDocument();
  });

  it("says so plainly when nothing has been read yet", () => {
    render(<ActivityList activity={activity({ steps: [] })} defaultExpanded />);
    expect(screen.getByText("No evidence reads recorded yet.")).toBeInTheDocument();
  });

  it("surfaces warnings without calling them failures", () => {
    render(
      <ActivityList
        activity={activity({ warnings: ["context truncated"] })}
      />,
    );
    expect(screen.getByText("context truncated")).toBeInTheDocument();
  });
});

describe("no false success", () => {
  it.each([
    ["interrupted", "Interrupted"],
    ["canceled", "Canceled"],
    ["failed", "Failed"],
  ] as const)("states %s rather than dressing it as finished", (phase, label) => {
    const { container } = render(
      <ActivityList activity={activity({ phase, partial: true })} />,
    );
    expect(container.querySelector(`[data-phase="${phase}"]`)).not.toBeNull();
    expect(screen.getAllByText(new RegExp(label)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Complete/)).toBeNull();
  });

  it("labels partial output so it is not read as the whole answer", () => {
    render(
      <ActivityList activity={activity({ phase: "interrupted", partial: true })} />,
    );
    expect(screen.getByRole("status").textContent).toContain("partial output");
  });

  it("renders no progress percentage anywhere", () => {
    const { container } = render(<ActivityList activity={activity()} />);
    // The model computes no fraction, so none can reach the DOM.
    expect(container.textContent).not.toMatch(/%|percent/i);
    expect(container.querySelector("progress")).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("exposes an error code when the run failed", () => {
    render(
      <ActivityList
        activity={activity({ phase: "failed", errorCode: "capacity" })}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("capacity");
  });
});

describe("retry is visible", () => {
  it("names the attempt number beyond the first", () => {
    render(<ActivityList activity={activity({ attempt: 2 })} />);
    expect(screen.getByRole("status").textContent).toContain("attempt 2");
  });

  it("does not clutter the first attempt", () => {
    render(<ActivityList activity={activity({ attempt: 1 })} />);
    expect(screen.getByRole("status").textContent).not.toContain("attempt");
  });
});

describe("status is announced accessibly", () => {
  it("uses a live status region rather than the whole transcript", () => {
    render(<ActivityList activity={activity()} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("labels the region for assistive technology", () => {
    render(<ActivityList activity={activity()} />);
    expect(screen.getByLabelText("Run activity")).toBeInTheDocument();
  });
});
