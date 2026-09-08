// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { streamAiRun } from "../run-stream.js";
import { AiRunError } from "../lifecycle.js";
import type { AiPreparedRun, AiService } from "../service.js";
import type { AiRunEvent, AiRunRequest } from "../types.js";

const request: AiRunRequest = {
	trigger: "user",
	conversationId: "c",
	modelId: "codex/test",
	surface: "diff",
	action: "ask",
	context: { kind: "diff" },
};
const started: AiRunEvent = {
	type: "start",
	runId: "r",
	modelId: "codex/test",
};
const completed: AiRunEvent = { type: "complete", text: "answer" };
type Emit = Parameters<AiService["run"]>[1];
type Frame = { event: string; data: string };
function harness() {
	const events: AiRunEvent[] = [];
	let onAbort!: () => void;
	const stream = {
		writeSSE: vi.fn(async (frame: Frame) => {
			events.push(JSON.parse(frame.data) as AiRunEvent);
		}),
		onAbort: (callback: () => void) => {
			onAbort = callback;
		},
	};
	return { events, stream, abort: () => onAbort() };
}
function service(body: (emit: Emit) => Promise<void>) {
	return {
		run: vi.fn(async (_request: AiRunRequest, emit: Emit) => {
			await body(emit);
			return "answer";
		}),
		runPrepared: vi.fn(async (_token: AiPreparedRun, emit: Emit) => {
			await body(emit);
			return "answer";
		}),
		cancel: vi.fn(() => true),
	};
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const signal = () => new AbortController().signal;

describe("streamAiRun", () => {
	it("writes ordered start, delta and complete", async () => {
		const h = harness();
		const s = service(async (emit) => {
			await emit(started);
			await emit({ type: "text-delta", text: "answer" });
			await emit(completed);
		});
		await streamAiRun(s, request, h.stream, signal());
		expect(h.events.map((event) => event.type)).toEqual([
			"start",
			"text-delta",
			"complete",
		]);
	});

	it("exposes a safe classified error before start", async () => {
		const h = harness();
		const s = service(async () => {
			throw new Error("synthetic secret");
		});
		await streamAiRun(s, request, h.stream, signal());
		expect(h.events).toEqual([
			expect.objectContaining({ type: "error", code: "provider_failed" }),
		]);
		expect(JSON.stringify(h.events)).not.toContain("synthetic secret");
	});

	it("rejects a service that returns without completion", async () => {
		const h = harness();
		await streamAiRun(
			service(async (emit) => {
				await emit(started);
			}),
			request,
			h.stream,
			signal(),
		);
		expect(h.events).toEqual([
			started,
			expect.objectContaining({ type: "error", code: "protocol_error" }),
		]);
	});

	it("does not cancel when the client closes after reading completion", async () => {
		const h = harness();
		const s = service(async (emit) => {
			await emit(started);
			await emit(completed);
		});
		h.stream.writeSSE.mockImplementation(async (frame) => {
			h.events.push(JSON.parse(frame.data) as AiRunEvent);
			if (frame.event === "complete") h.abort();
		});
		await streamAiRun(s, request, h.stream, signal());
		expect(s.cancel).not.toHaveBeenCalled();
		expect(h.events).toEqual([started, completed]);
	});

	it("does not retry a failed terminal write and requests cancellation", async () => {
		const h = harness();
		const s = service(async (emit) => {
			await emit(started);
			await emit(completed);
		});
		h.stream.writeSSE.mockImplementation(async (frame) => {
			if (frame.event === "complete") throw new Error("closed");
		});
		await streamAiRun(s, request, h.stream, signal());
		expect(h.stream.writeSSE).toHaveBeenCalledTimes(2);
		expect(s.cancel).toHaveBeenCalledWith("r");
	});

	it.each([false, true])(
		"does not emit a second terminal (duplicate=%s)",
		async (duplicate) => {
			const h = harness();
			const s = service(async (emit) => {
				await emit(started);
				await emit(completed);
				if (duplicate) await emit(completed);
				else throw new Error("late failure");
			});
			await streamAiRun(s, request, h.stream, signal());
			expect(h.events).toEqual([started, completed]);
		},
	);

	it("dispatches a prepared token through runPrepared instead of run", async () => {
		const h = harness();
		const s = service(async (emit) => {
			await emit(started);
			await emit(completed);
		});
		const token = { runId: "r" } as AiPreparedRun;
		await streamAiRun(s, request, h.stream, signal(), token);
		expect(s.runPrepared).toHaveBeenCalledWith(token, expect.any(Function));
		expect(s.run).not.toHaveBeenCalled();
	});

	it("cancels a ready prepared run on pre-abort without executing it", async () => {
		const h = harness();
		const s = service(async () => {});
		const controller = new AbortController();
		controller.abort();
		const token = { runId: "ready" } as AiPreparedRun;
		await streamAiRun(s, request, h.stream, controller.signal, token);
		expect(s.cancel).toHaveBeenCalledWith("ready");
		expect(s.runPrepared).not.toHaveBeenCalled();
		expect(s.run).not.toHaveBeenCalled();
	});

	it.each([
		[
			"mismatched start",
			async (emit: Emit) => {
				await emit({ ...started, runId: "wrong" });
			},
		],
		[
			"terminal before start",
			async (emit: Emit) => {
				await emit(completed);
			},
		],
	])("emits one protocol error for %s", async (_label, body) => {
		const h = harness();
		const s = service(body);
		const token = { runId: "r" } as AiPreparedRun;
		await streamAiRun(s, request, h.stream, signal(), token);
		expect(h.events.filter((event) => event.type === "error")).toHaveLength(1);
		expect(h.events).toEqual([
			expect.objectContaining({ type: "error", code: "protocol_error" }),
		]);
	});

	it("does not start inference after pre-abort", async () => {
		const h = harness();
		const s = service(async () => {});
		const controller = new AbortController();
		controller.abort();
		await streamAiRun(s, request, h.stream, controller.signal);
		expect(s.run).not.toHaveBeenCalled();
		expect(h.events).toEqual([]);
	});

	it("cancels a late start after disconnection without writing", async () => {
		const h = harness();
		const gate = deferred();
		const s = service(async (emit) => {
			await gate.promise;
			await emit(started);
		});
		const pending = streamAiRun(s, request, h.stream, signal());
		h.abort();
		gate.resolve();
		await pending;
		expect(s.cancel).toHaveBeenCalledWith("r");
		expect(h.events).toEqual([]);
	});

	it("cancels after start and suppresses later writes", async () => {
		const h = harness();
		const ready = deferred();
		const gate = deferred();
		const s = service(async (emit) => {
			await emit(started);
			ready.resolve();
			await gate.promise;
			await emit({ type: "text-delta", text: "late" });
		});
		const pending = streamAiRun(s, request, h.stream, signal());
		await ready.promise;
		h.abort();
		gate.resolve();
		await pending;
		expect(s.cancel).toHaveBeenCalledWith("r");
		expect(h.events).toEqual([started]);
	});

	it("preserves a classified cancellation reason", async () => {
		const h = harness();
		await streamAiRun(
			service(async () => {
				throw new AiRunError("cancelled");
			}),
			request,
			h.stream,
			signal(),
		);
		expect(h.events).toEqual([
			expect.objectContaining({ type: "error", code: "cancelled" }),
		]);
	});
});
