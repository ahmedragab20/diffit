import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: mocks.spawn,
}));

import { createDefaultAdapters } from "../adapters.js";
import { DEFAULT_AI_RUN_POLICY } from "../lifecycle.js";
import type { AiRunEvent, AiRunRequest } from "../types.js";

type Message = Record<string, unknown>;
class FakeChild extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	kill = vi.fn(() => true);
	sent: Message[] = [];
	closed = false;
	constructor() {
		super();
		this.stdin.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString().split("\n")) {
				if (line) this.sent.push(JSON.parse(line) as Message);
			}
		});
	}
	close(code: number | null = 0, signal: NodeJS.Signals | null = null) {
		if (this.closed) return;
		this.closed = true;
		this.stdout.end();
		this.stderr.end();
		this.emit("close", code, signal);
	}
}
const children = new Set<FakeChild>();
const runs = new Set<Promise<string>>();
const fixtureImage = {
	url: "/api/attachments/fixture.png",
	name: "fixture.png",
	mimeType: "image/png",
	absolutePath: "/synthetic/fixture.png",
	dataUrl: "data:image/png;base64,eA==",
};
const request: AiRunRequest = {
	trigger: "user",
	conversationId: "fixture",
	modelId: "codex/subscription/codex/test",
	surface: "diff",
	action: "ask",
	prompt: "synthetic prompt",
	context: { kind: "diff" },
	reasoningEffort: "medium",
	serviceTier: "fast",
	resolvedImages: [fixtureImage],
};
function start(
	sink: (event: AiRunEvent) => void | Promise<void> = vi.fn(),
	signal = new AbortController().signal,
) {
	const adapter = createDefaultAdapters({
		get: vi.fn(async () => null),
		set: vi.fn(async () => "session" as const),
		delete: vi.fn(async () => {}),
	})[0];
	const pending = adapter.run(request, signal, sink);
	runs.add(pending);
	const state = { settled: false };
	void pending.then(
		() => {
			state.settled = true;
		},
		() => {
			state.settled = true;
		},
	);
	const child = [...children].at(-1)!;
	return { child, pending, state };
}
const send = (child: FakeChild, message: Message) => {
	child.stdout.write(`${JSON.stringify(message)}\n`);
};
const notify = (child: FakeChild, method: string, params: Message) =>
	send(child, { method, params });
function handshake(child: FakeChild, includeTurn = true) {
	send(child, { id: 1, result: {} });
	send(child, { id: 2, result: { thread: { id: "thread-1" } } });
	if (includeTurn)
		send(child, {
			id: 3,
			result: { turn: { id: "turn-1", status: "inProgress" } },
		});
}
function delta(child: FakeChild, text = "answer") {
	notify(child, "item/agentMessage/delta", {
		threadId: "thread-1",
		turnId: "turn-1",
		delta: text,
	});
}
function terminal(
	child: FakeChild,
	turn: Message = { id: "turn-1", status: "completed" },
	threadId = "thread-1",
) {
	notify(child, "turn/completed", { threadId, turn });
}
const killed = (child: FakeChild) =>
	vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
const sentTurn = (child: FakeChild) =>
	vi.waitFor(() =>
		expect(child.sent.some((item) => item.method === "turn/start")).toBe(true),
	);

beforeEach(() => {
	mocks.spawn.mockReset();
	mocks.spawn.mockImplementation(() => {
		const child = new FakeChild();
		children.add(child);
		return child;
	});
});
afterEach(async () => {
	for (const child of children) child.close();
	await Promise.allSettled(runs);
	for (const child of children) child.stdin.end();
	children.clear();
	runs.clear();
	vi.useRealTimers();
});

describe("Codex app-server execution", () => {
	it.each([
		[0, null],
		[null, "SIGTERM"],
	] as const)(
		"waits for close before success (code=%s, signal=%s)",
		async (code, signal) => {
			const sink = vi.fn();
			const { child, pending, state } = start(sink);
			expect(mocks.spawn).toHaveBeenCalledOnce();
			handshake(child);
			delta(child);
			terminal(child);
			await killed(child);
			expect(state.settled).toBe(false);
			child.close(code, signal);
			await expect(pending).resolves.toBe("answer");
			expect(sink).toHaveBeenCalledExactlyOnceWith({
				type: "text-delta",
				text: "answer",
			});
			expect(child.kill).toHaveBeenCalledOnce();
		},
	);

	it("preserves read-only handshake, model, settings and images", async () => {
		const { child, pending } = start();
		handshake(child);
		await sentTurn(child);
		expect(child.sent).toEqual([
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					clientInfo: { name: "diffing", title: "diffing", version: "0.18" },
					capabilities: { experimentalApi: true, requestAttestation: false },
				},
			},
			{ jsonrpc: "2.0", method: "initialized", params: {} },
			{
				jsonrpc: "2.0",
				id: 2,
				method: "thread/start",
				params: {
					model: "test",
					cwd: process.cwd(),
					approvalPolicy: "never",
					sandbox: "read-only",
					ephemeral: true,
					dynamicTools: [],
					environments: [],
				},
			},
			{
				jsonrpc: "2.0",
				id: 3,
				method: "turn/start",
				params: {
					threadId: "thread-1",
					model: "test",
					effort: "medium",
					serviceTier: "fast",
					approvalPolicy: "never",
					environments: [],
					input: [
						{ type: "text", text: "synthetic prompt", text_elements: [] },
						{ type: "image", url: fixtureImage.dataUrl },
					],
				},
			},
		]);
		delta(child);
		terminal(child);
		await killed(child);
		child.close();
		await pending;
	});

	it("rejects a nonzero exit despite a successful turn", async () => {
		const { child, pending } = start();
		handshake(child);
		delta(child);
		terminal(child);
		await killed(child);
		child.close(1);
		await expect(pending).rejects.toMatchObject({ code: "provider_failed" });
	});

	it.each([
		[{ id: "turn-1", status: "failed" }, "provider_failed"],
		[{ id: "turn-1", status: "interrupted" }, "provider_failed"],
		[{ id: "turn-1", status: "completed", error: false }, "provider_failed"],
		[
			{ id: "turn-1", status: "completed", error: { message: "private" } },
			"provider_failed",
		],
		[{ id: "turn-1", status: "paused" }, "protocol_error"],
		[{ id: "turn-1" }, "protocol_error"],
		[{ id: "other", status: "completed" }, "protocol_error"],
	] as const)("rejects invalid terminal %j", async (turn, code) => {
		const { child, pending, state } = start();
		handshake(child);
		delta(child);
		terminal(child, turn);
		await killed(child);
		expect(state.settled).toBe(false);
		child.close();
		await expect(pending).rejects.toMatchObject({ code });
	});

	it.each(["", " \n\t"])("rejects empty output %j", async (text) => {
		const { child, pending } = start();
		handshake(child);
		delta(child, text);
		terminal(child);
		await killed(child);
		child.close();
		await expect(pending).rejects.toMatchObject({ code: "empty_output" });
	});

	it.each(["thread", "turn", "terminal-thread"])(
		"rejects unrelated %s identity",
		async (kind) => {
			const { child, pending } = start();
			handshake(child);
			if (kind === "terminal-thread")
				terminal(child, { id: "turn-1", status: "completed" }, "other");
			else
				notify(child, "item/agentMessage/delta", {
					threadId: kind === "thread" ? "other" : "thread-1",
					turnId: kind === "turn" ? "other" : "turn-1",
					delta: "x",
				});
			await killed(child);
			child.close();
			await expect(pending).rejects.toMatchObject({ code: "protocol_error" });
		},
	);

	it("rejects clean EOF with partial text but no terminal", async () => {
		const sink = vi.fn();
		const { child, pending } = start(sink);
		handshake(child);
		delta(child);
		await vi.waitFor(() => expect(sink).toHaveBeenCalledOnce());
		child.close();
		await expect(pending).rejects.toMatchObject({ code: "protocol_error" });
	});

	it.each(["not json\n", "[]\n", '"primitive"\n', '{"jsonrpc":"2.0"'])(
		"rejects malformed JSON %j",
		async (text) => {
			const { child, pending } = start();
			child.stdout.write(text);
			child.close();
			await expect(pending).rejects.toMatchObject({ code: "protocol_error" });
		},
	);

	it.each([false, true])(
		"rejects duplicate responses or approval requests (approval=%s)",
		async (approval) => {
			const { child, pending } = start();
			handshake(child);
			await sentTurn(child);
			const before = child.sent.length;
			send(
				child,
				approval
					? { id: 99, method: "approval/request", params: {} }
					: { id: 1, result: {} },
			);
			await killed(child);
			child.close();
			await expect(pending).rejects.toMatchObject({ code: "protocol_error" });
			expect(child.sent).toHaveLength(before);
		},
	);

	it.each([false, true])(
		"correlates a turn/started notification before its RPC response (different=%s)",
		async (different) => {
			const { child, pending } = start();
			handshake(child, false);
			notify(child, "turn/started", {
				threadId: "thread-1",
				turn: { id: "turn-1", status: "inProgress" },
			});
			delta(child);
			send(child, {
				id: 3,
				result: {
					turn: { id: different ? "other" : "turn-1", status: "inProgress" },
				},
			});
			terminal(child);
			await killed(child);
			child.close();
			if (different)
				await expect(pending).rejects.toMatchObject({ code: "protocol_error" });
			else await expect(pending).resolves.toBe("answer");
		},
	);

	it("does not spawn after pre-abort", async () => {
		const controller = new AbortController();
		controller.abort();
		const { pending } = start(vi.fn(), controller.signal);
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("requests cancellation but waits for close", async () => {
		const controller = new AbortController();
		const sink = vi.fn();
		const { child, pending, state } = start(sink, controller.signal);
		handshake(child);
		delta(child);
		await vi.waitFor(() => expect(sink).toHaveBeenCalledOnce());
		controller.abort();
		await killed(child);
		expect(state.settled).toBe(false);
		child.close(null, "SIGTERM");
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("stops on sink rejection without exposing its message or delivering later events", async () => {
		const sink = vi.fn(async () => {
			throw new Error("synthetic secret");
		});
		const { child, pending } = start(sink);
		handshake(child);
		delta(child, "one");
		delta(child, "two");
		terminal(child);
		await killed(child);
		child.close();
		const error = await pending.catch((error: unknown) => error);
		expect(error).toMatchObject({ code: "delivery_failed" });
		expect(String(error)).not.toContain("synthetic secret");
		expect(sink).toHaveBeenCalledOnce();
	});

	it("pulls the next delta only after downstream delivery finishes", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sink = vi.fn((_event: AiRunEvent) => gate);
		const { child, pending } = start(sink);
		try {
			handshake(child);
			delta(child, "one");
			delta(child, "two");
			terminal(child);
			await vi.waitFor(() => expect(sink).toHaveBeenCalledOnce());
			expect(child.kill).not.toHaveBeenCalled();
			release();
			await killed(child);
			expect(sink.mock.calls.map(([event]) => event)).toEqual([
				{ type: "text-delta", text: "one" },
				{ type: "text-delta", text: "two" },
			]);
			child.close();
			await expect(pending).resolves.toBe("onetwo");
		} finally {
			release();
		}
	});

	it.each(["frame", "output", "events", "stream"])(
		"bounds %s resources",
		async (limit) => {
			const sink = vi.fn();
			const { child, pending } = start(sink);
			handshake(child);
			if (limit === "frame")
				child.stdout.write("x".repeat(DEFAULT_AI_RUN_POLICY.maxEventBytes + 1));
			if (limit === "output")
				for (let i = 0; i < 33; i++) delta(child, "é".repeat(65536));
			if (limit === "events")
				for (let i = 0; i <= DEFAULT_AI_RUN_POLICY.maxEvents; i++)
					notify(child, "unknown", {});
			if (limit === "stream")
				for (let i = 0; i < 100; i++)
					notify(child, "unknown", { data: "x".repeat(190000) });
			await killed(child);
			child.close();
			await expect(pending).rejects.toMatchObject({ code: "resource_limit" });
			if (limit === "output") expect(sink).toHaveBeenCalledTimes(32);
		},
	);

	it("keeps ownership after the standalone deadline until close", async () => {
		vi.useFakeTimers();
		const { child, pending, state } = start();
		await vi.advanceTimersByTimeAsync(DEFAULT_AI_RUN_POLICY.totalMs);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(state.settled).toBe(false);
		child.close();
		await expect(pending).rejects.toMatchObject({ code: "total_timeout" });
		expect(vi.getTimerCount()).toBe(0);
	});
});
