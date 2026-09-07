// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSession } from "../../../lib/pr-session";
import { PrAuthorActions } from "../PrAuthorActions";

const session: PrSession = {
  owner: "acme", repo: "widget", pullNumber: 7, ref: "7", headSha: "abc1234deadbeef", baseSha: "base",
  title: "A test PR", url: "https://github.test/pr/7", author: { login: "octocat" }, additions: 1, deletions: 0,
  changedFiles: 1, diff: "", comments: [], existingComments: [], body: "Please review.", state: "open",
  mergeable: "MERGEABLE", mergeStateStatus: "clean", headRefName: "topic", baseRefName: "main",
};

describe("PrAuthorActions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exposes Edit details and PR actions before close/merge actions", () => {
    render(<PrAuthorActions session={session} />);
    expect(screen.getByRole("button", { name: /Edit details/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Title|Description/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /PR actions/ }));
    expect(screen.getByRole("button", { name: "Merge pull request" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close pull request" })).toBeInTheDocument();
  });

  it("saves a description via Edit details", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<PrAuthorActions session={session} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit details/ }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Updated body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to GitHub" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/gh/pr", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "Updated body" }),
    }));
    expect(onChanged).toHaveBeenCalled();
  });

  it("confirms close and posts /api/gh/pr/close", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "closed" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<PrAuthorActions session={session} />);
    fireEvent.click(screen.getByRole("button", { name: /PR actions/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close pull request" }));
    fireEvent.click(screen.getByRole("button", { name: "Close pull request" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/gh/pr/close", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    }));
  });

  it("reopens a closed pull request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "open" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<PrAuthorActions session={{ ...session, state: "closed" }} />);
    fireEvent.click(screen.getByRole("button", { name: /PR actions/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen pull request" }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/gh/pr/reopen", expect.objectContaining({ method: "POST" })));
  });

  it("blocks merge when the pull request has conflicts", () => {
    render(<PrAuthorActions session={{ ...session, mergeable: "CONFLICTING" }} />);
    fireEvent.click(screen.getByRole("button", { name: /PR actions/ }));
    expect(screen.getByRole("button", { name: "Merge pull request" })).toBeDisabled();
    expect(screen.getByText("Pull request has merge conflicts")).toBeInTheDocument();
  });

  it("renders nothing when the pull request is merged", () => {
    const { container } = render(<PrAuthorActions session={{ ...session, state: "merged" }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
