// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAiConversationStore } from "../conversations.js";
import { AiStorage } from "../storage.js";
import {
  importConversation,
  importLegacyHistory,
  legacyTurnKey,
} from "../import-legacy.js";
import type { AiConversation } from "../conversations.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "diffing-ai-import-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function conversation(
  overrides: Partial<AiConversation> = {},
): AiConversation {
  return {
    id: "c1",
    title: "Legacy chat",
    surface: "diff",
    scopeKey: "scope",
    createdAt: 100,
    updatedAt: 200,
    turns: [
      { role: "user", text: "why is this slow?", createdAt: 110 },
      { role: "assistant", text: "the loop is quadratic", createdAt: 120 },
    ],
    ...overrides,
  };
}

async function seeded() {
  const store = new InMemoryAiConversationStore();
  const created = await store.create({
    title: "Legacy chat",
    surface: "diff",
    scopeKey: "scope",
  });
  await store.update(created.id, {
    turns: conversation().turns,
  });
  return { store, id: created.id };
}

describe("importing legacy turns", () => {
  it("copies every usable turn into storage", async () => {
    const storage = new AiStorage(dir);
    const report = await importConversation(conversation(), storage);
    expect(report).toMatchObject({ imported: 2, alreadyPresent: 0, skipped: 0 });
    expect(storage.list("c1").map((record) => record.kind)).toEqual([
      "request",
      "result",
    ]);
  });

  it("carries the legacy text and marks its origin", async () => {
    const storage = new AiStorage(dir);
    await importConversation(conversation(), storage);
    expect(storage.list("c1")[0].payload).toMatchObject({
      source: "legacy-import",
      role: "user",
      text: "why is this slow?",
    });
  });

  it("falls back to the conversation's timestamp for an undated turn", async () => {
    const storage = new AiStorage(dir);
    await importConversation(
      conversation({ turns: [{ role: "user", text: "hi" }] }),
      storage,
    );
    expect(storage.list("c1")[0].createdAt).toBe(100);
  });
});

describe("re-running an import", () => {
  it("adds nothing the second time", async () => {
    const storage = new AiStorage(dir);
    const first = await importConversation(conversation(), storage);
    const second = await importConversation(conversation(), storage);
    expect(first.imported).toBe(2);
    expect(second).toMatchObject({ imported: 0, alreadyPresent: 2 });
    expect(storage.list("c1")).toHaveLength(2);
  });

  it("survives a restart between runs", async () => {
    await importConversation(conversation(), new AiStorage(dir));
    const reopened = new AiStorage(dir);
    const again = await importConversation(conversation(), reopened);
    expect(again.imported).toBe(0);
    expect(reopened.list("c1")).toHaveLength(2);
  });

  it("resumes an interrupted import without duplicating what landed", async () => {
    const storage = new AiStorage(dir);
    const partial = conversation({ turns: [conversation().turns[0]] });
    await importConversation(partial, storage);
    expect(storage.list("c1")).toHaveLength(1);
    // The full import now only needs the turn that never landed.
    const resumed = await importConversation(conversation(), storage);
    expect(resumed).toMatchObject({ imported: 1, alreadyPresent: 1 });
    expect(storage.list("c1")).toHaveLength(2);
  });

  it("keys turns distinctly even when their text is identical", async () => {
    const storage = new AiStorage(dir);
    const repeated = conversation({
      turns: [
        { role: "user", text: "same" },
        { role: "user", text: "same" },
      ],
    });
    await importConversation(repeated, storage);
    expect(storage.list("c1")).toHaveLength(2);
    expect(legacyTurnKey("c1", 0, undefined)).not.toBe(
      legacyTurnKey("c1", 1, undefined),
    );
  });
});

describe("never overwriting the originals", () => {
  it("leaves the legacy store byte for byte intact", async () => {
    const { store, id } = await seeded();
    const before = JSON.stringify(await store.get(id));
    await importLegacyHistory(store, new AiStorage(dir));
    expect(JSON.stringify(await store.get(id))).toBe(before);
  });

  it("imports every conversation the legacy store lists", async () => {
    const { store } = await seeded();
    const second = await store.create({
      title: "Another",
      surface: "diff",
      scopeKey: "scope",
    });
    await store.update(second.id, {
      turns: [{ role: "user", text: "second chat" }],
    });
    const report = await importLegacyHistory(store, new AiStorage(dir));
    expect(report.conversations).toBe(2);
    expect(report.imported).toBe(3);
  });

  it("reports an empty legacy store honestly", async () => {
    const report = await importLegacyHistory(
      new InMemoryAiConversationStore(),
      new AiStorage(dir),
    );
    expect(report).toEqual({
      conversations: 0,
      imported: 0,
      alreadyPresent: 0,
      skipped: 0,
    });
  });
});

describe("untrusted turns", () => {
  it.each([
    ["a missing role", { text: "x" }],
    ["an unknown role", { role: "system", text: "x" }],
    ["a non-string body", { role: "user", text: 42 }],
    ["null", null],
  ])("skips %s and counts it rather than rewriting it", async (_label, turn) => {
    const storage = new AiStorage(dir);
    const report = await importConversation(
      conversation({
        turns: [turn as never, { role: "user", text: "good" }],
      }),
      storage,
    );
    expect(report.skipped).toBe(1);
    expect(report.imported).toBe(1);
    expect(storage.list("c1")).toHaveLength(1);
  });
});
