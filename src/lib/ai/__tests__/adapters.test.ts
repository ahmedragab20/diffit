import { describe, expect, it, vi } from "vitest";
import { execPath } from "node:process";
import {
	createDefaultAdapters,
	DirectProviderAdapter,
	RuntimeAdapter,
} from "../adapters.js";
import type { SecretStore } from "../secrets.js";
import type { AiRunRequest } from "../types.js";

function secrets(value: string | null = "secret-key"): SecretStore {
	return {
		get: vi.fn(async () => value),
		set: vi.fn(async () => "session" as const),
		delete: vi.fn(async () => {}),
	};
}

describe("DirectProviderAdapter", () => {
	it("does not read secrets or fetch after pre-abort", async () => {
		const store = secrets();
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const adapter = new DirectProviderAdapter(
			{
				id: "openai",
				label: "OpenAI",
				baseUrl: "https://api.test",
				envKey: "DIFFING_TEST_OPENAI_KEY",
			},
			store,
			fetchImpl,
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			adapter.run(
				{
					trigger: "user",
					conversationId: "abort",
					modelId: "openai/direct-key/openai/test",
					surface: "diff",
					action: "ask",
					prompt: "x",
					context: { kind: "diff" },
				},
				controller.signal,
				vi.fn(),
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(store.get).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("does not fetch when cancellation resolves a deferred key lookup", async () => {
		let resolve!: (value: string | null) => void;
		const get = vi.fn(
			() =>
				new Promise<string | null>((r) => {
					resolve = r;
				}),
		);
		const store = { ...secrets(), get };
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const adapter = new DirectProviderAdapter(
			{
				id: "openai",
				label: "OpenAI",
				baseUrl: "https://api.test",
				envKey: "DIFFING_TEST_OPENAI_KEY",
			},
			store,
			fetchImpl,
		);
		const controller = new AbortController();
		const pending = adapter.run(
			{
				trigger: "user",
				conversationId: "deferred",
				modelId: "openai/direct-key/openai/test",
				surface: "diff",
				action: "ask",
				prompt: "x",
				context: { kind: "diff" },
			},
			controller.signal,
			vi.fn(),
		);
		await vi.waitFor(() => expect(get).toHaveBeenCalled());
		controller.abort();
		resolve("key");
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([
		[401, "authentication_failed"],
		[429, "rate_limited"],
		[500, "provider_failed"],
	] as const)(
		"classifies HTTP %s without exposing an error body",
		async (status, code) => {
			let canceled = false;
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new TextEncoder().encode("synthetic raw body"));
				},
				cancel() {
					canceled = true;
				},
			});
			const fetchImpl = vi.fn(
				async () => new Response(body, { status }),
			) as unknown as typeof fetch;
			const adapter = new DirectProviderAdapter(
				{
					id: "openai",
					label: "OpenAI",
					baseUrl: "https://api.test",
					envKey: "DIFFING_TEST_OPENAI_KEY",
				},
				secrets(),
				fetchImpl,
			);
			const error = await adapter
				.run(
					{
						trigger: "user",
						conversationId: `http-${status}`,
						modelId: "openai/direct-key/openai/test",
						surface: "diff",
						action: "ask",
						prompt: "x",
						context: { kind: "diff" },
					},
					new AbortController().signal,
					vi.fn(),
				)
				.catch((e) => e);
			expect(error).toMatchObject({ code });
			expect(String(error)).not.toContain("synthetic raw body");
			expect(canceled).toBe(true);
		},
	);
	it("offers Grok as the only direct-key provider", async () => {
		const adapters = createDefaultAdapters(secrets());
		expect(adapters.map((adapter) => adapter.id)).toEqual([
			"codex",
			"claude",
			"opencode",
			"cursor",
			"xai",
		]);
		expect(await adapters.at(-1)?.connection()).toMatchObject({
			id: "xai",
			label: "Grok",
		});
	});

	it("discovers account models without exposing the key in connection state", async () => {
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				expect((init?.headers as Record<string, string>).authorization).toBe(
					"Bearer secret-key",
				);
				return new Response(
					JSON.stringify({
						data: [{ id: "gpt-text" }, { id: "text-embedding-3-small" }],
					}),
					{ status: 200 },
				);
			},
		) as unknown as typeof fetch;
		const adapter = new DirectProviderAdapter(
			{
				id: "openai",
				label: "OpenAI",
				baseUrl: "https://api.test",
				envKey: "DIFFING_TEST_OPENAI_KEY",
			},
			secrets(),
			fetchImpl,
		);
		const connection = await adapter.connection();
		expect(JSON.stringify(connection)).not.toContain("secret-key");
		const models = await adapter.models();
		expect(models.map((model) => model.modelId)).toEqual(["gpt-text"]);
	});

	it("rejects unsupported direct-provider effort and investigation before secrets or fetch", async () => {
		const store = secrets();
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const adapter = new DirectProviderAdapter(
			{
				id: "xai",
				label: "xAI",
				baseUrl: "https://api.test",
				envKey: "DIFFING_TEST_XAI_KEY",
			},
			store,
			fetchImpl,
		);
		const base: AiRunRequest = {
			trigger: "user",
			conversationId: "unsupported",
			modelId: "xai/direct-key/xai/test",
			surface: "diff",
			action: "ask",
			context: { kind: "diff" },
		};
		await expect(
			adapter.run(
				{ ...base, reasoningEffort: "low" },
				new AbortController().signal,
				vi.fn(),
			),
		).rejects.toMatchObject({ code: "unsupported_capability" });
		await expect(
			adapter.run(
				{ ...base, mode: "investigate" },
				new AbortController().signal,
				vi.fn(),
			),
		).rejects.toMatchObject({ code: "unsupported_capability" });
		expect(store.get).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([
		[{ data: [{ id: "grok-image", input_modalities: ["text", "image"] }] }, true],
		[{ data: [{ id: "grok-text" }] }, false],
	] as const)(
		"derives xAI image support from provider metadata",
		async (payload, supportsImages) => {
			const fetchImpl = vi.fn(
				async () => new Response(JSON.stringify(payload), { status: 200 }),
			) as unknown as typeof fetch;
			const adapter = new DirectProviderAdapter(
				{
					id: "xai",
					label: "xAI",
					baseUrl: "https://api.test",
					envKey: "DIFFING_TEST_XAI_KEY",
				},
				secrets(),
				fetchImpl,
			);
			const models = await adapter.models();
			expect(models[0]?.supportsImages).toBe(supportsImages);
		},
	);

	it("classifies a runnable version with an authentication-error status as needs-configuration", async () => {
		const adapter = new RuntimeAdapter({
			id: "codex",
			label: "Codex",
			bin: execPath,
			versionArgs: ["-e", "process.stdout.write('1.0')"],
			statusArgs: [
				"-e",
				"process.stdout.write('synthetic auth error'); process.exitCode = 1",
			],
			routes: ["subscription"],
			setup: { subscription: "codex login" },
			args: () => [],
		});
		expect(await adapter.connection()).toMatchObject({
			status: "needs-configuration",
			runtimeAvailable: true,
			activeRoutes: [],
		});
	});

	it("keeps a direct key session-only when remember is false", async () => {
		const store = secrets(null);
		const adapter = new DirectProviderAdapter(
			{
				id: "xai",
				label: "xAI",
				baseUrl: "https://api.test",
				envKey: "DIFFING_TEST_XAI_KEY",
			},
			store,
			vi.fn() as unknown as typeof fetch,
		);
		await adapter.connectKey("xai-key", false);
		expect(store.set).toHaveBeenCalledWith("xai", "xai-key", false);
	});

	it.each([
		["openai", "response.output_text.delta"],
		["xai", "response.output_text.delta"],
		["anthropic", "content_block_delta"],
	] as const)("streams every %s text delta", async (source, eventType) => {
		const events =
			source === "anthropic"
				? [
						{ type: eventType, delta: { type: "text_delta", text: "# Heading\n" } },
						{ type: eventType, delta: { type: "text_delta", text: "Body" } },
					]
				: [
						{ type: eventType, delta: "# Heading\n" },
						{ type: eventType, delta: "Body" },
					];
		const terminal =
			source === "anthropic"
				? [
						{ type: "message_delta", delta: { stop_reason: "end_turn" } },
						{ type: "message_stop" },
					]
				: [{ type: "response.completed", response: { status: "completed" } }];
		const sse = [...events, ...terminal]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("");
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				expect(JSON.parse(String(init?.body)).stream).toBe(true);
				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		) as unknown as typeof fetch;
		const adapter = new DirectProviderAdapter(
			{
				id: source,
				label: source,
				baseUrl: "https://api.test",
				envKey: `DIFFING_TEST_${source.toUpperCase()}_KEY`,
			},
			secrets(),
			fetchImpl,
		);
		const deltas: string[] = [];
		const request: AiRunRequest = {
			trigger: "user",
			conversationId: "c1",
			modelId: `${source}/direct-key/${source}/model`,
			surface: "diff",
			action: "ask",
			prompt: "Question",
			context: { kind: "diff" },
		};
		const text = await adapter.run(
			request,
			new AbortController().signal,
			(event) => {
				if (event.type === "text-delta") deltas.push(event.text);
			},
		);
		expect(deltas).toEqual(["# Heading\n", "Body"]);
		expect(text).toBe("# Heading\nBody");
	});

	it("sends resolved images as multimodal Responses input", async () => {
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body));
				expect(body.input[0].content).toEqual([
					{ type: "input_text", text: "Question" },
					{
						type: "input_image",
						image_url: "data:image/png;base64,cG5n",
						detail: "auto",
					},
				]);
				return new Response(
					[
						{ type: "response.output_text.delta", delta: "Seen" },
						{ type: "response.completed", response: { status: "completed" } },
					]
						.map((event) => `data: ${JSON.stringify(event)}\n\n`)
						.join(""),
					{ status: 200 },
				);
			},
		) as unknown as typeof fetch;
		const adapter = new DirectProviderAdapter(
			{
				id: "xai",
				label: "xAI",
				baseUrl: "https://api.test",
				envKey: "DIFFING_TEST_XAI_KEY",
			},
			secrets(),
			fetchImpl,
		);
		vi.spyOn(adapter, "models").mockResolvedValue([
			{
				id: "xai/direct-key/xai/grok",
				sourceId: "xai",
				credentialRoute: "direct-key",
				providerId: "xai",
				modelId: "grok",
				displayName: "Grok",
				supportsImages: true,
				catalogSource: "provider",
			},
		]);
		await adapter.run(
			{
				trigger: "user",
				conversationId: "c-image",
				modelId: "xai/direct-key/xai/grok",
				surface: "diff",
				action: "ask",
				prompt: "Question",
				context: { kind: "diff" },
				resolvedImages: [
					{
						url: "/api/attachments/pasted_image_a.png",
						name: "a.png",
						mimeType: "image/png",
						absolutePath: "/tmp/a.png",
						dataUrl: "data:image/png;base64,cG5n",
					},
				],
			},
			new AbortController().signal,
			vi.fn(),
		);
	});

	it.each([
		[
			"response.failed",
			{ type: "response.failed", response: { status: "failed" } },
		],
		[
			"response.incomplete",
			{ type: "response.incomplete", response: { status: "incomplete" } },
		],
		[
			"provider error",
			{ type: "error", error: { message: "private-provider-detail" } },
		],
		["EOF", null],
		["DONE", "[DONE]"],
		["malformed JSON", "{"],
		["null JSON", "null"],
		[
			"incomplete completed response",
			{ type: "response.completed", response: { status: "incomplete" } },
		],
	] as const)("rejects after a delta for %s", async (_name, terminal) => {
		const delta = JSON.stringify({
			type: "response.output_text.delta",
			delta: "partial",
		});
		const terminalFrame =
			terminal === null
				? ""
				: typeof terminal === "string"
					? terminal
					: JSON.stringify(terminal);
		const completion =
			terminal === null || terminal === "[DONE]"
				? ""
				: `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`;
		const body = `data: ${delta}\n\n${terminal === null ? "" : `data: ${terminalFrame}\n\n`}${completion}`;
		const fetchImpl = vi.fn(
			async () => new Response(body, { status: 200 }),
		) as unknown as typeof fetch;
		const adapter = new DirectProviderAdapter(
			{
				id: "openai",
				label: "OpenAI",
				baseUrl: "https://api.test",
				envKey: "DIFFING_TEST_OPENAI_KEY",
			},
			secrets(),
			fetchImpl,
		);
		const deltas: string[] = [];
		const error = await adapter
			.run(
				{
					trigger: "user",
					conversationId: "negative",
					modelId: "openai/direct-key/openai/test",
					surface: "diff",
					action: "ask",
					prompt: "Question",
					context: { kind: "diff" },
				},
				new AbortController().signal,
				(event) => {
					if (event.type === "text-delta") deltas.push(event.text);
				},
			)
			.then(
				() => null,
				(reason) => reason,
			);
		expect(error).toBeInstanceOf(Error);
		expect(deltas).toEqual(["partial"]);
		expect(String(error)).not.toContain("private-provider-detail");
	});

	it.each([
		"max_tokens",
		"tool_use",
		"pause_turn",
		"model_context_window_exceeded",
		null,
	] as const)("rejects Anthropic stop reason %s", async (stopReason) => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					[
						{
							type: "content_block_delta",
							delta: { type: "text_delta", text: "partial" },
						},
						...(stopReason
							? [{ type: "message_delta", delta: { stop_reason: stopReason } }]
							: []),
						{ type: "message_stop" },
					]
						.map((event) => `data: ${JSON.stringify(event)}\n\n`)
						.join(""),
					{ status: 200 },
				),
		) as unknown as typeof fetch;
		const adapter = new DirectProviderAdapter(
			{
				id: "anthropic",
				label: "Anthropic",
				baseUrl: "https://api.test",
				envKey: "DIFFING_TEST_ANTHROPIC_KEY",
			},
			secrets(),
			fetchImpl,
		);
		await expect(
			adapter.run(
				{
					trigger: "user",
					conversationId: "anthropic-negative",
					modelId: "anthropic/direct-key/anthropic/test",
					surface: "diff",
					action: "ask",
					prompt: "Question",
					context: { kind: "diff" },
				},
				new AbortController().signal,
				vi.fn(),
			),
		).rejects.toThrow();
	});

	it.each(["end_turn", "stop_sequence"] as const)(
		"accepts Anthropic %s",
		async (stopReason) => {
			const fetchImpl = vi.fn(
				async () =>
					new Response(
						[
							{
								type: "content_block_delta",
								delta: { type: "text_delta", text: "answer" },
							},
							{ type: "message_delta", delta: { stop_reason: stopReason } },
							{ type: "message_stop" },
						]
							.map((event) => `data: ${JSON.stringify(event)}\n\n`)
							.join(""),
						{ status: 200 },
					),
			) as unknown as typeof fetch;
			const adapter = new DirectProviderAdapter(
				{
					id: "anthropic",
					label: "Anthropic",
					baseUrl: "https://api.test",
					envKey: "DIFFING_TEST_ANTHROPIC_KEY",
				},
				secrets(),
				fetchImpl,
			);
			await expect(
				adapter.run(
					{
						trigger: "user",
						conversationId: "anthropic-positive",
						modelId: "anthropic/direct-key/anthropic/test",
						surface: "diff",
						action: "ask",
						prompt: "Question",
						context: { kind: "diff" },
					},
					new AbortController().signal,
					vi.fn(),
				),
			).resolves.toBe("answer");
		},
	);

	it("bounds aggregate streamed output and cancels the body", async () => {
		let canceled = false;
		const chunk = "x".repeat(512 * 1024);
		const payload = Array.from({ length: 9 }, () => ({
			type: "response.output_text.delta",
			delta: chunk,
		}));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						payload.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
					),
				);
			},
			cancel() {
				canceled = true;
			},
		});
		const fetchImpl = vi.fn(
			async () => new Response(body, { status: 200 }),
		) as unknown as typeof fetch;
		const adapter = new DirectProviderAdapter(
			{
				id: "openai",
				label: "OpenAI",
				baseUrl: "https://api.test",
				envKey: "DIFFING_TEST_OPENAI_KEY",
			},
			secrets(),
			fetchImpl,
		);
		const deltas: string[] = [];
		await expect(
			adapter.run(
				{
					trigger: "user",
					conversationId: "aggregate",
					modelId: "openai/direct-key/openai/test",
					surface: "diff",
					action: "ask",
					prompt: "Question",
					context: { kind: "diff" },
				},
				new AbortController().signal,
				(event) => {
					if (event.type === "text-delta") deltas.push(event.text);
				},
			),
		).rejects.toMatchObject({ code: "resource_limit" });
		expect(deltas.length).toBeLessThanOrEqual(8);
		expect(canceled).toBe(true);
	});
});
