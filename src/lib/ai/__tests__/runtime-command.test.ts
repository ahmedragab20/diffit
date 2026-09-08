import { describe, expect, it, vi } from "vitest";
import { RuntimeAdapter } from "../adapters.js";
import type { AiRunEvent, AiRunRequest } from "../types.js";
import { asNodeScript, claude } from "./fixtures/runtime-frames.js";

const request: AiRunRequest = {
	trigger: "user",
	conversationId: "runtime",
	modelId: "claude/subscription/claude/test",
	surface: "diff",
	action: "ask",
	context: { kind: "diff" },
	prompt: "Question",
};
function adapter(body: string, exit = 0) {
	const script = `process.stdin.resume(); process.stdin.on('end',()=>{${body};process.exitCode=${exit};});`;
	return new RuntimeAdapter({
		id: "claude",
		label: "fixture",
		bin: process.execPath,
		args: () => ["-e", script],
		versionArgs: [],
		statusArgs: [],
		routes: ["subscription"],
		setup: {},
	});
}
function output(frames: Record<string, unknown>[]) {
	return asNodeScript(frames);
}

describe("RuntimeAdapter command protocol", () => {
	it("parses ordered Claude JSON lines into deltas and result", async () => {
		const events: AiRunEvent[] = [];
		const result = await adapter(output(claude(["one", "two"]))).run(
			request,
			new AbortController().signal,
			(event) => {
				events.push(event);
			},
		);
		expect(events).toEqual([
			{ type: "text-delta", text: "one" },
			{ type: "text-delta", text: "two" },
		]);
		expect(result).toBe("onetwo");
	});

	it.each([
		["console.log('plain text')", 0, "protocol_error"],
		[
			output([{ type: "error", session_id: "s", error: "private" }]),
			0,
			"provider_failed",
		],
		["console.error('synthetic private stderr')", 2, "provider_failed"],
		["", 0, "protocol_error"],
		[output(claude(["x".repeat(257 * 1024)])), 0, "resource_limit"],
	] as const)("rejects invalid process output: %s", async (body, exit, code) => {
		const error = await adapter(body, exit)
			.run(request, new AbortController().signal, () => {})
			.catch((error: unknown) => error);
		expect(error).toMatchObject({ code });
		expect(String(error)).not.toContain("private");
	});

	it("rejects a successful empty terminal as empty_output", async () => {
		const error = await adapter(output(claude([], { result: "" })))
			.run(request, new AbortController().signal, () => {})
			.catch((value: unknown) => value);
		expect(error).toMatchObject({ code: "empty_output" });
	});

	it("rejects valid text without a terminal", async () => {
		const frames = claude(["text"]);
		const error = await adapter(output(frames.slice(0, -1)))
			.run(request, new AbortController().signal, () => {})
			.catch((value: unknown) => value);
		expect(error).toMatchObject({ code: "protocol_error" });
	});

	it("rejects nonzero exit after a successful terminal", async () => {
		const error = await adapter(output(claude(["text"])), 1)
			.run(request, new AbortController().signal, () => {})
			.catch((value: unknown) => value);
		expect(error).toMatchObject({ code: "provider_failed" });
	});

	it("terminates after delivery failure without later callbacks", async () => {
		const callback = vi.fn(() => {
			throw new Error("synthetic sink detail");
		});
		await expect(
			adapter(output(claude(["one", "two"])) + "setInterval(()=>{},1000);").run(
				request,
				new AbortController().signal,
				callback,
			),
		).rejects.toMatchObject({ code: "delivery_failed" });
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("cancels during delivery and waits for child close", async () => {
		const controller = new AbortController();
		const callback = vi.fn(() => controller.abort());
		await expect(
			adapter(output(claude(["one", "two"])) + "setInterval(()=>{},1000);").run(
				request,
				controller.signal,
				callback,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(callback).toHaveBeenCalledTimes(1);
	});
});
