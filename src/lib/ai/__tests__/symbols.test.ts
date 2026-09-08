// @vitest-environment node
// The child-process seam is mocked so a synthetic node child stands in for a
// language server; no real language server is ever executed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../child-process.js", () => ({ spawn: mocks.spawn }));

import { spawn as realSpawn } from "node:child_process";
import { LanguageServers } from "../language-servers.js";
import {
  ReviewSnapshot,
  sourceHash,
  type SnapshotIdentity,
  type SnapshotSourceInput,
} from "../snapshots.js";
import { lookupSymbols } from "../symbols.js";

const ROOT = "/repo";

/** Answers initialize, then returns one location at the configured uri. */
const server = (targetUri: string) => `
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
};
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const split = buffer.indexOf('\\r\\n\\r\\n');
    if (split === -1) return;
    const length = Number(/content-length:\\s*(\\d+)/i.exec(buffer.slice(0, split).toString())[1]);
    const start = split + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.slice(start, start + length).toString());
    buffer = buffer.slice(start + length);
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    } else if (message.method && message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, result: [
        { uri: ${JSON.stringify(targetUri)}, range: { start: { line: 6, character: 1 }, end: { line: 6, character: 9 } } }
      ] });
    }
  }
});
`;

function useServer(targetUri: string) {
  mocks.spawn.mockImplementation(() =>
    realSpawn(process.execPath, ["-e", server(targetUri)], {
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}

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
    content: "one\ntwo\nthree\nfour\nfive\nsix\nseven\n",
    complete: true,
    provenance: "recorded",
    representation: "original",
    ...overrides,
  };
}

const snapshotOf = (...inputs: SnapshotSourceInput[]) =>
  new ReviewSnapshot(identity, inputs.length ? inputs : [source()]);

const configured = () =>
  new LanguageServers({ ts: { command: "synthetic-lsp", args: [] } }, ROOT);

async function expectCode(work: Promise<unknown>, code: string) {
  await expect(work).rejects.toMatchObject({ code });
}

beforeEach(() => mocks.spawn.mockReset());

describe("lookupSymbols", () => {
  it("resolves a location that falls inside the capture", async () => {
    useServer("file:///repo/src/a.ts");
    const servers = configured();
    try {
      const result = await lookupSymbols(snapshotOf(), servers, ROOT, {
        key: "a.ts",
        line: 2,
        character: 0,
        kind: "definitions",
      });
      expect(result.kind).toBe("definitions");
      expect(result.locations).toEqual([
        {
          key: "a.ts",
          path: "src/a.ts",
          startLine: 7,
          endLine: 7,
          inScope: true,
        },
      ]);
      expect(result.outOfScope).toBe(0);
      expect(result.unavailable).toBeUndefined();
    } finally {
      await servers.close();
    }
  });

  it("round-trips a path that needs percent-encoding", async () => {
    // The outgoing uri is encoded and the returned one decoded; a space must
    // survive both directions and still resolve inside the capture.
    useServer("file:///repo/src/my%20dir/a.ts");
    const servers = configured();
    try {
      const result = await lookupSymbols(
        snapshotOf(source({ key: "a.ts", path: "src/my dir/a.ts" })),
        servers,
        ROOT,
        { key: "a.ts", line: 1, character: 0, kind: "definitions" },
      );
      expect(result.locations[0]).toMatchObject({
        key: "a.ts",
        path: "src/my dir/a.ts",
        inScope: true,
      });
    } finally {
      await servers.close();
    }
  });

  it("names a location outside the capture without making it readable", async () => {
    useServer("file:///repo/src/elsewhere.ts");
    const servers = configured();
    try {
      const result = await lookupSymbols(snapshotOf(), servers, ROOT, {
        key: "a.ts",
        line: 2,
        character: 0,
        kind: "references",
      });
      expect(result.locations[0]).toMatchObject({ key: null, inScope: false });
      expect(result.outOfScope).toBe(1);
    } finally {
      await servers.close();
    }
  });

  it("refuses a location that escapes the repository root", async () => {
    useServer("file:///etc/passwd");
    const servers = configured();
    try {
      const result = await lookupSymbols(snapshotOf(), servers, ROOT, {
        key: "a.ts",
        line: 2,
        character: 0,
        kind: "definitions",
      });
      expect(result.locations[0]).toMatchObject({ key: null, inScope: false });
      expect(result.outOfScope).toBe(1);
    } finally {
      await servers.close();
    }
  });

  it("reports unavailable rather than an empty result when nothing is configured", async () => {
    const servers = new LanguageServers({}, ROOT);
    const result = await lookupSymbols(snapshotOf(), servers, ROOT, {
      key: "a.ts",
      line: 2,
      character: 0,
      kind: "definitions",
    });
    expect(result.locations).toEqual([]);
    expect(result.unavailable).toBeTruthy();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("reports unavailable for an extension with no configured server", async () => {
    const servers = new LanguageServers(
      { rs: { command: "synthetic-lsp" } },
      ROOT,
    );
    const result = await lookupSymbols(
      snapshotOf(source({ key: "a.ts", path: "src/a.ts" })),
      servers,
      ROOT,
      { key: "a.ts", line: 1, character: 0, kind: "definitions" },
    );
    expect(result.unavailable).toBeTruthy();
  });

  it("rejects an unknown source key", async () => {
    const servers = configured();
    await expectCode(
      lookupSymbols(snapshotOf(), servers, ROOT, {
        key: "nope",
        line: 1,
        character: 0,
        kind: "definitions",
      }),
      "missing",
    );
    await servers.close();
  });

  it("refuses a patch source, whose offsets are not file positions", async () => {
    const servers = configured();
    await expectCode(
      lookupSymbols(
        snapshotOf(source({ key: "p", representation: "unified-patch" })),
        servers,
        ROOT,
        { key: "p", line: 1, character: 0, kind: "definitions" },
      ),
      "unsupported",
    );
    await servers.close();
  });

  it.each([
    ["a line past the source", { line: 999, character: 0 }],
    ["a zero line", { line: 0, character: 0 }],
    ["a negative character", { line: 1, character: -1 }],
  ])("rejects %s", async (_label, position) => {
    const servers = configured();
    await expectCode(
      lookupSymbols(snapshotOf(), servers, ROOT, {
        key: "a.ts",
        kind: "definitions",
        ...position,
      }),
      "invalid",
    );
    await servers.close();
  });

  it("rejects an unknown kind", async () => {
    const servers = configured();
    await expectCode(
      lookupSymbols(snapshotOf(), servers, ROOT, {
        key: "a.ts",
        line: 1,
        character: 0,
        kind: "everything" as never,
      }),
      "invalid",
    );
    await servers.close();
  });
});

describe("LanguageServers", () => {
  it("starts one server per command and reuses it", async () => {
    useServer("file:///repo/src/a.ts");
    const servers = configured();
    try {
      await servers.sessionFor("src/a.ts");
      await servers.sessionFor("src/b.ts");
      expect(mocks.spawn).toHaveBeenCalledOnce();
    } finally {
      await servers.close();
    }
  });

  it("reports whether anything is configured at all", () => {
    expect(new LanguageServers({}, ROOT).configured).toBe(false);
    expect(configured().configured).toBe(true);
    expect(configured().supports("src/a.ts")).toBe(true);
    expect(configured().supports("src/a.rs")).toBe(false);
    expect(configured().supports("Makefile")).toBe(false);
  });

  it("does not retain a server that failed to start", async () => {
    mocks.spawn.mockImplementation(() =>
      realSpawn(process.execPath, ["-e", "process.exit(1)"], {
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    const servers = configured();
    await expect(servers.sessionFor("src/a.ts")).rejects.toBeDefined();
    await expect(servers.sessionFor("src/a.ts")).rejects.toBeDefined();
    // A retained failure would have spawned only once.
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    await servers.close();
  });

  it("refuses lookups after close", async () => {
    const servers = configured();
    await servers.close();
    await expect(servers.sessionFor("src/a.ts")).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
