// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../../router", () => ({ navigate }));
vi.mock("../ReviewSettingsPopover", () => ({
  ReviewSettingsPopover: () => <button type="button">Settings</button>,
}));
vi.mock("../SubmitToGitHubPopover", () => ({
  SubmitToGitHubPopover: () => <button type="button">Submit to GitHub</button>,
}));
import { PrReviewToolbar } from "../PrReviewToolbar";

const session = {
  owner: "octo",
  repo: "project",
  pullNumber: 42,
  title: "Unify the review experience",
  changedFiles: 3,
  additions: 21,
  deletions: 8,
  headSha: "abcdef123456",
  headRefName: "feature/widget",
  baseRefName: "main",
  url: "https://github.com/octo/project/pull/42",
} as any;
const props = (overrides = {}) => ({
  session,
  comments: [],
  settingsProps: {} as any,
  sidebarCollapsed: false,
  onToggleSidebar: vi.fn(),
  onOpenSearch: vi.fn(),
  onRefresh: vi.fn(),
  refreshing: false,
  onEditComment: vi.fn(),
  onDeleteComment: vi.fn(),
  ...overrides,
});

describe("PrReviewToolbar", () => {
  beforeEach(() => navigate.mockReset());

  it("exposes More actions and omits PR details and branch flow", () => {
    render(<PrReviewToolbar {...props()} />);
    expect(screen.getByText("octo/project")).toBeInTheDocument();
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /settings/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /submit to github/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /More actions/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("feature/widget")).not.toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Edit details/i }),
    ).not.toBeInTheDocument();
  });

  it("disables Copy draft comments for empty comments and opens GitHub", () => {
    render(<PrReviewToolbar {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /More actions/i }));
    expect(
      screen.getByRole("button", { name: "Copy draft comments" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("link", { name: /Open on GitHub/i }),
    ).toHaveAttribute("href", session.url);
  });

  it("routes back locally and refreshes explicitly", () => {
    const refresh = vi.fn();
    render(<PrReviewToolbar {...props({ onRefresh: refresh })} />);
    fireEvent.click(
      screen.getByRole("button", { name: /back to local review/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(navigate).toHaveBeenCalledWith("/");
    expect(refresh).toHaveBeenCalledOnce();
  });
});
