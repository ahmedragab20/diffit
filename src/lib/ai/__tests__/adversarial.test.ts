// @vitest-environment node
// Adversarial properties of the AI evidence surface: scope and egress
// enforcement, secret-safe diagnostics, and read-only tool authority. These
// assert invariants rather than one code path, so a future change that widens
// authority has to break a test to land.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AiSnapshotError,
  ReviewSnapshot,
  sourceHash,
  type SnapshotIdentity,
  type SnapshotSourceInput,
} from "../snapshots.js";
import {
  diffRead,
  locateInSnapshot,
  reviewMap,
  sourceRead,
  sourceSearch,
  verifyCitation,
} from "../tools.js";
import { sourceDiscussion } from "../discussion.js";
import { sourceHistory } from "../history.js";
import { LspError } from "../lsp.js";

const root = process.cwd();
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
    content: "alpha\nbravo\n",
    complete: true,
    provenance: "recorded",
    representation: "original",
    ...overrides,
  };
}

const snapshot = () => new ReviewSnapshot(identity, [source()]);

/** A caller-supplied string that must never come back inside an error. */
const SECRET = "sk-live-SHOULD-NEVER-APPEAR";

describe("scope enforcement", () => {
  it("cannot read a source the capture does not hold", () => {
    const batch = sourceRead(snapshot(), [
      { key: SECRET, startLine: 1, endLine: 1 },
    ]);
    expect(batch.items[0]).toMatchObject({ ok: false, error: { code: "missing" } });
  });

  it("cannot reach outside a source's captured line range", () => {
    const batch = sourceRead(snapshot(), [
      { key: "a.ts", startLine: 1, endLine: 9999 },
    ]);
    expect(batch.items[0].ok).toBe(false);
  });

  it.each([
    ["an absolute path outside the repository", "file:///etc/shadow"],
    ["a traversal escape", `file://${process.cwd()}/../../etc/shadow`],
    ["a non-file scheme", "http://169.254.169.254/latest/meta-data"],
    ["an opaque scheme", "untitled:Untitled-1"],
  ])("refuses to make %s readable", (_label, uri) => {
    const [located] = locateInSnapshot(
      snapshot(),
      [{ uri, startLine: 1, endLine: 1 }],
      root,
    );
    expect(located.inScope).toBe(false);
    expect(located.key).toBeNull();
  });

  it("cannot read discussion for a path outside the capture", () => {
    const result = sourceDiscussion(snapshot(), [
      {
        id: "c1",
        filePath: "src/secrets.env",
        side: "additions",
        lineNumber: 1,
        lineContent: SECRET,
        body: SECRET,
        status: "open",
        createdAt: 1,
        replies: [],
      },
    ]);
    expect(result.threads).toEqual([]);
    expect(result.outOfScope).toBe(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("cannot ask for history of a path it was not given", async () => {
    await expect(
      sourceHistory(snapshot(), root, { key: SECRET }, async () => ""),
    ).rejects.toMatchObject({ code: "missing" });
  });

  it("never passes a caller string to git as a path", async () => {
    let seen: string[] = [];
    await sourceHistory(
      snapshot(),
      root,
      { key: "a.ts" },
      async (args) => {
        seen = args;
        return "";
      },
    );
    // The path comes from the capture, never from the caller's key.
    expect(seen[seen.length - 1]).toBe("src/a.ts");
    expect(seen.join(" ")).not.toContain(SECRET);
  });
});

describe("secret-safe diagnostics", () => {
  const messages = (
    ["invalid", "missing", "stale", "limit", "unsupported"] as const
  ).map((code) => new AiSnapshotError(code).message);

  it("draws every snapshot error message from a fixed set", () => {
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) expect(message).not.toContain(SECRET);
  });

  it("never echoes a caller key into a read error", () => {
    const batch = sourceRead(snapshot(), [
      { key: SECRET, startLine: 1, endLine: 1 },
    ]);
    expect(JSON.stringify(batch)).not.toContain(SECRET);
  });

  it("never echoes a caller query into a search error", () => {
    try {
      sourceSearch(snapshot(), "", { key: SECRET });
      throw new Error("expected a snapshot error");
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it("never echoes a caller cursor into a map error", () => {
    try {
      reviewMap(snapshot(), { cursor: SECRET });
      throw new Error("expected a snapshot error");
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it("reports a failing git invocation without its diagnostics", async () => {
    const error = await sourceHistory(
      snapshot(),
      root,
      { key: "a.ts" },
      async () => {
        throw new Error(`fatal: could not read ${SECRET}`);
      },
    ).catch((reason: unknown) => reason);
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("draws every language-server error message from a fixed set", () => {
    for (const code of [
      "unavailable",
      "protocol_error",
      "timeout",
      "resource_limit",
    ] as const)
      expect(new LspError(code).message).not.toContain(SECRET);
  });
});

describe("read-only authority", () => {
  const evidenceModules = [
    "tools.ts",
    "discussion.ts",
    "snapshot-store.ts",
    "symbols.ts",
  ];

  it.each(evidenceModules)(
    "%s performs no network or filesystem access of its own",
    (file) => {
      const text = readFileSync(join(root, "src/lib/ai", file), "utf-8");
      for (const forbidden of [
        "node:fs",
        "node:child_process",
        "node:net",
        "node:http",
        "fetch(",
        "spawn(",
        "execFile",
      ])
        expect(text, `${file} must not reference ${forbidden}`).not.toContain(
          forbidden,
        );
    },
  );

  it("reads history only through git log with no patch output", () => {
    const text = readFileSync(join(root, "src/lib/ai/history.ts"), "utf-8");
    expect(text).toContain('"--no-patch"');
    expect(text).toContain('"--end-of-options"');
    // A shell would reintroduce injection; execFile takes an argv instead.
    expect(text).toContain('import { execFile } from "node:child_process"');
    expect(text).not.toContain("shell: true");
    expect(text).not.toMatch(/\bexecSync\b/);
    expect(text).not.toMatch(/\bspawnSync\b/);
  });

  it("keeps the evidence namespace strictly read-only", () => {
    const text = readFileSync(join(root, "src/mcp.ts"), "utf-8");
    const blocks = text.split("server.registerTool(").slice(1);
    const evidence = blocks.filter((block) =>
      /^\s*"ai_evidence_/.test(block),
    );
    expect(evidence.length).toBeGreaterThanOrEqual(8);
    for (const block of evidence) {
      const name = /"(ai_evidence_[a-z_]+)"/.exec(block)?.[1];
      // A writing tool must not borrow the read-only namespace.
      expect(block, `${name} must be read-only`).toContain(
        "annotations: READ_ONLY",
      );
    }
  });

  it("marks the notebook writers as non-destructive mutations", () => {
    const text = readFileSync(join(root, "src/mcp.ts"), "utf-8");
    const blocks = text.split("server.registerTool(").slice(1);
    const writers = blocks.filter((block) =>
      /^\s*"ai_notebook_(add|decide)"/.test(block),
    );
    expect(writers).toHaveLength(2);
    for (const block of writers) {
      const name = /"(ai_notebook_[a-z_]+)"/.exec(block)?.[1];
      // Authoring and deciding write, but neither destroys anything.
      expect(block, `${name} must be an idempotent mutation`).toContain(
        "annotations: IDEMPOTENT_MUTATION",
      );
      expect(block, `${name} must not be destructive`).not.toContain(
        "destructiveHint: true",
      );
    }
  });

  it("never grants a language server authority over the client", () => {
    const text = readFileSync(join(root, "src/lib/ai/lsp.ts"), "utf-8");
    // A server request is refused, and no mutating capability is advertised.
    expect(text).toContain("Method not found");
    expect(text).not.toContain("applyEdit");
    expect(text).not.toContain("executeCommand");
    expect(text).not.toContain("workspace/didChange");
  });
});

describe("freshness gates", () => {
  it("refuses a citation held against another generation", () => {
    const snap = snapshot();
    const batch = sourceRead(snap, [{ key: "a.ts", startLine: 1, endLine: 1 }]);
    const [item] = batch.items;
    if (!item.ok) throw new Error("expected a successful read");
    expect(() =>
      verifyCitation(snap, item.value.evidence, "a-different-generation"),
    ).toThrow(expect.objectContaining({ code: "stale" }));
  });

  it("refuses a citation minted against a different capture", () => {
    const mine = snapshot();
    const theirs = snapshot();
    const batch = sourceRead(theirs, [
      { key: "a.ts", startLine: 1, endLine: 1 },
    ]);
    const [item] = batch.items;
    if (!item.ok) throw new Error("expected a successful read");
    expect(() =>
      verifyCitation(mine, item.value.evidence, mine.manifest.revision),
    ).toThrow(expect.objectContaining({ code: "invalid" }));
  });

  it("refuses to read a patch source as original file lines", () => {
    const snap = new ReviewSnapshot(identity, [
      source({ key: "p", representation: "unified-patch" }),
    ]);
    expect(
      sourceRead(snap, [{ key: "p", startLine: 1, endLine: 1 }]).items[0],
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(
      diffRead(snap, [{ key: "p", startLine: 1, endLine: 1 }]).items[0],
    ).toMatchObject({ ok: true });
  });
});

describe("no automatic inference or unauthorized publication", () => {
  const aiSources = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name === "__tests__") continue;
        out.push(...aiSources(path));
      } else if (/\.tsx?$/.test(name)) out.push(path);
    }
    return out;
  };

  const modules = [
    ...aiSources(join(root, "src/lib/ai")),
    ...aiSources(join(root, "src/ui/ai")),
  ];

  it.each([
    "mergePullRequestViaGh",
    "setPrOpenStateViaGh",
    "updatePrMetadataViaGh",
    "applyPrSuggestionViaGh",
    "addCommentsToPendingReviewViaGh",
    "github-pr-actions",
  ])("no AI module reaches %s", (symbol) => {
    // The AI surface must not be able to publish or mutate a pull request,
    // however a run is prompted.
    const offenders = modules.filter((path) =>
      readFileSync(path, "utf-8").includes(symbol),
    );
    expect(offenders.map((path) => path.slice(root.length + 1))).toEqual([]);
  });

  it("starts inference only on an explicit user trigger", () => {
    const triggers = new Set<string>();
    for (const path of modules) {
      for (const match of readFileSync(path, "utf-8").matchAll(
        /trigger:\s*["'`](\w+)["'`]/g,
      ))
        triggers.add(match[1]);
    }
    // A background or automatic trigger would start inference unprompted.
    expect([...triggers]).toEqual(["user"]);
  });

  it("keeps the server-side refusal of a non-user trigger", () => {
    const request = readFileSync(join(root, "src/lib/ai/request.ts"), "utf-8");
    const service = readFileSync(join(root, "src/lib/ai/service.ts"), "utf-8");
    expect(request).toContain('trigger !== "user"');
    expect(service).toContain('trigger !== "user"');
  });
});
