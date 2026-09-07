// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReviewComment } from "../../../lib/types";
import { CommentBubble } from "../CommentBubble";

const mocks = vi.hoisted(() => ({
  resolveComment: vi.fn(),
  unresolveComment: vi.fn(),
  addReply: vi.fn(),
  removeReply: vi.fn(),
  editReply: vi.fn(),
  applySuggestion: vi.fn(),
  editComment: vi.fn(),
}));

const formState = vi.hoisted(() => ({
  submit: undefined as ((body: string) => void | Promise<unknown>) | undefined,
}));

vi.mock("../../hooks/useComments", () => ({
  useComments: () => mocks,
}));

vi.mock("../Markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock("../CommentForm", () => ({
  CommentForm: ({
    onSubmit,
  }: {
    onSubmit: (body: string) => void | Promise<unknown>;
  }) => {
    formState.submit = onSubmit;
    return <div data-testid="form" />;
  },
}));

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1",
    filePath: "a.ts",
    side: "additions",
    lineNumber: 9,
    lineContent: "+const x = 1",
    body: "fragile check",
    status: "open",
    createdAt: Date.now(),
    replies: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("CommentBubble persistence", () => {
  it("keeps the comment edit form open while persistence is pending and after rejection", async () => {
    const pending = deferred<void>();
    mocks.editComment.mockReturnValue(pending.promise);
    render(<CommentBubble comment={comment()} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    expect(screen.getByTestId("form")).toBeInTheDocument();

    let submission!: Promise<unknown>;
    await act(async () => {
      submission = Promise.resolve(formState.submit!("updated body"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("form")).toBeInTheDocument();

    pending.reject(new Error("save failed"));
    await expect(submission).rejects.toThrow("save failed");
    expect(screen.getByTestId("form")).toBeInTheDocument();
  });

  it("keeps the new-reply form open while persistence is pending and after rejection", async () => {
    const pending = deferred<void>();
    mocks.addReply.mockReturnValue(pending.promise);
    render(<CommentBubble comment={comment()} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Write a reply" }));
    expect(screen.getByTestId("form")).toBeInTheDocument();

    let submission!: Promise<unknown>;
    await act(async () => {
      submission = Promise.resolve(formState.submit!("a reply"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("form")).toBeInTheDocument();

    pending.reject(new Error("reply failed"));
    await expect(submission).rejects.toThrow("reply failed");
    expect(screen.getByTestId("form")).toBeInTheDocument();
  });

  it("closes the user reply edit form only after persistence resolves", async () => {
    const pending = deferred<void>();
    mocks.editReply.mockReturnValue(pending.promise);
    const reply = {
      id: "r1",
      body: "old reply",
      createdAt: Date.now(),
      role: "user" as const,
    };
    render(
      <CommentBubble
        comment={comment({ replies: [reply] })}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit reply" }));
    expect(screen.getByTestId("form")).toBeInTheDocument();

    let submission!: Promise<unknown>;
    await act(async () => {
      submission = Promise.resolve(formState.submit!("updated reply"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("form")).toBeInTheDocument();

    await act(async () => {
      pending.resolve();
      await submission;
    });
    expect(screen.queryByTestId("form")).not.toBeInTheDocument();
  });
});
