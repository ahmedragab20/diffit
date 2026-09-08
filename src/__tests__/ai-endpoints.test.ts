// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { InMemoryCommentStore } from "../lib/comments.js";
import { InMemoryPlanStore } from "../lib/plans.js";
import { InMemoryMockupStore } from "../lib/mockups.js";
import { InMemoryPrSessionStore } from "../lib/pr-session.js";
import type { PrSession, PrSessionStore } from "../lib/pr-session.js";
import { fetchPrFileContentViaGh } from "../lib/github.js";
import { InMemoryAiConversationStore } from "../lib/ai/conversations.js";
import { AiService } from "../lib/ai/service.js";
import { captureLocalReview } from "../lib/ai/local-snapshot.js";
import type { AiBackendAdapter } from "../lib/ai/types.js";
import type { AiRunPolicy } from "../lib/ai/lifecycle.js";
import { AiSnapshotError, sourceHash } from "../lib/ai/snapshots.js";

const localSnapshotState = vi.hoisted(() => ({
	stale: false,
	patch:
		"diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+canonical\n",
	gate: undefined as Promise<void> | undefined,
	calls: 0,
}));

vi.mock("../lib/ai/local-snapshot.js", () => ({
	captureLocalReview: vi.fn(async () => {
		localSnapshotState.calls++;
		if (localSnapshotState.gate) await localSnapshotState.gate;
		return {
			identity: {
				kind: "local",
				repositoryId: "test",
				mode: "working",
				baseSha: null,
				headSha: null,
				indexHash: "test",
				patchHash: sourceHash(localSnapshotState.patch),
			},
			patch: localSnapshotState.patch,
			omissions: [],
			assertFresh: async () => {
				if (localSnapshotState.stale) throw new AiSnapshotError("stale");
			},
		};
	}),
}));
import { DEFAULTS } from "../lib/diff-options.js";

vi.mock("../lib/git.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/git.js")>();
	return { ...actual, getRepoRoot: () => process.cwd() };
});

vi.mock("../lib/github.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/github.js")>()),
	fetchPrFileContentViaGh: vi.fn(async () => Buffer.from("synthetic source")),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		watch: vi.fn(() => ({ unref: vi.fn() })),
	};
});

function adapter(
	run: AiBackendAdapter["run"] = vi.fn(async (_request, _signal, onEvent) => {
		await onEvent({ type: "text-delta", text: "hello" });
		return "hello";
	}),
): AiBackendAdapter {
	return {
		id: "codex",
		connection: async () => ({
			id: "codex",
			label: "Codex",
			status: "connected",
			runtimeAvailable: true,
			credentialRoutes: ["subscription"],
			activeRoutes: ["subscription"],
		}),
		models: async () => [
			{
				id: "codex/subscription/codex/gpt-test",
				sourceId: "codex",
				credentialRoute: "subscription",
				providerId: "codex",
				modelId: "gpt-test",
				displayName: "GPT Test",
			},
		],
		run,
	};
}

async function app(
	run?: AiBackendAdapter["run"],
	plans = new InMemoryPlanStore(),
	prStore?: PrSessionStore,
	policy?: Partial<AiRunPolicy>,
) {
	const { createApp } = await import("../server.js");
	return createApp(
		"/tmp/diffing-ai-client",
		DEFAULTS,
		new InMemoryCommentStore(),
		plans,
		prStore,
		!!prStore,
		undefined,
		new InMemoryMockupStore(),
		undefined,
		new AiService([adapter(run)], undefined, policy),
		new InMemoryAiConversationStore(),
	);
}

describe("AI endpoints", () => {
	it("lists normalized connections and models", async () => {
		const server = await app();
		const connections = await server.request("/api/ai/connections");
		const models = await server.request("/api/ai/models");
		expect((await connections.json()).connections[0].id).toBe("codex");
		expect((await models.json()).models[0].modelId).toBe("gpt-test");
	});

	it("rejects background inference without invoking the adapter", async () => {
		const run = vi.fn(async () => "nope");
		const server = await app(run);
		const response = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				trigger: "background",
				modelId: "codex/subscription/codex/gpt-test",
				action: "ask",
				surface: "diff",
				context: { kind: "diff" },
			}),
		});
		expect(response.status).toBe(400);
		expect(run).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "renderer metadata text", patch: "[object Object],[object Object]" },
		{ label: "a non-string patch", patch: [{ type: "change" }] },
	])(
		"rejects $label instead of sending unreadable context to the model",
		async ({ patch }) => {
			const run = vi.fn(async () => "nope");
			const server = await app(run);
			const response = await server.request("/api/ai/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					trigger: "user",
					conversationId: "bad-context",
					modelId: "codex/subscription/codex/gpt-test",
					action: "ask",
					surface: "diff",
					context: { kind: "file", filePath: "src/a.ts", patch },
				}),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error:
					"The selected diff context could not be serialized. Refresh the review and try again.",
			});
			expect(run).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ label: "context primitive", patch: { context: 1 } },
		{
			label: "attachmentPaths string",
			patch: { context: { kind: "diff", attachmentPaths: "x" } },
		},
		{ label: "unknown action", patch: { action: "unknown" } },
		{ label: "resolved images", patch: { resolvedImages: [] } },
	])(
		"rejects malformed $label without invoking the adapter",
		async ({ patch }) => {
			const run = vi.fn(async () => "nope");
			const server = await app(run);
			const response = await server.request("/api/ai/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					trigger: "user",
					conversationId: "bad",
					modelId: "codex/subscription/codex/gpt-test",
					action: "ask",
					surface: "diff",
					context: { kind: "diff" },
					...patch,
				}),
			});
			expect(response.status).toBe(400);
			expect(run).not.toHaveBeenCalled();
		},
	);

	it("rejects an oversized raw body without invoking the adapter", async () => {
		const run = vi.fn(async () => "nope");
		const server = await app(run);
		const response = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json", "content-length": "1" },
			body: JSON.stringify({
				trigger: "user",
				conversationId: "x",
				modelId: "codex/subscription/codex/gpt-test",
				action: "ask",
				surface: "diff",
				context: { kind: "diff" },
				prompt: "x".repeat(4 * 1024 * 1024),
			}),
		});
		expect(response.status).toBe(413);
		expect(run).not.toHaveBeenCalled();
	});

	it("reports cancellation of a missing run as inactive", async () => {
		const server = await app();
		const response = await server.request("/api/ai/runs/missing-run/cancel", {
			method: "POST",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			canceled: false,
			cancellationRequested: false,
			cancellationConfirmed: false,
			status: "not-active",
		});
	});

	it("streams only after an explicit user-triggered request", async () => {
		const run = vi.fn(async (_request, _signal, onEvent) => {
			await onEvent({ type: "text-delta", text: "hello" });
			return "hello";
		});
		const server = await app(run);
		const response = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				trigger: "user",
				conversationId: "c1",
				modelId: "codex/subscription/codex/gpt-test",
				action: "ask",
				surface: "diff",
				context: { kind: "diff", patch: "+x" },
			}),
		});
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("event: start");
		expect(text).toContain("hello");
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("hydrates explicitly attached FFF file paths into bounded context", async () => {
		let attached: unknown;
		const run = vi.fn(async (request, _signal, onEvent) => {
			attached = request.context.attachments;
			await onEvent({ type: "text-delta", text: "attached" });
			return "attached";
		});
		const server = await app(run);
		const response = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				trigger: "user",
				conversationId: "c2",
				modelId: "codex/subscription/codex/gpt-test",
				action: "ask",
				surface: "diff",
				context: { kind: "diff", attachmentPaths: ["package.json"] },
			}),
		});
		expect(response.status).toBe(200);
		await response.text();
		expect(attached).toEqual([
			expect.objectContaining({
				path: "package.json",
				content: expect.stringContaining('"name": "diffing"'),
			}),
		]);
	});

	it("persists multiple scoped conversations without mixing review surfaces", async () => {
		const server = await app();
		const created = await server.request("/api/ai/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				surface: "diff",
				scopeKey: "repo:branch",
				title: "Parser review",
			}),
		});
		expect(created.status).toBe(201);
		const conversation = (await created.json()).conversation;
		const updated = await server.request(
			`/api/ai/conversations/${conversation.id}`,
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					draft: "follow up",
					turns: [
						{ role: "user", text: "What changed?" },
						{ role: "assistant", text: "The parser." },
					],
				}),
			},
		);
		expect((await updated.json()).conversation.turns).toHaveLength(2);
		const scoped = await server.request(
			"/api/ai/conversations?surface=plan&scopeKey=repo:branch",
		);
		expect((await scoped.json()).conversations).toEqual([]);
		const listed = await server.request(
			"/api/ai/conversations?surface=diff&scopeKey=repo:branch",
		);
		expect((await listed.json()).conversations[0]).toMatchObject({
			title: "Parser review",
			turnCount: 2,
		});
	});

	it("accepts mockup conversations and rejects unknown surfaces", async () => {
		const server = await app();
		const created = await server.request("/api/ai/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				surface: "mockup",
				scopeKey: "mockup:mk-1",
				title: "Checkout",
			}),
		});
		expect(created.status).toBe(201);
		expect((await created.json()).conversation.surface).toBe("mockup");
		const bad = await server.request("/api/ai/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ surface: "canvas", scopeKey: "x" }),
		});
		expect(bad.status).toBe(400);
		const listed = await server.request(
			"/api/ai/conversations?surface=mockup&scopeKey=mockup:mk-1",
		);
		expect((await listed.json()).conversations[0]).toMatchObject({
			title: "Checkout",
			surface: "mockup",
		});
	});

	it("runs mockup inference only with an explicit user trigger", async () => {
		const run = vi.fn(async () => "nope");
		const server = await app(run);
		const blocked = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				trigger: "background",
				modelId: "codex/subscription/codex/gpt-test",
				action: "critique-mockup",
				surface: "mockup",
				context: {
					kind: "mockup",
					mockupId: "mk-1",
					title: "Checkout",
					version: 1,
				},
			}),
		});
		expect(blocked.status).toBe(400);
		expect(run).not.toHaveBeenCalled();
		const invalidSurface = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				trigger: "user",
				conversationId: "c-mock",
				modelId: "codex/subscription/codex/gpt-test",
				action: "ask",
				surface: "canvas",
				context: {
					kind: "mockup",
					mockupId: "mk-1",
					title: "Checkout",
					version: 1,
				},
			}),
		});
		expect(invalidSurface.status).toBe(400);
		expect(run).not.toHaveBeenCalled();
		const allowed = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				trigger: "user",
				conversationId: "c-mock",
				modelId: "codex/subscription/codex/gpt-test",
				action: "critique-mockup",
				surface: "mockup",
				context: {
					kind: "mockup-screen",
					mockupId: "mk-1",
					title: "Checkout",
					version: 1,
					html: "<h1>Pay</h1>",
				},
			}),
		});
		expect(allowed.status).toBe(200);
		await allowed.text();
		expect(run).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: "user",
				surface: "mockup",
				action: "critique-mockup",
			}),
			expect.anything(),
			expect.anything(),
		);
	});
});

describe("AI preparation admission endpoints", () => {
	const body = (conversationId: string) => ({
		trigger: "user",
		conversationId,
		modelId: "codex/subscription/codex/gpt-test",
		action: "ask",
		surface: "diff",
		context: { kind: "diff" },
	});

	it("returns a sanitized server error when source preparation fails", async () => {
		vi
			.mocked(captureLocalReview)
			.mockRejectedValueOnce(new Error("sensitive diagnostic"));
		const run = vi.fn(async () => "answer");
		const server = await app(run);
		const response = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body("failed-preparation")),
		});
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "AI request preparation failed.",
			code: "preparation_failed",
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("returns capacity while the first local preparation is unresolved", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		localSnapshotState.gate = gate;
		localSnapshotState.calls = 0;
		const run = vi.fn(async (_request, _signal, onEvent) => {
			await onEvent({ type: "text-delta", text: "answer" });
			return "answer";
		});
		try {
			const server = await app(run, new InMemoryPlanStore(), undefined, {
				preparationMs: 1000,
				maxConcurrent: 1,
				maxPerSource: 1,
			});
			const first = server.request("/api/ai/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body("capacity-first")),
			});
			await vi.waitFor(() => expect(localSnapshotState.calls).toBe(1));
			const second = await server.request("/api/ai/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body("capacity-second")),
			});
			expect(second.status).toBe(503);
			expect(await second.json()).toMatchObject({ code: "capacity" });
			expect(localSnapshotState.calls).toBe(1);
			release();
			const firstResponse = await first;
			expect(firstResponse.status).toBe(200);
			await firstResponse.text();
			expect(run).toHaveBeenCalledTimes(1);
		} finally {
			release();
			localSnapshotState.gate = undefined;
			localSnapshotState.calls = 0;
		}
	});

	it("returns cancellation promptly but retains capacity until preparation settles", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		localSnapshotState.gate = gate;
		localSnapshotState.calls = 0;
		const run = vi.fn(async (_request, _signal, onEvent) => {
			await onEvent({ type: "text-delta", text: "answer" });
			return "answer";
		});
		const controller = new AbortController();
		try {
			const server = await app(run, new InMemoryPlanStore(), undefined, {
				preparationMs: 1000,
				maxConcurrent: 1,
				maxPerSource: 1,
			});
			const first = server.request("/api/ai/run", {
				method: "POST",
				signal: controller.signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body("cancel-first")),
			});
			await vi.waitFor(() => expect(localSnapshotState.calls).toBe(1));
			controller.abort();
			const cancelled = await first;
			expect(cancelled.status).toBe(409);
			expect(await cancelled.json()).toMatchObject({ code: "cancelled" });
			expect(run).not.toHaveBeenCalled();
			const blocked = await server.request("/api/ai/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body("cancel-second")),
			});
			expect(blocked.status).toBe(503);
			expect(await blocked.json()).toMatchObject({ code: "capacity" });
			release();
			await new Promise<void>((resolve) => setImmediate(resolve));
			const next = await server.request("/api/ai/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body("cancel-third")),
			});
			expect(next.status).toBe(200);
			await next.text();
			expect(run).toHaveBeenCalledTimes(1);
		} finally {
			release();
			localSnapshotState.gate = undefined;
			localSnapshotState.calls = 0;
		}
	});
});

describe("AI plan snapshot endpoint", () => {
	function planRequest(
		planId: string,
		context: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			trigger: "user",
			conversationId: "plan",
			modelId: "codex/subscription/codex/gpt-test",
			action: "critique-plan",
			surface: "plan",
			context: { kind: "plan", planId, version: 1, title: "client", ...context },
		};
	}

	it("resolves canonical body/title and sends snapshot metadata", async () => {
		const plans = new InMemoryPlanStore();
		const plan = await plans.upsert({ title: "Stored", body: "canonical" });
		let captured: Parameters<AiBackendAdapter["run"]>[0] | undefined;
		const run = vi.fn(async (request, _signal, onEvent) => {
			captured = request;
			await onEvent({ type: "text-delta", text: "ok" });
			return "ok";
		});
		const server = await app(run, plans);
		const response = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(planRequest(plan.id)),
		});
		expect(response.status).toBe(200);
		await response.text();
		expect(captured?.context).toMatchObject({
			body: "canonical",
			title: "Stored",
		});
		expect(captured?.snapshot).toMatchObject({
			identity: { kind: "plan", bodyHash: sourceHash("canonical") },
		});
	});

	it("keeps body drafts explicit in context and prompt", async () => {
		const plans = new InMemoryPlanStore();
		const plan = await plans.upsert({ title: "Stored", body: "canonical" });
		let captured: Parameters<AiBackendAdapter["run"]>[0] | undefined;
		const run = vi.fn(async (request, _signal, onEvent) => {
			captured = request;
			await onEvent({ type: "text-delta", text: "ok" });
			return "ok";
		});
		const server = await app(run, plans);
		const response = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(planRequest(plan.id, { bodyDraft: "unsaved" })),
		});
		expect(response.status).toBe(200);
		await response.text();
		expect(captured?.context).toMatchObject({
			body: "canonical",
			bodyDraft: "unsaved",
		});
		expect(
			captured?.snapshot?.sources.find((source) => source.key === "body-draft"),
		).toMatchObject({ provenance: "draft" });
		expect(captured?.prompt).toContain(
			"Unsubmitted plan text (draft, not stored evidence)",
		);
		expect(captured?.prompt).toContain("lines-in-this-prompt");
		expect(captured?.evidence?.length).toBeGreaterThan(0);
		expect(captured?.snapshotReader).toBeUndefined();
	});

	it("rejects client snapshots, missing plans, and stale same-version bodies", async () => {
		const plans = new InMemoryPlanStore();
		const plan = await plans.upsert({ title: "Stored", body: "canonical" });
		const run = vi.fn(async () => "no");
		const server = await app(run, plans);
		const forged = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...planRequest(plan.id),
				snapshot: { forged: true },
			}),
		});
		expect(forged.status).toBe(400);
		const missing = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(planRequest("missing")),
		});
		expect(missing.status).toBe(404);
		await plans.update(plan.id, { body: "live edit" });
		const stale = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(planRequest(plan.id, { body: "canonical" })),
		});
		expect(stale.status).toBe(409);
		expect(run).not.toHaveBeenCalled();
	});

	it("captures canonical local diff evidence and strips the reader before adapter dispatch", async () => {
		let captured: Parameters<AiBackendAdapter["run"]>[0] | undefined;
		const run = vi.fn(async (request, _signal, onEvent) => {
			captured = request;
			await onEvent({ type: "text-delta", text: "ok" });
			return "ok";
		});
		const server = await app(run);
		const response = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				trigger: "user",
				conversationId: "diff",
				modelId: "codex/subscription/codex/gpt-test",
				action: "ask",
				surface: "diff",
				context: { kind: "diff", patch: "forged browser patch" },
			}),
		});
		expect(response.status).toBe(200);
		await response.text();
		expect(captured?.prompt).toContain("canonical");
		expect(captured?.prompt).not.toContain("forged browser patch");
		expect(captured?.evidence?.length).toBeGreaterThan(0);
		expect(captured?.snapshotReader).toBeUndefined();
		const ids = new Set(captured?.snapshot?.sources.map((source) => source.id));
		for (const evidence of captured?.evidence ?? [])
			expect(ids.has(evidence.sourceId)).toBe(true);
	});

	it("rejects stale local capture without invoking the adapter", async () => {
		localSnapshotState.stale = true;
		try {
			const run = vi.fn(async () => "no");
			const server = await app(run);
			const response = await server.request("/api/ai/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					trigger: "user",
					conversationId: "stale-local",
					modelId: "codex/subscription/codex/gpt-test",
					action: "ask",
					surface: "diff",
					context: { kind: "diff" },
				}),
			});
			expect(response.status).toBe(409);
			expect(run).not.toHaveBeenCalled();
		} finally {
			localSnapshotState.stale = false;
		}
	});

	it("rejects client snapshot reader and evidence fields before adapter dispatch", async () => {
		for (const field of [{ snapshotReader: {} }, { evidence: [] }]) {
			const run = vi.fn(async () => "no");
			const server = await app(run);
			const response = await server.request("/api/ai/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					trigger: "user",
					conversationId: "forged-fields",
					modelId: "codex/subscription/codex/gpt-test",
					action: "ask",
					surface: "diff",
					context: { kind: "diff" },
					...field,
				}),
			});
			expect(response.status).toBe(400);
			expect(run).not.toHaveBeenCalled();
		}
	});

	it("rejects a PR attachment read when the captured head changes", async () => {
		vi.mocked(fetchPrFileContentViaGh).mockReset();
		const prStore = new InMemoryPrSessionStore();
		const oldHead = "a".repeat(40);
		const newHead = "b".repeat(40);
		const session: PrSession = {
			ref: "#1",
			owner: "o",
			repo: "r",
			pullNumber: 1,
			headSha: oldHead,
			baseSha: "c".repeat(40),
			mergeBaseSha: "c".repeat(40),
			title: "P",
			url: "https://github.com/o/r/pull/1",
			author: null,
			additions: 1,
			deletions: 0,
			changedFiles: 1,
			diff: "",
			comments: [],
			existingComments: [],
		};
		await prStore.set(session);
		const run = vi.fn(
			async (_request: Parameters<AiBackendAdapter["run"]>[0]) => "ok",
		);
		vi
			.mocked(fetchPrFileContentViaGh)
			.mockImplementationOnce(async (_resolved, _path, sha) => {
				expect(sha).toBe(oldHead);
				await prStore.update({ headSha: newHead });
				return Buffer.from("old source");
			});
		const server = await app(run, new InMemoryPlanStore(), prStore);
		const request = {
			trigger: "user",
			conversationId: "pr",
			modelId: "codex/subscription/codex/gpt-test",
			action: "ask",
			surface: "pr-diff",
			context: { kind: "diff", attachmentPaths: ["a.ts"] },
		};
		const raced = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		});
		expect(raced.status).toBe(409);
		expect(run).not.toHaveBeenCalled();
		vi
			.mocked(fetchPrFileContentViaGh)
			.mockResolvedValueOnce(Buffer.from("new source"));
		const ok = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		});
		expect(ok.status).toBe(200);
		await ok.text();
		expect(fetchPrFileContentViaGh).toHaveBeenCalledTimes(2);
		expect(vi.mocked(fetchPrFileContentViaGh).mock.calls.at(-1)?.[2]).toBe(
			newHead,
		);
		expect(run.mock.calls[0]?.[0].context.attachments).toMatchObject([
			{ content: "new source" },
		]);
	});
});

describe("AI evidence navigation endpoints", () => {
	async function captured(body = "alpha\nbravo\ncharlie") {
		const plans = new InMemoryPlanStore();
		const plan = await plans.upsert({ title: "Stored", body });
		const server = await app(
			vi.fn(async (_request, _signal, onEvent) => {
				await onEvent({ type: "text-delta", text: "ok" });
				return "ok";
			}),
			plans,
		);
		const run = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				trigger: "user",
				conversationId: "plan",
				modelId: "codex/subscription/codex/gpt-test",
				action: "critique-plan",
				surface: "plan",
				context: { kind: "plan", planId: plan.id, version: 1, title: "client" },
			}),
		});
		expect(run.status).toBe(200);
		await run.text();
		const listed = await (await server.request("/api/ai/evidence")).json();
		expect(listed.snapshots).toHaveLength(1);
		return { server, id: listed.snapshots[0].id as string, listed };
	}

	it("lists nothing before a run has captured evidence", async () => {
		const server = await app();
		const response = await server.request("/api/ai/evidence");
		expect(await response.json()).toEqual({ snapshots: [] });
	});

	it("retains a run's capture without exposing its content in the listing", async () => {
		const { listed } = await captured();
		expect(listed.snapshots[0]).toMatchObject({ identityKind: "plan" });
		expect(JSON.stringify(listed)).not.toContain("bravo");
	});

	it("maps a capture without counting the listing as a read", async () => {
		const { server, id } = await captured();
		const map = await (await server.request(`/api/ai/evidence/${id}/map`)).json();
		expect(map.sources.length).toBeGreaterThan(0);
		// The run already read to build its prompt; mapping must not add to that.
		const again = await (
			await server.request(`/api/ai/evidence/${id}/map`)
		).json();
		expect(again.coverage.returnedLines).toBe(map.coverage.returnedLines);
	});

	it("reads cited lines and records coverage", async () => {
		const { server, id } = await captured();
		const map = await (await server.request(`/api/ai/evidence/${id}/map`)).json();
		const key = map.sources[0].key as string;
		const response = await server.request(`/api/ai/evidence/${id}/read`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requests: [{ key, startLine: 1, endLine: 2 }] }),
		});
		expect(response.status).toBe(200);
		const read = await response.json();
		expect(read.items[0].ok).toBe(true);
		expect(read.items[0].value.text).toContain("alpha");
		expect(read.items[0].value.evidence.startLine).toBe(1);
		const after = await (
			await server.request(`/api/ai/evidence/${id}/map`)
		).json();
		expect(after.coverage.returnedLines).toBeGreaterThan(0);
	});

	it("searches for positions without returning content", async () => {
		const { server, id } = await captured();
		const response = await server.request(`/api/ai/evidence/${id}/search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "bravo" }),
		});
		const found = await response.json();
		expect(found.matches[0]).toMatchObject({ line: 2 });
		expect(JSON.stringify(found)).not.toContain("bravo\n");
	});

	it("reports an unknown capture as missing", async () => {
		const server = await app();
		const response = await server.request("/api/ai/evidence/nope/map");
		expect(response.status).toBe(404);
	});

	it("reports a pinned revision mismatch as stale", async () => {
		const { server, id } = await captured();
		const response = await server.request(
			`/api/ai/evidence/${id}/map?revision=not-the-captured-one`,
		);
		expect(response.status).toBe(409);
	});

	it.each([
		{ label: "a non-array batch", body: { requests: "all" } },
		{ label: "a non-integer range", body: { requests: [{ key: "a", startLine: 1.5, endLine: 2 }] } },
		{ label: "a missing key", body: { requests: [{ startLine: 1, endLine: 2 }] } },
	])("rejects $label", async ({ body }) => {
		const { server, id } = await captured();
		const response = await server.request(`/api/ai/evidence/${id}/read`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(400);
	});

	it("rejects a search without a query", async () => {
		const { server, id } = await captured();
		const response = await server.request(`/api/ai/evidence/${id}/search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: "a" }),
		});
		expect(response.status).toBe(400);
	});
});

describe("AI evidence symbol endpoint", () => {
	async function capturedPlan() {
		const plans = new InMemoryPlanStore();
		const plan = await plans.upsert({ title: "Stored", body: "alpha\nbravo" });
		const server = await app(
			vi.fn(async (_request, _signal, onEvent) => {
				await onEvent({ type: "text-delta", text: "ok" });
				return "ok";
			}),
			plans,
		);
		const run = await server.request("/api/ai/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				trigger: "user",
				conversationId: "plan",
				modelId: "codex/subscription/codex/gpt-test",
				action: "critique-plan",
				surface: "plan",
				context: { kind: "plan", planId: plan.id, version: 1, title: "client" },
			}),
		});
		expect(run.status).toBe(200);
		await run.text();
		const listed = await (await server.request("/api/ai/evidence")).json();
		return { server, id: listed.snapshots[0].id as string };
	}

	it("reports unavailable when no language server is configured", async () => {
		const { server, id } = await capturedPlan();
		const map = await (await server.request(`/api/ai/evidence/${id}/map`)).json();
		const response = await server.request(`/api/ai/evidence/${id}/symbols`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				key: map.sources[0].key,
				line: 1,
				character: 0,
				kind: "definitions",
			}),
		});
		expect(response.status).toBe(200);
		const result = await response.json();
		// Unavailable is not the same as "no references"; it must say so.
		expect(result.locations).toEqual([]);
		expect(result.unavailable).toBeTruthy();
	});

	it.each([
		{ label: "an unknown kind", body: { line: 1, character: 0, kind: "all" } },
		{ label: "a zero line", body: { line: 0, character: 0, kind: "definitions" } },
		{ label: "a negative character", body: { line: 1, character: -1, kind: "definitions" } },
		{ label: "an unknown source key", body: { key: "no-such-source", line: 1, character: 0, kind: "definitions" } },
		{ label: "an omitted key", body: { line: 1, character: 0, kind: "definitions" }, omitKey: true },
	])("rejects $label", async ({ body, omitKey }) => {
		const { server, id } = await capturedPlan();
		const map = await (await server.request(`/api/ai/evidence/${id}/map`)).json();
		const payload =
			omitKey || "key" in body
				? body
				: { key: map.sources[0].key as string, ...body };
		const response = await server.request(`/api/ai/evidence/${id}/symbols`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		// An unknown key is a missing capture source; the rest are malformed.
		expect([400, 404]).toContain(response.status);
	});

	it("reports an unknown capture as missing", async () => {
		const server = await app();
		const response = await server.request("/api/ai/evidence/nope/symbols", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: "a", line: 1, character: 0, kind: "definitions" }),
		});
		expect(response.status).toBe(404);
	});
});
