/** Local review comments and unpublished PR drafts have distinct stores. */
export function commentApiPath(
  mode: "web" | "tui" | "gh-pr" | undefined,
  id?: string,
  suffix?: "replies",
): string {
  const base = mode === "gh-pr" ? "/api/gh/pr-session/comments" : "/api/comments";
  return `${base}${id === undefined ? "" : `/${encodeURIComponent(id)}`}${suffix ? `/${suffix}` : ""}`;
}
