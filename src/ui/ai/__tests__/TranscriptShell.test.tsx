import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptShell } from "../TranscriptShell";
import { EMPTY_ACTIVITY, type RunActivity } from "../../../lib/ai/activity";
import type { NotebookEntry } from "../../../lib/ai/notebook";
import type { AiConversationTurn } from "../../../lib/ai/types";

vi.mock("../../components/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

const turn = (
  id: string,
  role: AiConversationTurn["role"],
  text: string,
): AiConversationTurn => ({ id, role, text });

const activity = (overrides: Partial<RunActivity> = {}): RunActivity => ({
  ...EMPTY_ACTIVITY,
  phase: "complete",
  ...overrides,
});

function finding(): NotebookEntry {
  return {
    id: "f1",
    kind: "finding",
    title: "Inverted conversion",
    body: "Divides where it should multiply.",
    uncertainty: "medium",
    citations: [
      {
        key: "a.ts",
        startLine: 1,
        endLine: 1,
        quote: "total / 100",
        evidenceId: "ev-1",
      },
    ],
    links: [],
    snapshotRevision: "rev",
    decision: null,
    decidedBy: null,
    decidedAt: null,
  };
}

describe("composition", () => {
  it("says plainly when nothing has been asked", () => {
    render(
      <TranscriptShell turns={[]} activity={activity()} onCopy={() => {}} />,
    );
    expect(
      screen.getByText("Nothing has been asked in this conversation yet."),
    ).toBeInTheDocument();
  });

  it("renders user and assistant turns in order", () => {
    const { container } = render(
      <TranscriptShell
        turns={[turn("u1", "user", "why?"), turn("a1", "assistant", "because")]}
        activity={activity()}
        onCopy={() => {}}
      />,
    );
    expect(container.textContent).toContain("why?");
    expect(container.textContent).toContain("because");
  });

  it("keeps the streaming response out of the completed turns", () => {
    const { container } = render(
      <TranscriptShell
        turns={[turn("a1", "assistant", "settled")]}
        activity={activity({ phase: "responding", partial: true })}
        streaming={{ turn: turn("u2", "user", "next"), text: "partial" }}
        onCopy={() => {}}
      />,
    );
    // A stream must never rewrite settled history.
    const streamed = container.querySelector('[data-streaming="true"]');
    expect(streamed?.textContent).toBe("partial");
    expect(container.querySelector('[data-turn-id="a1"]')?.textContent).toContain(
      "settled",
    );
  });

  it("shows cited findings alongside the conversation", () => {
    render(
      <TranscriptShell
        turns={[]}
        activity={activity()}
        findings={[finding()]}
        verification={{ "ev-1": "verified" }}
        onCopy={() => {}}
      />,
    );
    expect(screen.getByLabelText("Cited findings")).toBeInTheDocument();
    expect(screen.getByText("Inverted conversion")).toBeInTheDocument();
  });

  it("always reports run activity", () => {
    render(
      <TranscriptShell turns={[]} activity={activity()} onCopy={() => {}} />,
    );
    expect(screen.getByLabelText("Run activity")).toBeInTheDocument();
  });

  it("shows a braille thinking mark without nested dots", () => {
    const { container } = render(
      <TranscriptShell
        turns={[]}
        activity={activity({ phase: "preparing" })}
        streaming={{ turn: turn("u2", "user", "next"), text: "" }}
        onCopy={() => {}}
      />,
    );
    expect(screen.getByText("Thinking about your request")).toBeInTheDocument();
    const mark = container.querySelector(".ai-thinking-mark");
    expect(mark).not.toBeNull();
    expect(mark?.querySelectorAll("i")).toHaveLength(0);
  });
});

describe("retry is offered only after a terminal failure", () => {
  it.each(["failed", "interrupted", "canceled"] as const)(
    "offers a retry after %s",
    (phase) => {
      const onRetry = vi.fn();
      render(
        <TranscriptShell
          turns={[]}
          activity={activity({ phase })}
          onCopy={() => {}}
          onRetry={onRetry}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(onRetry).toHaveBeenCalled();
      // The wording must not imply the failed attempt is replaced.
      expect(
        screen.getByText(/starts a new attempt and keeps the one above/),
      ).toBeInTheDocument();
    },
  );

  it.each(["complete", "responding", "preparing"] as const)(
    "offers no retry while %s",
    (phase) => {
      render(
        <TranscriptShell
          turns={[]}
          activity={activity({ phase })}
          onCopy={() => {}}
          onRetry={() => {}}
        />,
      );
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    },
  );

  it("offers no retry when no handler was given", () => {
    render(
      <TranscriptShell
        turns={[]}
        activity={activity({ phase: "failed" })}
        onCopy={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("the shipped rail mounts it", () => {
  it("is imported by the assistant rail App already mounts", () => {
    const rail = readFileSync(
      resolve(process.cwd(), "src/ui/ai/AiAssistantRail.tsx"),
      "utf8",
    );
    expect(rail).toContain('from "./TranscriptShell"');
    expect(rail).toContain("<TranscriptShell");
  });
});
