// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSession } from "../../../lib/pr-session";
import { PrAuthorActions } from "../PrAuthorActions";

const session: PrSession = {
  owner: "acme",
  repo: "widget",
  pullNumber: 7,
  ref: "7",
  headSha: "abc1234deadbeef",
  baseSha: "base",
  title: "A test PR",
  url: "https://github.test/pr/7",
  author: { login: "octocat" },
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  diff: "",
  comments: [],
  existingComments: [],
  body: "Please review.",
  state: "open",
  mergeable: "MERGEABLE",
  mergeStateStatus: "clean",
  headRefName: "topic",
  baseRefName: "main",
};

describe("PrAuthorActions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders title, description, close, and merge actions", () => {
    render(<PrAuthorActions session={session} />);
    expect(screen.getByRole("button", { name: /Title/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Description/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Close/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Merge/ })).toBeInTheDocument();
  });

  it("saves a description via PATCH /api/gh/pr", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, body: "Updated body" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<PrAuthorActions session={session} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: /Description/ }));
    fireEvent.change(screen.getByLabelText("Pull request description"), {
      target: { value: "Updated body" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/gh/pr", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Updated body" }),
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("confirms close and posts /api/gh/pr/close", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, state: "closed" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PrAuthorActions session={session} />);
    fireEvent.click(screen.getByRole("button", { name: /Close/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close pull request" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/gh/pr/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  });

  it("renders nothing when the pull request is merged", () => {
    const { container } = render(
      <PrAuthorActions session={{ ...session, state: "merged" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
