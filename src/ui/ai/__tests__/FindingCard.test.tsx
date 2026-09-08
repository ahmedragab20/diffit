import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FindingCard } from "../FindingCard";
import type { NotebookEntry } from "../../../lib/ai/notebook";

function entry(overrides: Partial<NotebookEntry> = {}): NotebookEntry {
  return {
    id: "e1",
    kind: "finding",
    title: "Cents conversion is inverted",
    body: "The call site divides where it should multiply.",
    uncertainty: "medium",
    citations: [
      {
        key: "a.ts",
        startLine: 4,
        endLine: 6,
        quote: "const cents = total / 100",
        evidenceId: "ev-1",
      },
    ],
    links: [],
    snapshotRevision: "rev-1",
    decision: null,
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  };
}

describe("rendering a finding", () => {
  it("shows the claim, kind and stated uncertainty", () => {
    render(<FindingCard entry={entry()} verification={{ "ev-1": "verified" }} />);
    expect(screen.getByText("Cents conversion is inverted")).toBeInTheDocument();
    expect(screen.getByText("Finding")).toBeInTheDocument();
    expect(screen.getByText("medium confidence")).toBeInTheDocument();
  });

  it("shows each citation with its source range and quote", () => {
    render(<FindingCard entry={entry()} verification={{ "ev-1": "verified" }} />);
    expect(screen.getByText("a.ts:4-6")).toBeInTheDocument();
    expect(screen.getByText("const cents = total / 100")).toBeInTheDocument();
  });

  it("renders a single-line citation without a range", () => {
    const single = entry({
      citations: [
        {
          key: "a.ts",
          startLine: 4,
          endLine: 4,
          quote: "x",
          evidenceId: "ev-1",
        },
      ],
    });
    render(<FindingCard entry={single} verification={{ "ev-1": "verified" }} />);
    expect(screen.getByText("a.ts:4")).toBeInTheDocument();
  });

  it.each(["finding", "proposal", "question"] as const)(
    "labels a %s by kind",
    (kind) => {
      const { container } = render(
        <FindingCard entry={entry({ kind })} verification={{ "ev-1": "verified" }} />,
      );
      expect(
        container.querySelector(`[data-kind="${kind}"]`),
      ).not.toBeNull();
    },
  );
});

describe("an unverified citation is never laundered", () => {
  it("marks the card and says how many could not be verified", () => {
    const { container } = render(<FindingCard entry={entry()} />);
    expect(
      container.querySelector('[data-unverified="true"]'),
    ).not.toBeNull();
    expect(
      screen.getByText(/1 of 1 citations could not be verified/),
    ).toBeInTheDocument();
  });

  it("still shows the citation rather than hiding it", () => {
    // Dropping it would conceal what the claim rests on.
    render(<FindingCard entry={entry()} />);
    expect(screen.getByText("const cents = total / 100")).toBeInTheDocument();
    expect(screen.getByText("unverified")).toBeInTheDocument();
  });

  it("treats an absent verification entry as unverified, not verified", () => {
    const { container } = render(
      <FindingCard entry={entry()} verification={{ other: "verified" }} />,
    );
    expect(container.querySelector('[data-status="unverified"]')).not.toBeNull();
    expect(container.querySelector('[data-status="verified"]')).toBeNull();
  });

  it("does not warn when every citation verified", () => {
    const { container } = render(
      <FindingCard entry={entry()} verification={{ "ev-1": "verified" }} />,
    );
    expect(container.querySelector('[data-unverified="false"]')).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("counts only the unverified ones when a card is mixed", () => {
    const mixed = entry({
      citations: [
        { key: "a.ts", startLine: 1, endLine: 1, quote: "a", evidenceId: "ev-1" },
        { key: "b.ts", startLine: 2, endLine: 2, quote: "b", evidenceId: "ev-2" },
      ],
    });
    render(<FindingCard entry={mixed} verification={{ "ev-1": "verified" }} />);
    expect(
      screen.getByText(/1 of 2 citations could not be verified/),
    ).toBeInTheDocument();
  });
});

describe("decisions and links", () => {
  it("says a card is awaiting a decision", () => {
    const { container } = render(
      <FindingCard entry={entry()} verification={{ "ev-1": "verified" }} />,
    );
    expect(
      container.querySelector('[data-decision="undecided"]'),
    ).not.toBeNull();
    expect(screen.getByText("awaiting decision")).toBeInTheDocument();
  });

  it("shows a recorded decision and who made it", () => {
    render(
      <FindingCard
        entry={entry({
          decision: "accepted",
          decidedBy: "reviewer",
          decidedAt: 1,
        })}
        verification={{ "ev-1": "verified" }}
      />,
    );
    expect(screen.getByText("accepted by reviewer")).toBeInTheDocument();
  });

  it("lists explicit links to other entries", () => {
    render(
      <FindingCard
        entry={entry({ links: ["e2", "e3"] })}
        verification={{ "ev-1": "verified" }}
      />,
    );
    expect(screen.getByText("links: e2, e3")).toBeInTheDocument();
  });
});
