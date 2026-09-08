// @vitest-environment node
// Durability against a real filesystem: each case writes a throwaway journal
// on disk, so recovery and torn-write behaviour is exercised for real rather
// than against an in-memory stand-in.
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AiStorage,
  AiStorageError,
  STORAGE_LIMITS,
  STORAGE_VERSION,
  type AiTurnRecord,
} from "../storage.js";

let dir: string;
const journal = () => join(dir, "ai-turns.jsonl");

function record(overrides: Partial<AiTurnRecord> = {}): AiTurnRecord {
  return {
    id: "t1",
    runId: "r1",
    conversationId: "c1",
    kind: "request",
    createdAt: 1,
    payload: { prompt: "hello" },
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "diffing-ai-storage-"));
});

afterEach(() => {
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Already writable. */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("idempotency", () => {
  it("returns the stored record instead of appending a repeat", async () => {
    const store = new AiStorage(dir);
    const first = await store.append("k1", record());
    const second = await store.append("k1", record({ id: "different" }));
    expect(second).toEqual(first);
    expect(store.list()).toHaveLength(1);
    expect(readFileSync(journal(), "utf-8").trim().split("\n")).toHaveLength(1);
  });

  it("keeps distinct keys distinct", async () => {
    const store = new AiStorage(dir);
    await store.append("k1", record({ id: "a" }));
    await store.append("k2", record({ id: "b" }));
    expect(store.list().map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("survives idempotency across a reload", async () => {
    const first = new AiStorage(dir);
    await first.append("k1", record());
    const reopened = new AiStorage(dir);
    await reopened.append("k1", record({ id: "different" }));
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.list()[0].id).toBe("t1");
  });
});

describe("concurrency", () => {
  it("serializes concurrent appends without interleaving or loss", async () => {
    const store = new AiStorage(dir);
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.append(`k${index}`, record({ id: `t${index}` })),
      ),
    );
    expect(store.list()).toHaveLength(25);
    const lines = readFileSync(journal(), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(25);
    // Every line must be independently parseable: no torn interleaving.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(new AiStorage(dir).load().records).toBe(25);
  });

  it("does not lose later writes when one fails", async () => {
    const store = new AiStorage(dir);
    const results = await Promise.allSettled([
      store.append("ok1", record({ id: "a" })),
      store.append("", record({ id: "bad" })),
      store.append("ok2", record({ id: "b" })),
    ]);
    expect(results[1].status).toBe("rejected");
    expect(store.list().map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("rejects concurrent duplicates of the same key exactly once", async () => {
    const store = new AiStorage(dir);
    const [a, b] = await Promise.all([
      store.append("same", record({ id: "first" })),
      store.append("same", record({ id: "second" })),
    ]);
    expect(a).toEqual(b);
    expect(store.list()).toHaveLength(1);
  });
});

describe("replay and recovery", () => {
  it("rebuilds state from the journal in order", async () => {
    const store = new AiStorage(dir);
    await store.append("k1", record({ id: "a", createdAt: 1 }));
    await store.append("k2", record({ id: "b", createdAt: 2 }));
    const replayed = new AiStorage(dir);
    expect(replayed.load()).toEqual({ records: 2, truncatedAtLine: null });
    expect(replayed.list().map((r) => r.id)).toEqual(["a", "b"]);
    expect(replayed.get("b")?.createdAt).toBe(2);
  });

  it("discards a torn trailing line and keeps everything before it", async () => {
    const store = new AiStorage(dir);
    await store.append("k1", record({ id: "a" }));
    await store.append("k2", record({ id: "b" }));
    const text = readFileSync(journal(), "utf-8");
    // Simulate a crash mid-append: the last line is half written.
    writeFileSync(journal(), `${text}{"v":1,"key":"k3","chec`);
    const recovered = new AiStorage(dir);
    const report = recovered.load();
    expect(report.records).toBe(2);
    expect(report.truncatedAtLine).toBe(3);
    expect(recovered.list().map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("refuses a record whose checksum does not match its payload", async () => {
    const store = new AiStorage(dir);
    await store.append("k1", record({ id: "a" }));
    const line = JSON.parse(readFileSync(journal(), "utf-8").trim());
    line.record.payload = { prompt: "tampered" };
    writeFileSync(journal(), `${JSON.stringify(line)}\n`);
    const recovered = new AiStorage(dir);
    expect(recovered.load()).toEqual({ records: 0, truncatedAtLine: 1 });
  });

  it("treats a missing journal as empty rather than an error", () => {
    expect(new AiStorage(dir).load()).toEqual({
      records: 0,
      truncatedAtLine: null,
    });
  });

  it("continues appending after recovering from a torn journal", async () => {
    const store = new AiStorage(dir);
    await store.append("k1", record({ id: "a" }));
    writeFileSync(journal(), `${readFileSync(journal(), "utf-8")}{"v":1,"par`);
    const recovered = new AiStorage(dir);
    recovered.load();
    await recovered.append("k2", record({ id: "b" }));
    expect(recovered.list().map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("non-destructive migration", () => {
  it("refuses a journal from a newer version and leaves it untouched", () => {
    const future = `${JSON.stringify({
      v: STORAGE_VERSION + 1,
      key: "k",
      checksum: "x",
      record: record(),
    })}\n`;
    writeFileSync(journal(), future);
    const store = new AiStorage(dir);
    expect(() => store.load()).toThrow(
      expect.objectContaining({ code: "unsupported_version" }),
    );
    // The file must survive the refusal intact.
    expect(readFileSync(journal(), "utf-8")).toBe(future);
  });

  it("keeps the previous journal alongside a compaction", async () => {
    const store = new AiStorage(dir);
    await store.append("k1", record({ id: "a" }));
    await store.append("k2", record({ id: "b" }));
    store.compact();
    expect(store.list().map((r) => r.id)).toEqual(["a", "b"]);
    expect(existsSync(`${journal()}.bak`)).toBe(true);
    expect(new AiStorage(dir).load().records).toBe(2);
  });

  it("drops untrusted records on compaction without losing the original", async () => {
    const store = new AiStorage(dir);
    await store.append("k1", record({ id: "a" }));
    const text = readFileSync(journal(), "utf-8");
    writeFileSync(journal(), `${text}{"torn`);
    const recovered = new AiStorage(dir);
    recovered.load();
    recovered.compact();
    expect(recovered.list().map((r) => r.id)).toEqual(["a"]);
    // The torn original is still on disk for inspection.
    expect(readFileSync(`${journal()}.bak`, "utf-8")).toContain('{"torn');
  });
});

describe("disk failure", () => {
  it("surfaces an unwritable journal as an I/O error and records nothing", async () => {
    const store = new AiStorage(dir);
    await store.append("k1", record({ id: "a" }));
    chmodSync(dir, 0o500);
    const error = await store
      .append("k2", record({ id: "b" }))
      .catch((reason: unknown) => reason);
    chmodSync(dir, 0o700);
    // A read-only directory may still permit appends to an open path on some
    // systems; when it does not, the failure must be typed and leave no record.
    if (error instanceof AiStorageError) {
      expect(error.code).toBe("io");
      expect(store.list().map((r) => r.id)).toEqual(["a"]);
    } else {
      expect(store.list().map((r) => r.id)).toEqual(["a", "b"]);
    }
  });

  it("never leaks a filesystem path or errno in its message", () => {
    for (const code of ["io", "invalid", "limit", "unsupported_version"] as const) {
      const message = new AiStorageError(code).message;
      expect(message).not.toContain(dir);
      expect(message).not.toMatch(/ENOENT|EACCES|errno/);
    }
  });
});

describe("validation", () => {
  it.each([
    ["a blank key", "", record()],
    ["an oversized key", "k".repeat(513), record()],
  ])("rejects %s", async (_label, key, value) => {
    await expect(new AiStorage(dir).append(key, value)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it.each([
    ["a missing runId", { runId: "" }],
    ["a missing conversationId", { conversationId: "" }],
    ["an unknown kind", { kind: "sneaky" as AiTurnRecord["kind"] }],
    ["a non-integer timestamp", { createdAt: 1.5 }],
  ])("rejects a record with %s", async (_label, overrides) => {
    await expect(
      new AiStorage(dir).append("k", record(overrides)),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects a record larger than the per-record bound", async () => {
    await expect(
      new AiStorage(dir).append(
        "k",
        record({ payload: { blob: "x".repeat(STORAGE_LIMITS.maxRecordBytes) } }),
      ),
    ).rejects.toMatchObject({ code: "limit" });
  });
});
