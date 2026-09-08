import { describe, expect, it, vi } from "vitest";
import { AiService } from "../service.js";
import type { AiBackendAdapter, AiRunRequest } from "../types.js";

function createAdapter(run = vi.fn(async () => "answer")): AiBackendAdapter {
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

function request(): AiRunRequest {
	return {
		trigger: "user",
		conversationId: "conversation-1",
		modelId: "codex/subscription/codex/gpt-test",
		surface: "diff",
		action: "ask",
		prompt: "Why?",
		context: { kind: "diff", patch: "+change" },
	};
}

describe("AiService", () => {
	it("rejects non-user-triggered inference before invoking an adapter", async () => {
		const run = vi.fn(async () => "answer");
		const service = new AiService([createAdapter(run)]);
		await expect(
			service.run({ ...request(), trigger: "background" as "user" }, vi.fn()),
		).rejects.toThrow("explicit user trigger");
		expect(run).not.toHaveBeenCalled();
	});

	it("normalizes start and completion events", async () => {
		const service = new AiService([createAdapter()]);
		const events: string[] = [];
		const text = await service.run(request(), (event) => {
			events.push(event.type);
		});
		expect(text).toBe("answer");
		expect(events).toEqual(["start", "complete"]);
	});

	it("releases the conversation when the start event fails", async () => {
		const run = vi.fn(async () => "answer");
		const service = new AiService([createAdapter(run)]);
		let capturedRunId!: string;
		await expect(
			service.run(request(), (event) => {
				if (event.type === "start") {
					capturedRunId = event.runId;
					throw new Error("sink unavailable");
				}
			}),
		).rejects.toThrow("AI event delivery failed");
		expect(run).not.toHaveBeenCalled();
		expect(service.cancel(capturedRunId)).toBe(false);
		await expect(service.run(request(), vi.fn())).resolves.toBe("answer");
	});

	it("cancelling from the start callback rejects without invoking the adapter", async () => {
		const run = vi.fn(async () => "answer");
		const service = new AiService([createAdapter(run)]);
		let capturedRunId!: string;
		const events: string[] = [];
		await expect(
			service.run(request(), (event) => {
				events.push(event.type);
				if (event.type === "start") {
					capturedRunId = event.runId;
					service.cancel(event.runId);
				}
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(run).not.toHaveBeenCalled();
		expect(events).toEqual(["start"]);
		expect(service.cancel(capturedRunId)).toBe(false);
		await expect(service.run(request(), vi.fn())).resolves.toBe("answer");
	});

	it("does not complete when an adapter cancels its run before resolving", async () => {
		let service!: AiService;
		let capturedRunId!: string;
		const events: string[] = [];
		const run = vi.fn(async () => {
			service.cancel(capturedRunId);
			return "answer";
		});
		service = new AiService([createAdapter(run)]);
		await expect(
			service.run(request(), (event) => {
				capturedRunId = event.type === "start" ? event.runId : capturedRunId;
				events.push(event.type);
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(events).toEqual(["start"]);
		await expect(service.run(request(), vi.fn())).resolves.toBe("answer");
	});

	it("releases the conversation when prompt construction fails", async () => {
		const run = vi.fn(async () => "answer");
		const service = new AiService([createAdapter(run)]);
		const context = { kind: "diff" as const };
		Object.defineProperty(context, "patch", {
			get: () => {
				throw new Error("context unavailable");
			},
		});
		await expect(service.run({ ...request(), context }, vi.fn())).rejects.toThrow(
			"AI request preparation failed",
		);
		await expect(service.run(request(), vi.fn())).resolves.toBe("answer");
	});

	it.each(["", " \n\t"])(
		"rejects empty output %j without completing",
		async (text) => {
			const run = vi.fn(async () => text);
			const service = new AiService([createAdapter(run)]);
			const events: string[] = [];
			await expect(
				service.run(request(), (event) => {
					events.push(event.type);
				}),
			).rejects.toThrow("returned no text");
			expect(events).toEqual(["start"]);
			run.mockResolvedValue("answer");
			await expect(service.run(request(), vi.fn())).resolves.toBe("answer");
		},
	);

	it("allows only one active run per conversation", async () => {
		let release!: () => void;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const adapter = createAdapter(
			vi.fn(async () => {
				await wait;
				return "done";
			}),
		);
		const service = new AiService([adapter]);
		const first = service.run(request(), vi.fn());
		await expect(service.run(request(), vi.fn())).rejects.toThrow(
			"already running",
		);
		release();
		await expect(first).resolves.toBe("done");
	});

	it("rejects images for adapters without a supported transport", async () => {
		const service = new AiService([createAdapter()]);
		await expect(
			service.run(
				{
					...request(),
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
				vi.fn(),
			),
		).rejects.toThrow("cannot receive image attachments");
	});

	it("deduplicates short-lived model and connection discovery", async () => {
		const connection = vi.fn(async () => ({
			id: "codex" as const,
			label: "Codex",
			status: "connected" as const,
			runtimeAvailable: true,
			credentialRoutes: ["subscription" as const],
			activeRoutes: ["subscription" as const],
		}));
		const models = vi.fn(async () => [
			{
				id: "codex/subscription/codex/gpt-test",
				sourceId: "codex" as const,
				credentialRoute: "subscription" as const,
				providerId: "codex",
				modelId: "gpt-test",
				displayName: "GPT Test",
			},
		]);
		const service = new AiService([{ ...createAdapter(), connection, models }]);
		await Promise.all([
			service.connections(),
			service.connections(),
			service.models(),
			service.models(),
		]);
		expect(connection).toHaveBeenCalledTimes(1);
		expect(models).toHaveBeenCalledTimes(1);
	});
});
