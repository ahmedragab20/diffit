// @vitest-environment node
// Codex adapter image contract: turn/start input must carry captured image
// data URLs ({ type: "image", url }) and must never reopen local image paths
// (no { type: "localImage", path } / absolutePath). The child-process seam is
// mocked with a fake EventEmitter child wired to PassThrough streams, and the
// model catalog is served offline; the real codex binary is never executed.
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createDefaultAdapters } from "../adapters.js";
import type { SecretStore } from "../secrets.js";
import type { AiRunRequest } from "../types.js";

const harness = vi.hoisted(() => ({
	spawnImpl: undefined as ((...args: unknown[]) => unknown) | undefined,
}));

vi.mock("../child-process.js", () => ({
	spawn: (...args: unknown[]) => {
		if (!harness.spawnImpl)
			throw new Error("unexpected spawn in test: " + String(args[0]));
		return harness.spawnImpl(...args);
	},
}));

// Image requests are option-gated against the catalog; serve it offline.
vi.mock("../catalog.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../catalog.js")>()),
	codexModelCatalog: async () => [
		{ id: "test-model", displayName: "Test Model", supportsImages: true },
	],
}));

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const ABSOLUTE_PATH = "/never-open/captured.png";

function fakeSecrets(): SecretStore {
	return {
		get: async () => null,
		set: async () => "session" as const,
		delete: async () => {},
	};
}

function codexAdapter() {
	const adapter = createDefaultAdapters(fakeSecrets()).find(
		(item) => item.id === "codex",
	);
	if (!adapter) throw new Error("Codex adapter is missing");
	return adapter;
}

function request(images?: AiRunRequest["resolvedImages"]): AiRunRequest {
	return {
		trigger: "user",
		conversationId: "test",
		modelId: "codex/subscription/codex/test-model",
		surface: "diff",
		action: "ask",
		context: { kind: "diff" },
		prompt: "Check image",
		resolvedImages: images,
	};
}

interface FakeChild {
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough;
	kill: ReturnType<typeof vi.fn>;
}

function createFakeChild(onTurnStart: (input: unknown) => void): FakeChild {
	const child = new EventEmitter() as EventEmitter & FakeChild;
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	// The adapter keeps ownership until close; a real SIGTERM ends the process.
	child.kill = vi.fn(() => {
		queueMicrotask(() => {
			child.stdout.end();
			child.stderr.end();
			child.emit("close", 0, null);
		});
		return true;
	});
	let buffer = "";
	child.stdin.on("data", (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line) continue;
			let message: { id?: number; method?: string; params?: { input?: unknown } };
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (!message.id) continue; // ignore the "initialized" notification
			if (message.id === 1) {
				queueMicrotask(() =>
					child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`),
				);
			} else if (message.id === 2) {
				queueMicrotask(() =>
					child.stdout.write(
						`${JSON.stringify({ id: 2, result: { thread: { id: "test-thread" } } })}\n`,
					),
				);
			} else if (message.id === 3) {
				onTurnStart(message.params?.input);
				queueMicrotask(() =>
					child.stdout.write(
						`${JSON.stringify({ id: 3, result: { turn: { id: "test-turn", status: "inProgress" } } })}\n`,
					),
				);
				queueMicrotask(() =>
					child.stdout.write(
						`${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "test-thread", turnId: "test-turn", delta: "checked" } })}\n`,
					),
				);
				queueMicrotask(() =>
					child.stdout.write(
						`${JSON.stringify({ method: "turn/completed", params: { threadId: "test-thread", turn: { id: "test-turn", status: "completed" } } })}\n`,
					),
				);
			}
		}
	});
	harness.spawnImpl = () => child;
	return child;
}

describe("Codex app-server image handling", () => {
	it("sends captured image data URLs and never local image paths", async () => {
		let turnInput: unknown;
		const child = createFakeChild((input) => {
			turnInput = input;
		});
		const adapter = codexAdapter();
		const controller = new AbortController();
		try {
			await expect(
				adapter.run(
					request([
						{
							url: "/api/attachments/pasted_image_a.png",
							name: "a.png",
							mimeType: "image/png",
							size: 8,
							absolutePath: ABSOLUTE_PATH,
							dataUrl: DATA_URL,
						},
					]),
					controller.signal,
					async () => {},
				),
			).resolves.toBe("checked");
		} finally {
			controller.abort();
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
		}

		const items = (turnInput ?? []) as Array<Record<string, unknown>>;
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({ type: "text", text: "Check image" });
		expect(items[1]).toEqual({ type: "image", url: DATA_URL });
		expect(items.some((item) => item.type === "localImage")).toBe(false);
		expect(items.some((item) => "path" in item)).toBe(false);
		expect(JSON.stringify(items)).not.toContain(ABSOLUTE_PATH);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("sends text only when no images are resolved", async () => {
		let turnInput: unknown;
		const child = createFakeChild((input) => {
			turnInput = input;
		});
		const adapter = codexAdapter();
		const controller = new AbortController();
		try {
			await expect(
				adapter.run(request(), controller.signal, async () => {}),
			).resolves.toBe("checked");
		} finally {
			controller.abort();
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
		}

		const items = (turnInput ?? []) as Array<Record<string, unknown>>;
		expect(items).toEqual([
			expect.objectContaining({ type: "text", text: "Check image" }),
		]);
		expect(JSON.stringify(items)).not.toContain("localImage");
		expect(JSON.stringify(items)).not.toContain(ABSOLUTE_PATH);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});
});
