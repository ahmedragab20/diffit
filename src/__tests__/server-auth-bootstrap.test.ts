// @vitest-environment node
//
// Red regression tests for the auth boundary on the real `createApp` stack:
// - unauthenticated HTML must be 401 (token must not leak via body/Set-Cookie)
// - hostile Origin must be rejected on HTML and API routes
// - authenticated responses must carry no-store/nosniff/no-referrer headers
//
// No server is started and no credentials are touched: the node:fs watcher is
// stubbed, readFile is mocked to serve a synthetic bundle, and an
// InMemoryCommentStore is injected so no real storage/watch writes occur.
import { describe, it, expect, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const watch = vi.fn(() => ({ unref() {} }));
  return { ...actual, watch, default: { ...actual, watch } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = vi.fn(async (path: string | Buffer | URL) => {
    const p =
      typeof path === "string"
        ? path
        : path instanceof URL
          ? path.pathname
          : path.toString();
    if (p.endsWith("/index.html") || p.endsWith("\\index.html")) {
      return Buffer.from("<html><head></head><body>review</body></html>");
    }
    const err = new Error(
      `ENOENT: no such file or directory, open '${p}'`,
    ) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  return { ...actual, readFile, default: { ...actual, readFile } };
});

import { createApp } from "../server.js";
import { DEFAULTS } from "../lib/diff-options.js";
import { InMemoryCommentStore } from "../lib/comments.js";
import {
  SESSION_TOKEN_HEADER,
  SESSION_TOKEN_COOKIE,
} from "../lib/server-auth.js";
import { AiService } from "../lib/ai/service.js";

const TOKEN = "test-only-review-key";
const CLIENT_DIR = "/nonexistent-diffing-client";

const app = createApp(
  CLIENT_DIR,
  DEFAULTS,
  new InMemoryCommentStore(),
  undefined,
  undefined,
  false,
  { bindHost: "0.0.0.0", authToken: TOKEN, insecureNoAuth: false },
  undefined,
  undefined,
  new AiService([]),
);

describe("server-auth-bootstrap", () => {
  it("returns 401 for unauthenticated HTML routes without disclosing the token in body or Set-Cookie", async () => {
    const root = await app.fetch(
      new Request("http://127.0.0.1/", {
        headers: { Host: "127.0.0.1" },
      }),
    );
    expect(root.status).toBe(401);
    expect(await root.text()).not.toContain(TOKEN);
    expect(root.headers.get("set-cookie") ?? "").not.toContain(TOKEN);

    const plan = await app.fetch(
      new Request("http://127.0.0.1/plan/test", {
        headers: { Host: "127.0.0.1" },
      }),
    );
    expect(plan.status).toBe(401);
    expect(await plan.text()).not.toContain(TOKEN);
    expect(plan.headers.get("set-cookie") ?? "").not.toContain(TOKEN);
    expect((plan.headers.getSetCookie?.() ?? []).join("\n")).not.toContain(
      SESSION_TOKEN_COOKIE,
    );
  });

  it("serves authenticated HTML (header token) and keeps loopback bootstrap at 200", async () => {
    const root = await app.fetch(
      new Request("http://127.0.0.1/", {
        headers: { Host: "127.0.0.1", [SESSION_TOKEN_HEADER]: TOKEN },
      }),
    );
    expect(root.status).toBe(200);

    const loopback = createApp(
      CLIENT_DIR,
      DEFAULTS,
      new InMemoryCommentStore(),
      undefined,
      undefined,
      false,
      { bindHost: "127.0.0.1", authToken: TOKEN },
      undefined,
      undefined,
      new AiService([]),
    );
    expect(
      (await loopback.fetch(new Request("http://127.0.0.1/"))).status,
    ).toBe(200);
  });

  it("rejects a hostile Origin with 403 on authenticated HTML and API routes", async () => {
    const html = await app.fetch(
      new Request("http://127.0.0.1/", {
        headers: {
          Host: "127.0.0.1",
          Origin: "http://evil.test",
          [SESSION_TOKEN_HEADER]: TOKEN,
        },
      }),
    );
    expect(html.status).toBe(403);

    const api = await app.fetch(
      new Request("http://127.0.0.1/api/comments", {
        headers: {
          Host: "127.0.0.1",
          Origin: "http://evil.test",
          [SESSION_TOKEN_HEADER]: TOKEN,
        },
      }),
    );
    expect(api.status).toBe(403);
  });

  it("serves same-origin authenticated API requests (GET /api/comments)", async () => {
    const api = await app.fetch(
      new Request("http://127.0.0.1/api/comments", {
        headers: {
          Host: "127.0.0.1",
          Origin: "http://127.0.0.1",
          [SESSION_TOKEN_HEADER]: TOKEN,
        },
      }),
    );
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual([]);
  });

  it("sets no-store/nosniff/no-referrer on authenticated HTML and API responses", async () => {
    const responses = [
      await app.fetch(
        new Request("http://127.0.0.1/", {
          headers: { Host: "127.0.0.1", [SESSION_TOKEN_HEADER]: TOKEN },
        }),
      ),
      await app.fetch(
        new Request("http://127.0.0.1/api/comments", {
          headers: { Host: "127.0.0.1", [SESSION_TOKEN_HEADER]: TOKEN },
        }),
      ),
    ];
    for (const res of responses) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });
});
