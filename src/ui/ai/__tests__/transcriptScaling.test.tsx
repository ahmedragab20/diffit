import { useCallback, useState } from "react";
import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptTurn } from "../TranscriptTurn";
import type { AiConversationTurn } from "../../../lib/ai/types";

/**
 * Responsiveness as an algorithmic property rather than a stopwatch.
 *
 * Wall-clock timings in jsdom say nothing about a real browser, but the shape
 * of the work does: if streaming a token re-parses every completed turn, cost
 * grows with conversation length and a long review degrades. Counting parses
 * measures that directly and does not flake.
 */
let parses: string[] = [];

vi.mock("../../components/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => {
    parses.push(content);
    return <div>{content}</div>;
  },
}));

function turn(index: number): AiConversationTurn {
  return {
    id: `t${index}`,
    role: "assistant",
    text: `completed answer ${index}`,
  };
}

function Transcript({ length }: { length: number }) {
  const [stream, setStream] = useState("");
  const onCopy = useCallback(() => {}, []);
  const turns = Array.from({ length }, (_, index) => turn(index));
  return (
    <div>
      {turns.map((item) => (
        <TranscriptTurn
          key={item.id}
          turn={item}
          copied={false}
          onCopy={onCopy}
        />
      ))}
      <div data-testid="stream">{stream}</div>
      <button type="button" onClick={() => setStream((s) => `${s}x`)}>
        token
      </button>
    </div>
  );
}

function parsesWhileStreaming(length: number, tokens: number): number {
  parses = [];
  // Scoped to this render and unmounted after, so repeated measurements in one
  // test do not collide in a shared container.
  const view = render(<Transcript length={length} />);
  const mounted = parses.length;
  expect(mounted).toBe(length);
  for (let i = 0; i < tokens; i++)
    fireEvent.click(view.getByRole("button", { name: "token" }));
  const streamed = parses.length - mounted;
  view.unmount();
  return streamed;
}

describe("streaming cost does not grow with the transcript", () => {
  it.each([5, 50, 200])(
    "re-parses nothing while streaming into a %i-turn transcript",
    (length) => {
      expect(parsesWhileStreaming(length, 10)).toBe(0);
    },
  );

  it("stays flat as the transcript grows by 40x", () => {
    // The same token count against very different histories must cost the same.
    const small = parsesWhileStreaming(5, 10);
    const large = parsesWhileStreaming(200, 10);
    expect(large).toBe(small);
  });

  it("scales with tokens only through the active response, not history", () => {
    const few = parsesWhileStreaming(100, 5);
    const many = parsesWhileStreaming(100, 50);
    // Ten times the tokens must not mean ten times the transcript work.
    expect(few).toBe(0);
    expect(many).toBe(0);
  });

  it("still parses each turn exactly once on first paint", () => {
    parses = [];
    render(<Transcript length={20} />);
    expect(parses.length).toBe(20);
    expect(new Set(parses).size).toBe(20);
  });
});
