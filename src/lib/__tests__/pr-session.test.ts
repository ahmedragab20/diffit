// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import {
    FilePrSessionStore,
    InMemoryPrSessionStore,
    type PrSession,
} from "../pr-session.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseSession: PrSession = {
    ref: "1234",
    owner: "acme",
    repo: "widget",
    pullNumber: 1234,
    headSha: "abc",
    baseSha: "def",
    title: "A test PR",
    url: "https://github.com/ahmedragab20/diffing/pull/1234",
    author: { login: "octocat" },
    additions: 10,
    deletions: 5,
    changedFiles: 2,
    diff: "diff --git a/x b/x\n",
    comments: [],
    existingComments: [],
    authSource: "gh",
};

describe("InMemoryPrSessionStore", () => {
    it("starts empty", async () => {
        const store = new InMemoryPrSessionStore();
        expect(await store.get()).toBeNull();
    });

    it("round-trips a session", async () => {
        const store = new InMemoryPrSessionStore();
        await store.set(baseSession);
        expect(await store.get()).toEqual(baseSession);
    });

    it("shallow-merges on update", async () => {
        const store = new InMemoryPrSessionStore();
        await store.set(baseSession);
        const next = await store.update({
            submittedAt: 1700000000000,
            authSource: "token",
        });
        expect(next?.submittedAt).toBe(1700000000000);
        expect(next?.authSource).toBe("token");
        expect(next?.owner).toBe("acme");
    });

    it("returns null from update when empty", async () => {
        const store = new InMemoryPrSessionStore();
        expect(await store.update({ submittedAt: 1 })).toBeNull();
    });

    it("clears", async () => {
        const store = new InMemoryPrSessionStore();
        await store.set(baseSession);
        await store.clear();
        expect(await store.get()).toBeNull();
    });
});

describe("FilePrSessionStore", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "diffing-pr-session-"));
    });

    it("round-trips a session through disk", async () => {
        const store = new FilePrSessionStore(dir);
        expect(await store.get()).toBeNull();
        await store.set(baseSession);
        const reloaded = new FilePrSessionStore(dir);
        expect(await reloaded.get()).toEqual(baseSession);
        rmSync(dir, { recursive: true, force: true });
    });

    it("returns null on missing file", async () => {
        const store = new FilePrSessionStore(dir);
        expect(await store.get()).toBeNull();
        rmSync(dir, { recursive: true, force: true });
    });

    it("update returns null when no session exists", async () => {
        const store = new FilePrSessionStore(dir);
        expect(await store.update({ submittedAt: 1 })).toBeNull();
        rmSync(dir, { recursive: true, force: true });
    });

    it("update shallow-merges and persists", async () => {
        const store = new FilePrSessionStore(dir);
        await store.set(baseSession);
        const next = await store.update({ submittedAt: 42 });
        expect(next?.submittedAt).toBe(42);
        expect(next?.owner).toBe("acme");

        const reloaded = new FilePrSessionStore(dir);
        const reloaded2 = await reloaded.get();
        expect(reloaded2?.submittedAt).toBe(42);
        expect(reloaded2?.owner).toBe("acme");
        rmSync(dir, { recursive: true, force: true });
    });

    it("clear removes the file", async () => {
        const store = new FilePrSessionStore(dir);
        await store.set(baseSession);
        await store.clear();
        expect(await store.get()).toBeNull();
        rmSync(dir, { recursive: true, force: true });
    });

    it("keeps a previous PR's drafts after switching the active session", async () => {
        const store = new FilePrSessionStore(dir);
        await store.set({
            ...baseSession,
            comments: [
                {
                    id: "keep-me",
                    filePath: "x.ts",
                    side: "additions",
                    lineNumber: 1,
                    lineContent: "x",
                    body: "draft-a",
                    status: "open",
                    createdAt: 1,
                    replies: [],
                },
            ],
        });
        await store.set({
            ...baseSession,
            owner: "other",
            repo: "repo",
            pullNumber: 99,
            comments: [],
        });
        const previous = await store.getFor({
            owner: "acme",
            repo: "widget",
            pullNumber: 1234,
        });
        expect(previous?.comments.map((comment) => comment.body)).toEqual([
            "draft-a",
        ]);
        rmSync(dir, { recursive: true, force: true });
    });

    it("serializes concurrent apply mutations", async () => {
        const store = new InMemoryPrSessionStore();
        await store.set(baseSession);
        await Promise.all([
            store.apply((current) =>
                current
                    ? {
                          ...current,
                          comments: [
                              ...current.comments,
                              {
                                  id: "a",
                                  filePath: "x.ts",
                                  side: "additions",
                                  lineNumber: 1,
                                  lineContent: "x",
                                  body: "a",
                                  status: "open",
                                  createdAt: 1,
                                  replies: [],
                              },
                          ],
                      }
                    : null,
            ),
            store.apply((current) =>
                current
                    ? {
                          ...current,
                          comments: [
                              ...current.comments,
                              {
                                  id: "b",
                                  filePath: "x.ts",
                                  side: "additions",
                                  lineNumber: 1,
                                  lineContent: "x",
                                  body: "b",
                                  status: "open",
                                  createdAt: 2,
                                  replies: [],
                              },
                          ],
                      }
                    : null,
            ),
        ]);
        const bodies =
            (await store.get())?.comments.map((comment) => comment.body) ?? [];
        expect(bodies.sort()).toEqual(["a", "b"]);
    });
});
