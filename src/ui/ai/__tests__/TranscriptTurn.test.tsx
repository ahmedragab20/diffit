import { useCallback, useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptTurn } from "../TranscriptTurn";
import type { AiConversationTurn } from "../../../lib/ai/types";

vi.mock("../../components/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => {
    // Counts how often a turn's Markdown is actually re-parsed.
    renders.push(content);
    return <div data-testid="markdown">{content}</div>;
  },
}));

let renders: string[] = [];

function turn(id: string, text: string): AiConversationTurn {
  return { id, role: "assistant", text };
}

/** A transcript with completed turns above one streaming response. */
function Transcript({ initialStream = "" }: { initialStream?: string }) {
  const [stream, setStream] = useState(initialStream);
  const onCopy = useCallback(() => {}, []);
  return (
    <div>
      <TranscriptTurn turn={turn("a", "first")} copied={false} onCopy={onCopy} />
      <TranscriptTurn turn={turn("b", "second")} copied={false} onCopy={onCopy} />
      <div data-testid="streaming">{stream}</div>
      <button type="button" onClick={() => setStream((s) => `${s}x`)}>
        token
      </button>
    </div>
  );
}

describe("completed turns are memoized", () => {
  it("does not re-parse completed turns while a response streams", () => {
    renders = [];
    render(<Transcript />);
    const afterMount = renders.length;
    expect(afterMount).toBe(2);

    // Stream several tokens; each one re-renders the parent.
    for (let i = 0; i < 5; i++)
      fireEvent.click(screen.getByRole("button", { name: "token" }));

    expect(screen.getByTestId("streaming").textContent).toBe("xxxxx");
    // The completed turns must not have been re-parsed once.
    expect(renders.length).toBe(afterMount);
  });

  it("re-renders a turn whose own text changed", () => {
    renders = [];
    const onCopy = () => {};
    const { rerender } = render(
      <TranscriptTurn turn={turn("a", "one")} copied={false} onCopy={onCopy} />,
    );
    rerender(
      <TranscriptTurn turn={turn("a", "two")} copied={false} onCopy={onCopy} />,
    );
    expect(renders).toEqual(["one", "two"]);
  });

  it("re-renders when its copied state changes", () => {
    renders = [];
    const onCopy = () => {};
    const { rerender } = render(
      <TranscriptTurn turn={turn("a", "one")} copied={false} onCopy={onCopy} />,
    );
    rerender(
      <TranscriptTurn turn={turn("a", "one")} copied onCopy={onCopy} />,
    );
    expect(renders.length).toBe(2);
    expect(screen.getByRole("button", { name: /Copy response a/ }).textContent)
      .toContain("Copied");
  });

  it("does not re-render for an unrelated identical prop object", () => {
    renders = [];
    const onCopy = () => {};
    const { rerender } = render(
      <TranscriptTurn turn={turn("a", "one")} copied={false} onCopy={onCopy} />,
    );
    // A fresh turn object with identical content must not re-parse.
    rerender(
      <TranscriptTurn turn={turn("a", "one")} copied={false} onCopy={onCopy} />,
    );
    expect(renders.length).toBe(1);
  });
});

describe("turn affordances", () => {
  it("copies the turn it belongs to", () => {
    const onCopy = vi.fn();
    render(
      <TranscriptTurn turn={turn("a", "one")} copied={false} onCopy={onCopy} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Copy response a/ }));
    expect(onCopy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", text: "one" }),
    );
  });

  it("keeps the text selectable and addressable", () => {
    renders = [];
    const { container } = render(
      <TranscriptTurn turn={turn("a", "one")} copied={false} onCopy={() => {}} />,
    );
    expect(container.querySelector('[data-turn-id="a"]')).not.toBeNull();
    expect(screen.getByTestId("markdown").textContent).toBe("one");
  });
});
