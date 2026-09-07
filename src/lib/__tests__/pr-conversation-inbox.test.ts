// @vitest-environment node
import { describe, expect, it } from "vitest";
import { commentsMissingFromPatch } from "../pr-conversation-inbox.js";
import type { PrExistingComment } from "../pr-session.js";

function comment(
  partial: Partial<PrExistingComment> & { path: string; id: number },
): PrExistingComment {
  return {
    author: { login: "octocat" },
    body: "note",
    line: 1,
    side: "RIGHT",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: "COMMENTED",
    replies: [],
    isOutdated: false,
    ...partial,
  };
}

describe("commentsMissingFromPatch", () => {
  it("keeps threads whose files left the current patch", () => {
    const orphaned = commentsMissingFromPatch(
      [
        comment({ id: 1, path: "src/gone.ts", body: "still relevant" }),
        comment({ id: 2, path: "src/still.ts", body: "on the diff" }),
      ],
      ["src/still.ts"],
    );
    expect(orphaned.map((item) => item.id)).toEqual([1]);
    expect(orphaned[0].body).toBe("still relevant");
  });

  it("includes outdated threads on removed files", () => {
    const orphaned = commentsMissingFromPatch(
      [comment({ id: 3, path: "old/removed.ts", isOutdated: true })],
      ["src/still.ts"],
    );
    expect(orphaned).toHaveLength(1);
  });

  it("does not inbox threads that still have a file in the patch", () => {
    expect(
      commentsMissingFromPatch(
        [comment({ id: 4, path: "src/still.ts", isOutdated: true })],
        ["src/still.ts"],
      ),
    ).toEqual([]);
  });
});
