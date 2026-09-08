// @vitest-environment node
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { AiService } from "../service.js";
import { AiRunError } from "../lifecycle.js";
import { AiSnapshotError } from "../snapshots.js";
import type { AiBackendAdapter, AiRunRequest } from "../types.js";

const policy = {
	preparationMs: 10,
	totalMs: 1000,
	firstEventMs: 100,
	idleMs: 100,
	maxConcurrent: 1,
	maxPerSource: 1,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function request(overrides: Partial<AiRunRequest> = {}): AiRunRequest {
	return {
		trigger: "user",
		conversationId: "conversation-1",
		modelId: "codex/subscription/codex/gpt-test",
		surface: "diff",
		action: "ask",
		prompt: "Why?",
		context: { kind: "diff", patch: "+change" },
		...overrides,
	};
}

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

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("AiService preparation admission", () => {
	it("admits before preparation, reserves capacity, and runs exactly once", async () => {
		const run = vi.fn(async () => "answer");
		const service = new AiService([createAdapter(run)], undefined, policy);
		const prep = vi.fn(async () => request({ prompt: "prepared" }));
		const tokenPromise = service.prepareRun(request(), prep);
		expect(prep).not.toHaveBeenCalled();
		await flush();
		expect(prep).toHaveBeenCalledTimes(1);
		expect(run).not.toHaveBeenCalled();
		const blocked = service.prepareRun(request({ conversationId: "conversation-2" }), vi.fn());
		await expect(blocked).rejects.toMatchObject({ code: "capacity" });
		const token = await tokenPromise;
		const events: string[] = [];
		await expect(service.runPrepared(token, (event) => { events.push(event.type); })).resolves.toBe("answer");
		expect(events).toEqual(["start", "complete"]);
		expect(run).toHaveBeenCalledTimes(1);
		await expect(service.run(request({ conversationId: "conversation-2" }), vi.fn())).resolves.toBe("answer");
	});

	it("rejects duplicate or forged tokens and same-conversation admission", async () => {
		const run = vi.fn(async () => "answer");
		const service = new AiService([createAdapter(run)], undefined, policy);
		const token = await service.prepareRun(request());
		await expect(service.runPrepared(token, vi.fn())).resolves.toBe("answer");
		await expect(service.runPrepared(token, vi.fn())).rejects.toMatchObject({ code: "request_rejected" });
		await expect(service.runPrepared({ runId: token.runId }, vi.fn())).rejects.toMatchObject({ code: "request_rejected" });
		expect(run).toHaveBeenCalledTimes(1);
		const pending = service.prepareRun(request({ conversationId: "same" }), async () => request({ conversationId: "same" }));
		await expect(service.prepareRun(request({ conversationId: "same" }), async () => request({ conversationId: "same" }))).rejects.toThrow();
		const sameToken = await pending;
		expect(service.cancel(sameToken.runId)).toBe(true);
	});

	it("times out preparation, retains noncooperative capacity, and releases after settlement", async () => {
		const callback = deferred<AiRunRequest>();
		const prep = vi.fn((signal: AbortSignal) => {
			signal.addEventListener("abort", () => undefined);
			return callback.promise;
		});
		const run = vi.fn(async () => "answer");
		const service = new AiService([createAdapter(run)], undefined, policy);
		const failed = service.prepareRun(request(), prep);
		const assertion = expect(failed).rejects.toMatchObject({ code: "preparation_timeout" });
		await flush();
		expect(prep).toHaveBeenCalledTimes(1);
		const blockedBeforeTimeoutCallback = vi.fn();
		await expect(service.prepareRun(request({ conversationId: "before-timeout" }), blockedBeforeTimeoutCallback)).rejects.toMatchObject({ code: "capacity" });
		expect(blockedBeforeTimeoutCallback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(10);
		await assertion;
		expect(prep.mock.calls[0]?.[0].aborted).toBe(true);
		expect((prep.mock.calls[0]?.[0].reason as AiRunError).code).toBe("preparation_timeout");
		expect(run).not.toHaveBeenCalled();
		await expect(service.prepareRun(request({ conversationId: "next" }), vi.fn())).rejects.toMatchObject({ code: "capacity" });
		callback.resolve(request());
		await flush();
		await expect(service.run(request({ conversationId: "next" }), vi.fn())).resolves.toBe("answer");
	});

	it("cancels preparation promptly, preserves capacity until settlement, and does not retry", async () => {
		const callback = deferred<AiRunRequest>();
		const external = new AbortController();
		const prep = vi.fn(() => callback.promise);
		const service = new AiService([createAdapter()], undefined, policy);
		const failed = service.prepareRun(request(), prep, external.signal);
		const assertion = expect(failed).rejects.toMatchObject({ code: "cancelled" });
		await flush();
		external.abort();
		await assertion;
		expect(prep).toHaveBeenCalledTimes(1);
		await expect(service.prepareRun(request({ conversationId: "next" }), vi.fn())).rejects.toMatchObject({ code: "capacity" });
		callback.resolve(request());
		await flush();
		await expect(service.run(request({ conversationId: "next" }), vi.fn())).resolves.toBe("answer");
		const preaborted = new AbortController();
		preaborted.abort();
		const never = vi.fn(() => Promise.resolve(request()));
		await expect(service.prepareRun(request(), never, preaborted.signal)).rejects.toMatchObject({ code: "cancelled" });
		expect(never).not.toHaveBeenCalled();
	});

	it("expires an unused ready admission and rejects its token", async () => {
		const service = new AiService([createAdapter()], undefined, policy);
		const token = await service.prepareRun(request());
		vi.advanceTimersByTime(10);
		await expect(service.runPrepared(token, vi.fn())).rejects.toMatchObject({ code: "preparation_timeout" });
		await expect(service.run(request({ conversationId: "next" }), vi.fn())).resolves.toBe("answer");
	});

	it("cancels ready admissions and rejects changed or unsupported prepared requests", async () => {
		const run = vi.fn(async () => "answer");
		const service = new AiService([createAdapter(run)], undefined, policy);
		const cancelled = await service.prepareRun(request());
		expect(service.cancel(cancelled.runId)).toBe(true);
		await expect(service.runPrepared(cancelled, vi.fn())).rejects.toMatchObject({ code: "cancelled" });
		for (const changed of [
			{ modelId: "codex/subscription/codex/other" },
			{ conversationId: "other" },
			{ trigger: "background" as "user" },
		]) {
				await expect(service.prepareRun(request(), async () => request(changed))).rejects.toMatchObject({ code: "request_rejected" });
		}
		for (const mutation of ["modelId", "conversationId"] as const) {
			const preparedRequest = request();
			const token = await service.prepareRun(preparedRequest, async () => preparedRequest);
			if (mutation === "modelId") preparedRequest.modelId = "codex/subscription/codex/changed";
			else preparedRequest.conversationId = "mutated";
			await expect(service.runPrepared(token, vi.fn())).rejects.toMatchObject({ code: "request_rejected" });
		}
		await expect(service.prepareRun(request(), async () => request({ resolvedImages: [{ url: "x", name: "x", mimeType: "image/png", absolutePath: "/x", dataUrl: "data:" }] }))).rejects.toMatchObject({ code: "unsupported_capability" });
		expect(run).not.toHaveBeenCalled();
	});

	it("preserves snapshot errors, sanitizes raw errors, and consumes late callback rejection", async () => {
		const service = new AiService([createAdapter()], undefined, policy);
		await expect(service.prepareRun(request(), async () => { throw new AiSnapshotError("stale"); })).rejects.toEqual(new AiSnapshotError("stale"));
		await expect(service.prepareRun(request(), async () => { throw new Error("sensitive diagnostic"); })).rejects.toMatchObject({ code: "preparation_failed" });
		await expect(service.prepareRun(request({ conversationId: "raw-error" }), async () => { throw new Error("sensitive diagnostic"); })).rejects.not.toThrow("sensitive diagnostic");
		await expect(service.run(request({ conversationId: "after-errors" }), vi.fn())).resolves.toBe("answer");
		const late = deferred<AiRunRequest>();
		const timed = service.prepareRun(request({ conversationId: "late" }), () => late.promise);
		const assertion = expect(timed).rejects.toMatchObject({ code: "preparation_timeout" });
		await flush();
		vi.advanceTimersByTime(10);
		await assertion;
		late.reject(new Error("late"));
		await flush();
		await expect(service.run(request({ conversationId: "after-late" }), vi.fn())).resolves.toBe("answer");
	});

	it("retains capacity during noncooperative running cancellation and succeeds after terminal abort", async () => {
		const adapterDeferred = deferred<string>();
		const external = new AbortController();
		const run = vi.fn(() => {
			external.abort();
			return adapterDeferred.promise;
		});
		const service = new AiService([createAdapter(run)], undefined, policy);
		const prepared = await service.prepareRun(request(), undefined, external.signal);
		const running = service.runPrepared(prepared, vi.fn());
		const assertion = expect(running).rejects.toMatchObject({ code: "cancelled" });
		await flush();
		await assertion;
		await expect(service.run(request({ conversationId: "next" }), vi.fn())).rejects.toMatchObject({ code: "capacity" });
		adapterDeferred.resolve("answer");
		await flush();
		await expect(service.run(request({ conversationId: "next" }), vi.fn())).resolves.toBe("answer");

		const terminalExternal = new AbortController();
		const terminalPrepared = await service.prepareRun(request({ conversationId: "terminal" }), undefined, terminalExternal.signal);
		const events: string[] = [];
		const successful = service.runPrepared(terminalPrepared, (event) => {
			events.push(event.type);
			if (event.type === "complete") terminalExternal.abort();
		});
		await expect(successful).resolves.toBe("answer");
		expect(events).toEqual(["start", "complete"]);
	});
});
