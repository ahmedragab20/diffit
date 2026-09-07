// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PrConversationInbox } from "../PrConversationInbox";

const orphaned = {
  id: 9,
  author: { login: "octocat" },
  body: "still relevant after the file left the patch",
  path: "src/gone.ts",
  line: 4,
  side: "RIGHT",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  state: "COMMENTED",
  replies: [],
  isOutdated: true,
} as any;

describe("PrConversationInbox", () => {
  it("renders nothing when every thread still has a file in the patch", () => {
    const { container } = render(<PrConversationInbox comments={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows outdated threads whose files left the current patch", () => {
    render(<PrConversationInbox comments={[orphaned]} />);
    expect(
      screen.getByRole("region", { name: /files no longer in this patch/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("src/gone.ts")).toBeInTheDocument();
    expect(
      screen.getByText("still relevant after the file left the patch"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1 conversation on files no longer in this patch/i),
    ).toBeInTheDocument();
  });
});
