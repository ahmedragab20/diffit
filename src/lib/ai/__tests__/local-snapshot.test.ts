// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as {
    file: string;
    args: string[];
    options: Record<string, unknown>;
  }[],
  index: "100644 a\0",
  head: "a".repeat(40),
  headMissing: false,
  refs: new Map<string, string>(),
  mergeBase: "b".repeat(40),
  patch: "patch",
  complete: true,
  omittedPaths: [] as string[],
}));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, {
    value: async (
      file: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      // Never retain the inherited environment in assertion output.
      const env = options.env as Record<string, unknown>;
      state.calls.push({
        file,
        args: [...args],
        options: {
          encoding: options.encoding,
          maxBuffer: options.maxBuffer,
          timeout: options.timeout,
          shell: options.shell,
          env: {
            GIT_NO_LAZY_FETCH: env.GIT_NO_LAZY_FETCH,
            GIT_TERMINAL_PROMPT: env.GIT_TERMINAL_PROMPT,
          },
        },
      });
      const command = args.slice(5);
      if (command[0] === "rev-parse" && command[1] === "--show-toplevel")
        return { stdout: "/repo\n", stderr: "" };
      if (command[0] === "rev-parse") {
        const ref = command.at(-1)!.replace(/\^\{commit\}$/, "");
        if (ref === "HEAD" && state.headMissing) throw new Error("unborn");
        const sha = ref === "HEAD" ? state.head : state.refs.get(ref);
        if (!sha) throw new Error("unknown ref");
        return { stdout: `${sha}\n`, stderr: "" };
      }
      if (
        command[0] === "ls-files" &&
        command[1] === "--stage" &&
        command[2] === "-z"
      )
        return { stdout: state.index, stderr: "" };
      if (command[0] === "merge-base" && command[1] === "--all")
        return { stdout: `${state.mergeBase}\n`, stderr: "" };
      throw new Error(`unknown git command: ${command.join(" ")}`);
    },
  });
  return { execFile, default: { execFile } };
});

import { captureLocalReview } from "../local-snapshot.js";
import { DEFAULTS, type DiffOptions } from "../../diff-options.js";
import { AiSnapshotError, sourceHash } from "../snapshots.js";

const opts = (overrides: Partial<DiffOptions> = {}): DiffOptions => ({
  ...structuredClone(DEFAULTS),
  ...overrides,
  revisions: [...(overrides.revisions ?? [])],
  pathspecs: [...(overrides.pathspecs ?? [])],
});
const expectCode = async (
  fn: () => Promise<unknown>,
  code: AiSnapshotError["code"],
) => {
  try {
    await fn();
    throw new Error("expected error");
  } catch (e) {
    expect(e).toBeInstanceOf(AiSnapshotError);
    expect((e as AiSnapshotError).code).toBe(code);
  }
};
const reset = () => {
  state.calls.length = 0;
  state.index = "100644 a\0";
  state.head = "a".repeat(40);
  state.headMissing = false;
  state.refs = new Map();
  state.mergeBase = "b".repeat(40);
  state.patch = "patch";
  state.complete = true;
  state.omittedPaths = [];
};

beforeEach(reset);

describe("captureLocalReview", () => {
  it("pins identities and exact revisions for working, staged, refs, and triple-dot", async () => {
    const read = vi.fn(async (o: DiffOptions) => ({
      patch: state.patch,
      complete: state.complete,
      omittedPaths: state.omittedPaths,
      seen: o,
    }));
    expect(
      (await captureLocalReview("/repo", opts(), read)).identity,
    ).toMatchObject({
      mode: "working",
      indexHash: sourceHash(state.index),
      patchHash: sourceHash("patch"),
      headSha: null,
      baseSha: null,
    });
    expect(
      (await captureLocalReview("/repo", opts({ staged: true }), read)).identity
        .mode,
    ).toBe("mixed");
    expect(
      (
        await captureLocalReview(
          "/repo",
          opts({ staged: true, pathspecs: ["x.ts"] }),
          read,
        )
      ).identity.mode,
    ).toBe("staged");
    state.refs.set("A", "c".repeat(40));
    state.refs.set("B", "d".repeat(40));
    expect(
      (await captureLocalReview("/repo", opts({ revisions: ["A", "B"] }), read))
        .identity,
    ).toMatchObject({
      mode: "revision",
      baseSha: "c".repeat(40),
      headSha: "d".repeat(40),
    });
    expect(
      (await captureLocalReview("/repo", opts({ revisions: ["A...B"] }), read))
        .identity,
    ).toMatchObject({ baseSha: state.mergeBase, headSha: "d".repeat(40) });
  });
  it("uses bounded read-only subprocess options and frozen callback clones", async () => {
    const caller = opts({ pathspecs: ["a.ts"] });
    const callbackOptions: DiffOptions[] = [];
    const read = vi.fn(async (o: DiffOptions) => {
      callbackOptions.push(o);
      o.pathspecs.push("callback-mutation");
      return { patch: state.patch, complete: true };
    });
    const captured = await captureLocalReview("/repo", caller, read);
    expect(captured.identity.mode).toBe("working");
    expect(caller.pathspecs).toEqual(["a.ts"]);
    expect(callbackOptions[0]).not.toBe(caller);
    expect(callbackOptions[0]?.pathspecs).toEqual([
      "a.ts",
      "callback-mutation",
    ]);
    const before = JSON.stringify(captured.identity);
    await captured.assertFresh();
    expect(JSON.stringify(captured.identity)).toBe(before);
    expect(callbackOptions.at(-1)).not.toBe(callbackOptions[0]);
    expect(callbackOptions.at(-1)?.pathspecs).toEqual([
      "a.ts",
      "callback-mutation",
    ]);
    for (const call of state.calls) {
      expect(call.file).toBe("git");
      expect(call.args[0]).toBe("--no-optional-locks");
      expect(call.args).toContain("-c");
      expect(call.args).toContain("core.fsmonitor=false");
      expect(call.args[1]).toBe("-c");
      expect(call.args[3]).toBe("-C");
      expect(call.options).toMatchObject({
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000,
      });
      expect(call.options.shell).not.toBe(true);
      expect(call.options.env as Record<string, string>).toMatchObject({
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
      });
    }
    caller.pathspecs.push("caller-mutated");
    await captured.assertFresh();
    expect(callbackOptions.at(-1)?.pathspecs).toEqual([
      "a.ts",
      "callback-mutation",
    ]);
  });
  it("rejects unsupported modes and unknown refs, and labels unavailable HEAD", async () => {
    const read = vi.fn(async () => ({ patch: "p", complete: true }));
    for (const bad of [
      { showMode: true },
      { revisions: ["A", "B", "C"] },
      { extDiff: "x" },
      { textconv: true },
      { outputFile: "x" },
      { outputFormat: "stat" as const },
    ]) {
      read.mockClear();
      await expectCode(
        () => captureLocalReview("/repo", opts(bad), read),
        "unsupported",
      );
      expect(read).not.toHaveBeenCalled();
    }
    await expectCode(
      () => captureLocalReview("/repo", opts({ revisions: ["UNKNOWN"] }), read),
      "missing",
    );
    state.headMissing = true;
    const result = await captureLocalReview("/repo", opts(), read);
    expect(result.identity.repositoryHeadSha).toBeNull();
    expect(result.omissions.join(" ")).toContain(
      "Repository HEAD could not be established",
    );
  });
  it("rejects every independent freshness mutation and capture-time drift", async () => {
    for (const scenario of [
      {
        options: opts(),
        mutate: () => {
          state.index = "changed\0";
        },
      },
      {
        options: opts(),
        mutate: () => {
          state.head = "e".repeat(40);
        },
      },
      {
        options: opts({ revisions: ["A"] }),
        setup: () => {
          state.refs.set("A", "c".repeat(40));
        },
        mutate: () => {
          state.refs.set("A", "f".repeat(40));
        },
      },
      {
        options: opts(),
        mutate: () => {
          state.patch = "changed";
        },
      },
      {
        options: opts(),
        mutate: () => {
          state.complete = false;
        },
      },
      {
        options: opts(),
        mutate: () => {
          state.omittedPaths = ["gone.ts"];
        },
      },
    ]) {
      reset();
      scenario.setup?.();
      const read = vi.fn(async () => ({
        patch: state.patch,
        complete: state.complete,
        omittedPaths: [...state.omittedPaths],
      }));
      const captured = await captureLocalReview(
        "/repo",
        scenario.options,
        read,
      );
      scenario.mutate();
      await expectCode(() => captured.assertFresh(), "stale");
    }
    reset();
    const driftRead = vi.fn(async () => {
      state.index = "drift\0";
      return { patch: "patch", complete: true };
    });
    await expectCode(
      () => captureLocalReview("/repo", opts(), driftRead),
      "stale",
    );
    reset();
    const tooLarge = vi.fn(async () => ({
      patch: "x".repeat(4 * 1024 * 1024 + 1),
      complete: true,
    }));
    await expectCode(
      () => captureLocalReview("/repo", opts(), tooLarge),
      "limit",
    );
  });
});
