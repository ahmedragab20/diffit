// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  buildReviewPayload,
  classifyPrComments,
  decisionToEvent,
  expandMultiLineComments,
  ghRepoSelector,
  githubApiBase,
  parseGitRemoteUrl,
  parsePrRef,
} from "../github.js";
import type { ReviewComment } from "../types.js";

function c(
  partial: Partial<ReviewComment> & {
    filePath: string;
    body: string;
    lineNumber: number;
  },
): ReviewComment {
  return {
    id: partial.id ?? `c-${partial.lineNumber}`,
    side: partial.side ?? "additions",
    startLineNumber: partial.startLineNumber,
    lineContent: partial.lineContent ?? "",
    status: partial.status ?? "open",
    createdAt: partial.createdAt ?? 1000,
    replies: partial.replies ?? [],
    ...partial,
  } as ReviewComment;
}

describe("decisionToEvent", () => {
  it("approve → APPROVE", () => {
    expect(decisionToEvent("approve")).toBe("APPROVE");
  });
  it("request-changes → REQUEST_CHANGES", () => {
    expect(decisionToEvent("request-changes")).toBe("REQUEST_CHANGES");
  });
  it("comment → COMMENT", () => {
    expect(decisionToEvent("comment")).toBe("COMMENT");
  });
  it("draft → null (pending review, omit event)", () => {
    expect(decisionToEvent("draft")).toBeNull();
  });
});

describe("expandMultiLineComments", () => {
  it("emits one entry per single-line comment on the RIGHT side", () => {
    const out = expandMultiLineComments([
      c({ filePath: "foo.ts", lineNumber: 10, body: "hi" }),
    ]);
    expect(out).toEqual([
      { path: "foo.ts", line: 10, side: "RIGHT", body: "hi" },
    ]);
  });

  it("maps deletions side to LEFT", () => {
    const out = expandMultiLineComments([
      c({ filePath: "foo.ts", lineNumber: 3, side: "deletions", body: "gone" }),
    ]);
    expect(out).toEqual([
      { path: "foo.ts", line: 3, side: "LEFT", body: "gone" },
    ]);
  });

  it("emits a single multi-line comment with start_line/line (no N-part explosion)", () => {
    const out = expandMultiLineComments([
      c({
        filePath: "foo.ts",
        lineNumber: 12,
        startLineNumber: 10,
        body: "range comment",
      }),
    ]);
    expect(out).toEqual([
      {
        path: "foo.ts",
        line: 12,
        start_line: 10,
        side: "RIGHT",
        start_side: "RIGHT",
        body: "range comment",
      },
    ]);
  });

  it("keeps canonical paths under a/ and b/ directories", () => {
    expect(
      expandMultiLineComments([
        c({ filePath: "a/real.ts", lineNumber: 5, body: "x" }),
      ])[0].path,
    ).toBe("a/real.ts");
    expect(
      expandMultiLineComments([
        c({ filePath: "b/real.ts", lineNumber: 5, body: "x" }),
      ])[0].path,
    ).toBe("b/real.ts");
  });

  it("skips resolved comments", () => {
    const out = expandMultiLineComments([
      c({ filePath: "a/x.ts", lineNumber: 1, body: "open", status: "open" }),
      c({
        filePath: "a/x.ts",
        lineNumber: 2,
        body: "resolved",
        status: "resolved",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(1);
  });

  it("skips file-level comments (lineNumber === 0)", () => {
    const out = expandMultiLineComments([
      c({ filePath: "a/x.ts", lineNumber: 0, body: "file-level" }),
    ]);
    expect(out).toEqual([]);
  });
});

describe("classifyPrComments", () => {
  it("splits inline, file-level, and resolved comments", () => {
    const classified = classifyPrComments([
      c({ filePath: "a/x.ts", lineNumber: 4, body: "inline" }),
      c({ filePath: "a/x.ts", lineNumber: 0, body: "file-level" }),
      c({
        filePath: "a/x.ts",
        lineNumber: 8,
        body: "resolved",
        status: "resolved",
      }),
    ]);
    expect(classified.inline.map((comment) => comment.body)).toEqual([
      "inline",
    ]);
    expect(classified.fileLevel.map((comment) => comment.body)).toEqual([
      "file-level",
    ]);
    expect(classified.excluded.map((comment) => comment.body)).toEqual([
      "resolved",
    ]);
  });
});

describe("buildReviewPayload", () => {
  it("empty review body, no comments → empty comments, COMMENT event", () => {
    const payload = buildReviewPayload({ decision: "comment" });
    expect(payload).toEqual({
      body: undefined,
      event: "COMMENT",
      comments: [],
    });
  });

  it("draft omits event so GitHub creates a PENDING review", () => {
    const payload = buildReviewPayload({
      decision: "draft",
      body: "WIP notes",
      comments: [c({ filePath: "a/x.ts", lineNumber: 1, body: "nit" })],
    });
    expect(payload.event).toBeUndefined();
    expect(payload.body).toBe("WIP notes");
    expect(payload.comments).toHaveLength(1);
    expect("event" in payload).toBe(false);
  });

  it("with a body and no comments → COMMENT event with body", () => {
    const payload = buildReviewPayload({
      decision: "comment",
      body: "Looks fine overall",
    });
    expect(payload).toEqual({
      body: "Looks fine overall",
      event: "COMMENT",
      comments: [],
    });
  });

  it("approve with comments → APPROVE event", () => {
    const payload = buildReviewPayload({
      decision: "approve",
      comments: [c({ filePath: "x.ts", lineNumber: 1, body: "nit" })],
    });
    expect(payload.event).toBe("APPROVE");
    expect(payload.comments).toEqual([
      { path: "x.ts", line: 1, side: "RIGHT", body: "nit" },
    ]);
  });

  it("multi-line comment + folds file-level into the review body", () => {
    const payload = buildReviewPayload({
      decision: "request-changes",
      body: "Please address the range",
      comments: [
        c({ filePath: "src/x.ts", lineNumber: 5, body: "single" }),
        c({
          filePath: "src/y.ts",
          lineNumber: 12,
          startLineNumber: 10,
          body: "range",
        }),
        c({ filePath: "z.ts", lineNumber: 0, body: "file-level note" }),
      ],
    });
    expect(payload.event).toBe("REQUEST_CHANGES");
    expect(payload.comments).toEqual([
      { path: "src/x.ts", line: 5, side: "RIGHT", body: "single" },
      {
        path: "src/y.ts",
        line: 12,
        start_line: 10,
        side: "RIGHT",
        start_side: "RIGHT",
        body: "range",
      },
    ]);
    expect(payload.body).toContain("Please address the range");
    expect(payload.body).toContain("### File comments");
    expect(payload.body).toContain("z.ts");
    expect(payload.body).toContain("file-level note");
  });

  it("includes commit_id when a reviewed head SHA is provided", () => {
    const payload = buildReviewPayload({
      decision: "comment",
      body: "looks good",
      commitId: "abc123def",
    });
    expect(payload.commit_id).toBe("abc123def");
  });

  it("NEVER includes existingComments in the payload (read-only context only)", () => {
    // The payload only reads from `comments`; the read-only `existingComments`
    // array from the PrSession is structurally separate and never reaches the
    // POST. This test enforces that contract at the unit level.
    const payload = buildReviewPayload({
      decision: "comment",
      comments: [],
      // @ts-expect-error — `existingComments` is on PrSession, not on SubmitInput
      existingComments: [{ id: 1, body: "should be ignored" }],
    });
    expect(payload.comments).toEqual([]);
  });
});

describe("parsePrRef", () => {
  const cwdRepo = { owner: "acme", repo: "widget" };
  const ghesCwd = { owner: "acme", repo: "widget", host: "ghe.example.com" };

  it("parses a full URL", () => {
    expect(parsePrRef("https://github.com/foo/bar/pull/42", cwdRepo)).toEqual({
      host: "github.com",
      owner: "foo",
      repo: "bar",
      pullNumber: 42,
      ref: "https://github.com/foo/bar/pull/42",
    });
  });

  it("parses a GitHub Enterprise PR URL", () => {
    expect(parsePrRef("https://ghe.example.com/foo/bar/pull/99")).toEqual({
      host: "ghe.example.com",
      owner: "foo",
      repo: "bar",
      pullNumber: 99,
      ref: "https://ghe.example.com/foo/bar/pull/99",
    });
  });

  it("parses owner/repo#N shorthand", () => {
    expect(parsePrRef("foo/bar#42", cwdRepo)).toEqual({
      owner: "foo",
      repo: "bar",
      pullNumber: 42,
      ref: "foo/bar#42",
      host: undefined,
    });
  });

  it("inherits GHES host for owner/repo#N from cwd", () => {
    expect(parsePrRef("foo/bar#42", ghesCwd)).toEqual({
      owner: "foo",
      repo: "bar",
      pullNumber: 42,
      ref: "foo/bar#42",
      host: "ghe.example.com",
    });
  });

  it("resolves a bare number against the cwd repo", () => {
    expect(parsePrRef("42", cwdRepo)).toEqual({
      owner: "acme",
      repo: "widget",
      pullNumber: 42,
      ref: "42",
      host: undefined,
    });
  });

  it("resolves a bare number against a GHES cwd repo", () => {
    expect(parsePrRef("584", ghesCwd)).toEqual({
      owner: "acme",
      repo: "widget",
      pullNumber: 584,
      ref: "584",
      host: "ghe.example.com",
    });
  });

  it("throws on a bare number without a cwd repo", () => {
    expect(() => parsePrRef("42")).toThrow(/run from inside the target repo/);
  });

  it("throws on garbage input", () => {
    expect(() => parsePrRef("not-a-pr", cwdRepo)).toThrow(
      /Unrecognised PR ref/,
    );
  });

  it("trims whitespace", () => {
    expect(parsePrRef("  7  ", cwdRepo)).toEqual({
      owner: "acme",
      repo: "widget",
      pullNumber: 7,
      ref: "7",
      host: undefined,
    });
  });
});

describe("parseGitRemoteUrl", () => {
  it("parses github.com HTTPS remotes", () => {
    expect(parseGitRemoteUrl("https://github.com/acme/widget.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "widget",
    });
  });

  it("parses github.com SSH scp-like remotes", () => {
    expect(parseGitRemoteUrl("git@github.com:acme/widget.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "widget",
    });
  });

  it("parses GHES HTTPS remotes", () => {
    expect(
      parseGitRemoteUrl("https://ghe.example.com/acme/widget.git"),
    ).toEqual({
      host: "ghe.example.com",
      owner: "acme",
      repo: "widget",
    });
  });

  it("parses GHES SSH remotes", () => {
    expect(parseGitRemoteUrl("git@github.foodics.com:foodics/pay.git")).toEqual(
      {
        host: "github.foodics.com",
        owner: "foodics",
        repo: "pay",
      },
    );
  });

  it("parses ssh:// GHES remotes", () => {
    expect(
      parseGitRemoteUrl("ssh://git@ghe.example.com/acme/widget.git"),
    ).toEqual({
      host: "ghe.example.com",
      owner: "acme",
      repo: "widget",
    });
  });

  it("preserves non-default ports on HTTPS remotes", () => {
    expect(parseGitRemoteUrl("https://ghe.local:8443/acme/widget.git")).toEqual(
      {
        host: "ghe.local:8443",
        owner: "acme",
        repo: "widget",
      },
    );
  });

  it("returns null for empty input", () => {
    expect(parseGitRemoteUrl("")).toBeNull();
  });
});

describe("ghRepoSelector / githubApiBase", () => {
  it("uses OWNER/REPO on github.com", () => {
    expect(ghRepoSelector({ owner: "a", repo: "b" })).toBe("a/b");
    expect(ghRepoSelector({ owner: "a", repo: "b", host: "github.com" })).toBe(
      "a/b",
    );
  });

  it("uses HOST/OWNER/REPO on GHES", () => {
    expect(
      ghRepoSelector({ owner: "a", repo: "b", host: "ghe.example.com" }),
    ).toBe("ghe.example.com/a/b");
  });

  it("uses api.github.com for github.com token calls", () => {
    expect(githubApiBase()).toBe("https://api.github.com");
    expect(githubApiBase("github.com")).toBe("https://api.github.com");
  });

  it("uses /api/v3 on GHES for token calls", () => {
    expect(githubApiBase("ghe.example.com")).toBe(
      "https://ghe.example.com/api/v3",
    );
  });
});
