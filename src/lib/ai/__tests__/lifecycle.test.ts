import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiService } from "../service.js";
import type { AiBackendAdapter, AiRunRequest } from "../types.js";

const request = (conversationId = "conversation-1"): AiRunRequest => ({
	trigger: "user",
	conversationId,
	modelId: "codex/subscription/codex/test",
	surface: "diff",
	action: "ask",
	prompt: "Why?",
	context: { kind: "diff", patch: "+change" },
});
function adapter(
	run: AiBackendAdapter["run"] = async () => "answer",
): AiBackendAdapter {
	return {
		id: "codex",
		connection: async () => ({
			id: "codex",
			label: "fixture",
			status: "connected",
			runtimeAvailable: true,
			credentialRoutes: ["subscription"],
			activeRoutes: ["subscription"],
		}),
		models: async () => [],
		run,
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const observe = (promise: Promise<string>) =>
	promise.then(
		() => null,
		(error: unknown) => error,
	);
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("AI lifecycle policy", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		const timers = vi.getTimerCount();
		vi.useRealTimers();
		expect(timers).toBe(0);
	});

	it("times out a hung start sink without invoking the provider", async () => {
		const delivery = deferred<void>();
		const run = vi.fn(async () => "answer");
		const service = new AiService([adapter(run)], undefined, {
			preparationMs: 10,
		});
		let runId = "";
		const result = observe(
			service.run(request(), (event) => {
				if (event.type === "start") runId = event.runId;
				return delivery.promise;
			}),
		);
		await vi.advanceTimersByTimeAsync(10);
		expect(await result).toMatchObject({ code: "preparation_timeout" });
		expect(run).not.toHaveBeenCalled();
		expect(service.cancel(runId)).toBe(true);
		delivery.resolve();
		await flush();
		expect(service.cancel(runId)).toBe(false);
	});

	it.each(["first_event", "idle"] as const)(
		"enforces the %s deadline",
		async (stage) => {
			const execution = deferred<string>();
			const service = new AiService(
				[
					adapter(async (_request, _signal, emit) => {
						if (stage === "idle") await emit({ type: "text-delta", text: "a" });
						return execution.promise;
					}),
				],
				undefined,
				{ firstEventMs: 10, idleMs: 10 },
			);
			const result = observe(service.run(request(), vi.fn()));
			await vi.advanceTimersByTimeAsync(10);
			expect(await result).toMatchObject({ code: `${stage}_timeout` });
			execution.resolve("done");
			await flush();
		},
	);

	it("enforces the total deadline despite continuing provider activity", async () => {
		const execution = deferred<string>();
		let interval!: ReturnType<typeof setInterval>;
		const service = new AiService(
			[
				adapter(async (_request, _signal, emit) => {
					interval = setInterval(() => {
						void emit({ type: "text-delta", text: "a" });
					}, 5);
					return execution.promise;
				}),
			],
			undefined,
			{ totalMs: 25, firstEventMs: 10, idleMs: 10 },
		);
		const result = observe(service.run(request(), vi.fn()));
		await vi.advanceTimersByTimeAsync(25);
		expect(await result).toMatchObject({ code: "total_timeout" });
		clearInterval(interval);
		execution.resolve("done");
		await flush();
	});

	it.each(["start", "text-delta", "complete"] as const)(
		"classifies %s sink failures without raw details",
		async (type) => {
			const service = new AiService([
				adapter(async (_request, _signal, emit) => {
					await emit({ type: "text-delta", text: "a" });
					return "answer";
				}),
			]);
			const error = await observe(
				service.run(request(), (event) => {
					if (event.type === type) throw new Error("synthetic secret");
				}),
			);
			expect(error).toMatchObject({ code: "delivery_failed" });
			expect(String(error)).not.toContain("synthetic secret");
		},
	);

	it.each([false, true])(
		"bounds UTF-8 output bytes (delta=%s)",
		async (delta) => {
			const service = new AiService(
				[
					adapter(async (_request, _signal, emit) => {
						if (delta) await emit({ type: "text-delta", text: "éé" });
						return "éé";
					}),
				],
				undefined,
				{ maxOutputBytes: 3 },
			);
			await expect(service.run(request(), vi.fn())).rejects.toMatchObject({
				code: "resource_limit",
			});
		},
	);

	it("rejects provider-forged terminal events", async () => {
		const sink = vi.fn();
		const service = new AiService([
			adapter(async (_request, _signal, emit) => {
				await emit({ type: "complete", text: "forged" });
				return "answer";
			}),
		]);
		await expect(service.run(request(), sink)).rejects.toMatchObject({
			code: "protocol_error",
		});
		expect(sink).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "complete" }),
		);
	});

	it("bounds unawaited event bursts and stops queued delivery after overflow", async () => {
		const delivery = deferred<void>();
		const execution = deferred<string>();
		let emit!: Parameters<AiBackendAdapter["run"]>[2];
		const seen: string[] = [];
		const service = new AiService(
			[
				adapter(async (_request, _signal, callback) => {
					emit = callback;
					return execution.promise;
				}),
			],
			undefined,
			{ maxPendingEvents: 2 },
		);
		const result = observe(
			service.run(request(), (event) => {
				seen.push(event.type);
				if (event.type === "text-delta") return delivery.promise;
			}),
		);
		await flush();
		void emit({ type: "text-delta", text: "a" });
		await flush();
		void emit({ type: "text-delta", text: "b" });
		void emit({ type: "text-delta", text: "c" });
		expect(await result).toMatchObject({ code: "resource_limit" });
		delivery.resolve();
		execution.resolve("done");
		await flush();
		expect(seen).toEqual(["start", "text-delta"]);
	});

	it("bounds event counts", async () => {
		const service = new AiService(
			[
				adapter(async (_request, _signal, emit) => {
					await emit({ type: "text-delta", text: "a" });
					await emit({ type: "text-delta", text: "b" });
					return "ab";
				}),
			],
			undefined,
			{ maxEvents: 2 },
		);
		await expect(service.run(request(), vi.fn())).rejects.toMatchObject({
			code: "resource_limit",
		});
	});

	it("bounds individual warning events", async () => {
		const service = new AiService(
			[
				adapter(async (_request, _signal, emit) => {
					await emit({ type: "warning", message: "x".repeat(300) });
					return "answer";
				}),
			],
			undefined,
			{ maxEventBytes: 200 },
		);
		await expect(service.run(request(), vi.fn())).rejects.toMatchObject({
			code: "resource_limit",
		});
	});

	it.each([{ maxConcurrent: 1 }, { maxConcurrent: 3, maxPerSource: 1 }])(
		"bounds capacity %j",
		async (policy) => {
			const execution = deferred<string>();
			const run = vi.fn(() => execution.promise);
			const service = new AiService([adapter(run)], undefined, policy);
			const first = service.run(request("a"), vi.fn());
			await expect(service.run(request("b"), vi.fn())).rejects.toMatchObject({
				code: "capacity",
			});
			execution.resolve("done");
			await first;
			expect(run).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps a timed-out slot until the provider settles, then permits a new run", async () => {
		const execution = deferred<string>();
		let emit!: Parameters<AiBackendAdapter["run"]>[2];
		let runId = "";
		const run = vi.fn<AiBackendAdapter["run"]>(
			async (_request, _signal, callback) => {
				emit = callback;
				return execution.promise;
			},
		);
		const service = new AiService([adapter(run)], undefined, {
			totalMs: 10,
			maxConcurrent: 1,
		});
		const result = observe(
			service.run(request(), (event) => {
				if (event.type === "start") runId = event.runId;
			}),
		);
		await vi.advanceTimersByTimeAsync(10);
		expect(await result).toMatchObject({ code: "total_timeout" });
		expect(service.cancel(runId)).toBe(true);
		await expect(service.run(request(), vi.fn())).rejects.toThrow(
			"already running",
		);
		await expect(service.run(request("other"), vi.fn())).rejects.toMatchObject({
			code: "capacity",
		});
		await expect(
			emit({ type: "text-delta", text: "late" }),
		).rejects.toMatchObject({ code: "total_timeout" });
		execution.resolve("answer");
		await flush();
		expect(service.cancel(runId)).toBe(false);
		run.mockResolvedValue("next");
		await expect(service.run(request(), vi.fn())).resolves.toBe("next");
	});

	it.each([false, true])(
		"never retries or switches providers after failure (partial=%s)",
		async (partial) => {
			const run = vi.fn<AiBackendAdapter["run"]>(async (input, _signal, emit) => {
				expect(input.modelId).toBe(request().modelId);
				if (partial) await emit({ type: "text-delta", text: "part" });
				throw new Error("provider detail");
			});
			const alternate = {
				...adapter(),
				id: "claude" as const,
				run: vi.fn(async () => "alternate"),
			};
			const sink = vi.fn();
			const service = new AiService([adapter(run), alternate]);
			const error = await observe(service.run(request(), sink));
			expect(error).toMatchObject({
				code: "provider_failed",
				automaticRetryAllowed: false,
			});
			expect(String(error)).not.toContain("provider detail");
			expect(run).toHaveBeenCalledTimes(1);
			expect(alternate.run).not.toHaveBeenCalled();
			expect(sink).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: "complete" }),
			);
		},
	);

	it("rejects late events after successful completion", async () => {
		let emit!: Parameters<AiBackendAdapter["run"]>[2];
		const service = new AiService([
			adapter(async (_request, _signal, callback) => {
				emit = callback;
				return "answer";
			}),
		]);
		const sink = vi.fn();
		await service.run(request(), sink);
		await expect(
			emit({ type: "text-delta", text: "late" }),
		).rejects.toMatchObject({ code: "protocol_error" });
		expect(sink).toHaveBeenCalledTimes(2);
	});
});
