import { describe, expect, it, vi } from "vitest";
import {
  AiSnapshotError,
  ReviewSnapshot,
  sourceHash,
  type SnapshotIdentity,
  type SnapshotSourceInput,
} from "../snapshots.js";
import { parseHistory, sourceHistory } from "../history.js";
import { sourceDiscussion } from "../discussion.js";
import type { ReviewComment } from "../../types.js";

const FIELD = "\u001f";
const RECORD = "\u001e";

const identity: SnapshotIdentity = {
  kind: "plan",
  planId: "p",
  version: 1,
  bodyHash: sourceHash("body"),
  titleHash: sourceHash("P"),
};

function source(
  overrides: Partial<SnapshotSourceInput> = {},
): SnapshotSourceInput {
  return {
    key: "a.ts",
    path: "src/a.ts",
    side: "new",
    revision: "v1",
    content: "one\ntwo\n",
    complete: true,
    provenance: "recorded",
    representation: "original",
    ...overrides,
  };
}

const snapshotOf = (...inputs: SnapshotSourceInput[]) =>
  new ReviewSnapshot(identity, inputs.length ? inputs : [source()]);

async function expectCode(work: Promise<unknown>, code: string) {
  await expect(work).rejects.toMatchObject({ code });
}

function expectSyncCode(fn: () => unknown, code: AiSnapshotError["code"]): void {
  try {
    fn();
    throw new Error("expected snapshot error");
  } catch (error) {
    expect(error).toBeInstanceOf(AiSnapshotError);
    expect((error as AiSnapshotError).code).toBe(code);
  }
}

const commit = (sha: string, subject: string) =>
  ["a".repeat(40 - sha.length) + sha, sha, "Dev", "2026-01-01T00:00:00Z", subject].join(
    FIELD,
  ) + RECORD;

describe("sourceHistory", () => {
  it("lists commits for a captured source", async () => {
    const runner = vi.fn(async () => commit("abc1234", "first") + commit("def5678", "second"));
    const result = await sourceHistory(
      snapshotOf(),
      "/repo",
      { key: "a.ts" },
      runner,
    );
    expect(result.path).toBe("src/a.ts");
    expect(result.commits.map((entry) => entry.subject)).toEqual([
      "first",
      "second",
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it("addresses the source by key and passes the captured path after --", async () => {
    const runner = vi.fn(async (_args: string[]) => "");
    await sourceHistory(snapshotOf(), "/repo", { key: "a.ts" }, runner);
    const args = runner.mock.calls[0]![0];
    expect(args).toContain("--end-of-options");
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("src/a.ts");
    // History must never return patch content.
    expect(args).toContain("--no-patch");
  });

  it("pages by commit offset", async () => {
    const runner = vi.fn(
      async () => commit("aaa1111", "one") + commit("bbb2222", "two"),
    );
    const result = await sourceHistory(
      snapshotOf(),
      "/repo",
      { key: "a.ts", limit: 1 },
      runner,
    );
    expect(result.commits).toHaveLength(1);
    expect(result.nextCursor).toBe("o:1");
  });

  it("rejects an unknown key as missing", async () =>
    await expectCode(
      sourceHistory(snapshotOf(), "/repo", { key: "nope" }, async () => ""),
      "missing",
    ));

  it.each([0, 51, 1.5])("rejects out-of-range limit %j", async (limit) =>
    await expectCode(
      sourceHistory(snapshotOf(), "/repo", { key: "a.ts", limit }, async () => ""),
      "invalid",
    ));

  it("rejects a malformed cursor", async () =>
    await expectCode(
      sourceHistory(
        snapshotOf(),
        "/repo",
        { key: "a.ts", cursor: "nope" },
        async () => "",
      ),
      "invalid",
    ));

  it("reports a failing git invocation as missing, without its diagnostics", async () => {
    const runner = vi.fn(async () => {
      throw new Error("fatal: sensitive path detail");
    });
    const error = await sourceHistory(
      snapshotOf(),
      "/repo",
      { key: "a.ts" },
      runner,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AiSnapshotError);
    expect((error as Error).message).not.toContain("sensitive");
  });

  it("rejects an unparsable record rather than inventing a commit", () =>
    expectSyncCode(() => parseHistory(`not-a-sha${FIELD}x${FIELD}y${FIELD}z${RECORD}`), "invalid"));

  it("keeps a subject containing the field separator intact", () => {
    const parsed = parseHistory(
      ["b".repeat(40), "bbbbbbb", "Dev", "2026-01-01T00:00:00Z", `a${FIELD}b`].join(
        FIELD,
      ) + RECORD,
    );
    expect(parsed[0].subject).toBe(`a${FIELD}b`);
  });
});

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1",
    filePath: "src/a.ts",
    side: "additions",
    lineNumber: 1,
    lineContent: "one",
    body: "looks wrong",
    status: "open",
    createdAt: 1,
    replies: [],
    ...overrides,
  };
}

describe("sourceDiscussion", () => {
  it("returns threads anchored to captured paths", () => {
    const result = sourceDiscussion(snapshotOf(), [comment()]);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({
      key: "a.ts",
      path: "src/a.ts",
      body: "looks wrong",
      status: "open",
    });
    expect(result.outOfScope).toBe(0);
  });

  it("counts but does not return threads outside the capture", () => {
    const result = sourceDiscussion(snapshotOf(), [
      comment(),
      comment({ id: "c2", filePath: "src/elsewhere.ts" }),
    ]);
    expect(result.threads).toHaveLength(1);
    expect(result.outOfScope).toBe(1);
    expect(JSON.stringify(result)).not.toContain("elsewhere");
  });

  it("scopes to one source and rejects an unknown key", () => {
    const snapshot = snapshotOf(
      source({ key: "a.ts", path: "src/a.ts" }),
      source({ key: "b.ts", path: "src/b.ts" }),
    );
    const comments = [comment(), comment({ id: "c2", filePath: "src/b.ts" })];
    expect(
      sourceDiscussion(snapshot, comments, { key: "b.ts" }).threads,
    ).toHaveLength(1);
    expectSyncCode(
      () => sourceDiscussion(snapshot, comments, { key: "nope" }),
      "missing",
    );
  });

  it("includes replies and carries triage fields through", () => {
    const result = sourceDiscussion(snapshotOf(), [
      comment({
        severity: "blocking",
        outdated: true,
        replies: [{ id: "r1", body: "agreed", createdAt: 2 }],
      }),
    ]);
    expect(result.threads[0]).toMatchObject({
      severity: "blocking",
      outdated: true,
    });
    expect(result.threads[0].replies[0]).toMatchObject({ body: "agreed" });
  });

  it("truncates an oversized body and says so", () => {
    const result = sourceDiscussion(snapshotOf(), [
      comment({ body: "x".repeat(8192) }),
    ]);
    expect(result.threads[0].truncated).toBe(true);
    expect(Buffer.byteLength(result.threads[0].body, "utf8")).toBeLessThanOrEqual(
      4096,
    );
  });

  it("pages threads with a cursor", () => {
    const comments = [
      comment({ id: "c1" }),
      comment({ id: "c2" }),
      comment({ id: "c3" }),
    ];
    const first = sourceDiscussion(snapshotOf(), comments, { limit: 2 });
    expect(first.threads).toHaveLength(2);
    expect(first.nextCursor).toBe("o:2");
    const second = sourceDiscussion(snapshotOf(), comments, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.threads).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it.each([0, 51, 1.5])("rejects out-of-range limit %j", (limit) =>
    expectSyncCode(
      () => sourceDiscussion(snapshotOf(), [], { limit }),
      "invalid",
    ),
  );

  it("rejects a malformed cursor", () =>
    expectSyncCode(
      () => sourceDiscussion(snapshotOf(), [], { cursor: "nope" }),
      "invalid",
    ));
});
