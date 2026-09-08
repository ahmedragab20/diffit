// @vitest-environment node
// Release gates for the AI surface: the flag that rolls it back, the provider
// defaults that must not drift, and the packaging constraints the plan fixed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemoryCommentStore } from "../lib/comments.js";
import { InMemoryPlanStore } from "../lib/plans.js";
import { InMemoryMockupStore } from "../lib/mockups.js";
import { InMemoryAiConversationStore } from "../lib/ai/conversations.js";
import { AiService } from "../lib/ai/service.js";
import { createDefaultAdapters } from "../lib/ai/adapters.js";
import { DEFAULTS } from "../lib/diff-options.js";

const root = process.cwd();

vi.mock("../lib/git.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/git.js")>();
	return { ...actual, getRepoRoot: () => process.cwd() };
});

const mocks = vi.hoisted(() => ({ evidenceTools: true }));
vi.mock("../lib/settings.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/settings.js")>();
	return {
		...actual,
		loadSettings: () => ({
			...actual.loadSettings(),
			aiEvidenceTools: mocks.evidenceTools,
		}),
	};
});

async function app() {
	const { createApp } = await import("../server.js");
	return createApp(
		"/tmp/diffing-ai-client",
		DEFAULTS,
		new InMemoryCommentStore(),
		new InMemoryPlanStore(),
		undefined,
		false,
		undefined,
		new InMemoryMockupStore(),
		undefined,
		new AiService([]),
		new InMemoryAiConversationStore(),
	);
}

const routes = [
	["GET", "/api/ai/evidence"],
	["GET", "/api/ai/evidence/any/map"],
	["POST", "/api/ai/evidence/any/read"],
	["POST", "/api/ai/evidence/any/search"],
	["POST", "/api/ai/evidence/any/symbols"],
	["POST", "/api/ai/evidence/any/verify"],
	["GET", "/api/ai/evidence/any/history?key=a"],
	["GET", "/api/ai/evidence/any/discussion"],
] as const;

describe("evidence feature flag", () => {
	it.each(routes)("serves %s %s when enabled", async (method, path) => {
		mocks.evidenceTools = true;
		const server = await app();
		const response = await server.request(path, {
			method,
			headers: { "content-type": "application/json" },
			body: method === "POST" ? JSON.stringify({}) : undefined,
		});
		// A missing capture is also 404, so the flag is distinguished by the
		// body: enabled must never answer with the disabled message.
		expect([200, 400, 404]).toContain(response.status);
		const body = await response.json().catch(() => ({}));
		expect(body).not.toEqual({ error: "AI evidence tools are disabled." });
	});

	it.each(routes)("rolls back %s %s when disabled", async (method, path) => {
		mocks.evidenceTools = false;
		const server = await app();
		const response = await server.request(path, {
			method,
			headers: { "content-type": "application/json" },
			body: method === "POST" ? JSON.stringify({}) : undefined,
		});
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: "AI evidence tools are disabled.",
		});
		mocks.evidenceTools = true;
	});

	it("leaves the rest of the AI surface untouched when disabled", async () => {
		mocks.evidenceTools = false;
		const server = await app();
		expect((await server.request("/api/ai/models")).status).toBe(200);
		mocks.evidenceTools = true;
	});
});

describe("default providers", () => {
	const adapters = createDefaultAdapters({
		get: async () => null,
		set: async () => "session" as const,
		delete: async () => {},
	});

	it("ships exactly the five expected providers, unchanged", () => {
		expect(adapters.map((adapter) => adapter.id)).toEqual([
			"codex",
			"claude",
			"opencode",
			"cursor",
			"xai",
		]);
	});

	it("keeps the dormant direct providers out of the defaults", () => {
		const ids = adapters.map((adapter) => adapter.id);
		expect(ids).not.toContain("openai");
		expect(ids).not.toContain("anthropic");
	});
});

describe("packaging constraints", () => {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

	it("still supports the declared Node floor", () => {
		expect(pkg.engines.node).toBe(">=20");
	});

  it("adds no runtime dependency for the AI surface", () => {
    // node:sqlite does not exist on the declared floor, and a native driver
    // would need a prebuild for every packaged platform.
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).not.toContain("better-sqlite3");
    expect(deps).not.toContain("sqlite3");
    expect(deps.filter((name) => name.includes("language-server"))).toEqual([]);
  });

	it("uses no Node API newer than the declared floor in AI modules", () => {
		const modules = [
			"storage.ts",
			"tools.ts",
			"lsp.ts",
			"history.ts",
			"discussion.ts",
			"local-originals.ts",
			"snapshot-store.ts",
		];
		for (const file of modules) {
			const text = readFileSync(join(root, "src/lib/ai", file), "utf-8");
			// The docstring may explain why sqlite is absent; only an import counts.
			expect(text, `${file} must not import node:sqlite`).not.toMatch(
				/from\s+"node:sqlite"|require\(\s*"node:sqlite"/,
			);
		}
	});
});
