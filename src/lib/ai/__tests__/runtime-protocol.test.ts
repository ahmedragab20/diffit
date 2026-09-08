// @vitest-environment node
import { describe, expect, it } from "vitest";
import { RuntimeTextDecoder } from "../runtime-protocol.js";
import { claude, cursor, opencode } from "./fixtures/runtime-frames.js";

type Frame = Record<string, unknown>;
function errorCode(fn: () => unknown) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("expected decoder error");
}
function expectCode(fn: () => unknown, code: string) {
	expect(errorCode(fn)).toMatchObject({ code });
}
function feed(source: "claude" | "cursor" | "opencode", frames: Frame[]) {
	const decoder = new RuntimeTextDecoder(source);
	const deltas = frames.map((frame) => decoder.push(frame));
	return { decoder, deltas };
}

describe("RuntimeTextDecoder offline protocols", () => {
	it.each([
		["claude", claude(["ha", "ha"])],
		["cursor", cursor(["ha", "ha"])],
		["opencode", opencode(["ha", "ha"])],
	] as const)("decodes %s and preserves repeated chunks", (source, frames) => {
		const { decoder, deltas } = feed(source, frames);
		expect(deltas.filter(Boolean).join("")).toBe("haha");
		expect(decoder.finish()).toBe("haha");
	});

	it("uses authoritative final text without synthetic delta", () => {
		const { decoder, deltas } = feed(
			"claude",
			claude(["stream"], { result: "authoritative" }),
		);
		expect(deltas.join("")).toBe("stream");
		expect(decoder.finish()).toBe("authoritative");
	});

	it("ignores summary and flush identity duplicates", () => {
		const frames = cursor(["one"]);
		const { decoder, deltas } = feed("cursor", frames);
		expect(deltas.filter(Boolean)).toEqual(["one"]);
		expect(decoder.finish()).toBe("one");
	});

	it.each([
		["claude", claude(["x"])],
		["cursor", cursor(["x"])],
		["opencode", opencode(["x"])],
	] as const)(
		"requires a terminal and stable session for %s",
		(source, frames) => {
			const decoder = new RuntimeTextDecoder(source);
			frames.slice(0, -1).forEach((frame) => decoder.push(frame));
			expectCode(() => decoder.finish(), "protocol_error");
			const key = source === "opencode" ? "sessionID" : "session_id";
			expectCode(
				() => decoder.push({ ...frames.at(-1), [key]: "different" }),
				"protocol_error",
			);
		},
	);

	it("deduplicates only Claude event IDs and OpenCode part IDs", () => {
		const frames = claude(["ha", "ha"]);
		const decoder = new RuntimeTextDecoder("claude");
		decoder.push(frames[0]);
		decoder.push(frames[1]);
		expect(decoder.push(frames[2])).toBe("ha");
		expect(decoder.push(frames[2])).toBe("");
		expect(decoder.push(frames[3])).toBe("ha");
		frames.slice(4).forEach((frame) => decoder.push(frame));
		expect(decoder.finish()).toBe("haha");
		const openFrames = opencode(["ha", "ha"]);
		const open = new RuntimeTextDecoder("opencode");
		open.push(openFrames[0]);
		expect(open.push(openFrames[1])).toBe("ha");
		expect(open.push(openFrames[1])).toBe("");
		expect(open.push(openFrames[2])).toBe("ha");
		open.push(openFrames[3]);
		expect(open.finish()).toBe("haha");
	});

	it("ignores thinking frames so they never become assistant text", () => {
		const frames = cursor(["pong"]);
		const decoder = new RuntimeTextDecoder("cursor");
		expect(
			decoder.push({
				type: "thinking",
				session_id: "s",
				subtype: "delta",
				text: "should not surface",
				timestamp_ms: 1,
			}),
		).toBe("");
		frames.forEach((frame) => decoder.push(frame));
		expect(decoder.finish()).toBe("pong");
	});

	it("rejects array frames and malformed assistant text", () => {
		expectCode(() => new RuntimeTextDecoder("cursor").push([]), "protocol_error");
		expectCode(
			() =>
				new RuntimeTextDecoder("cursor").push({
					type: "assistant",
					session_id: "s",
					timestamp_ms: 1,
					message: { role: "assistant", content: [{ type: "text", text: 42 }] },
				}),
			"protocol_error",
		);
	});

	it("rejects failed and malformed terminal frames", () => {
		for (const source of ["claude", "cursor"] as const) {
			const frame = {
				...claude(["x"])[0],
				type: "result",
				subtype: "error",
				is_error: true,
				result: "x",
			};
			if (source === "cursor") Object.assign(frame, { session_id: "s" });
			expectCode(
				() => new RuntimeTextDecoder(source).push(frame),
				"provider_failed",
			);
		}
		const failed = opencode(["x"]);
		failed[2] = {
			...failed[2],
			part: { ...((failed[2] as Frame).part as Frame), reason: "error" },
		};
		const decoder = new RuntimeTextDecoder("opencode");
		decoder.push(failed[0]);
		decoder.push(failed[1]);
		expectCode(() => decoder.push(failed[2]), "provider_failed");
	});

	it("rejects duplicate terminals, post-terminal events, session changes, and bad identity", () => {
		const frames = claude(["x"]);
		const decoder = new RuntimeTextDecoder("claude");
		frames.slice(0, -1).forEach((frame) => decoder.push(frame));
		decoder.push(frames.at(-1)!);
		expectCode(() => decoder.push(frames.at(-1)!), "protocol_error");
		expectCode(
			() => decoder.push({ ...frames[0], uuid: "new", session_id: "other" }),
			"protocol_error",
		);
		const open = opencode(["x"]);
		open[2] = {
			...open[2],
			part: { ...((open[2] as Frame).part as Frame), messageID: "other" },
		};
		expectCode(() => {
			const d = new RuntimeTextDecoder("opencode");
			d.push(open[0]);
			d.push(open[1]);
			d.push(open[2]);
		}, "protocol_error");
	});

	it("validates arrays, event types, text blocks, UUIDs, and unfinished messages", () => {
		expectCode(
			() => new RuntimeTextDecoder("claude").push(null),
			"protocol_error",
		);
		expectCode(
			() =>
				new RuntimeTextDecoder("claude").push({ session_id: "s", type: "mystery" }),
			"protocol_error",
		);
		const frames = claude(["x"]);
		const malformed = {
			...frames[1],
			event: {
				...(frames[1].event as Frame),
				content_block: { type: "wat", text: "" },
			},
		};
		expectCode(
			() => new RuntimeTextDecoder("claude").push(malformed),
			"protocol_error",
		);
		const d = new RuntimeTextDecoder("claude");
		d.push(frames[0]);
		expectCode(
			() =>
				d.push({
					...frames[1],
					uuid: "u-invalid",
					event: { ...(frames[1].event as Frame), index: -1 },
				}),
			"protocol_error",
		);
		const duplicate = { ...frames[2], uuid: frames[1].uuid };
		expectCode(() => d.push(duplicate), "protocol_error");
		const unfinished = new RuntimeTextDecoder("claude");
		unfinished.push(frames[0]);
		unfinished.push(frames[1]);
		expectCode(() => unfinished.push(frames.at(-1)!), "protocol_error");
	});

	it("rejects conflicting Claude UUIDs and closed-block deltas", () => {
		const frames = claude(["x"]);
		const d = new RuntimeTextDecoder("claude");
		d.push(frames[0]);
		d.push(frames[1]);
		const conflict = {
			...frames[1],
			event: {
				...(frames[1].event as Frame),
				content_block: { type: "text", text: "different" },
			},
		};
		expectCode(() => d.push(conflict), "protocol_error");
		const closed = new RuntimeTextDecoder("claude");
		frames.slice(0, 4).forEach((f) => closed.push(f));
		closed.push(frames[4]);
		expectCode(
			() => closed.push({ ...frames[2], uuid: "late-delta" }),
			"protocol_error",
		);
	});

	it("rejects malformed Cursor metadata and never emits user/tool text", () => {
		const d = new RuntimeTextDecoder("cursor");
		expectCode(
			() =>
				d.push({
					type: "assistant",
					session_id: "s",
					timestamp_ms: "bad",
					message: { role: "assistant", content: [] },
				}),
			"protocol_error",
		);
		expectCode(
			() =>
				d.push({
					type: "assistant",
					session_id: "s",
					timestamp_ms: 1,
					model_call_id: 4,
					message: { role: "assistant", content: [] },
				}),
			"protocol_error",
		);
		const user = d.push({
			type: "user",
			session_id: "s",
			message: { role: "user", content: [{ type: "text", text: "secret" }] },
		});
		const tool = d.push({
			type: "tool_call",
			session_id: "s",
			subtype: "completed",
			tool_call: { text: "secret" },
		});
		expect(user + tool).toBe("");
	});

	it("rejects OpenCode duplicate part payloads and tool-call EOF", () => {
		const frames = opencode(["x"]);
		const d = new RuntimeTextDecoder("opencode");
		d.push(frames[0]);
		d.push(frames[1]);
		expectCode(
			() =>
				d.push({
					...frames[1],
					part: { ...(frames[1].part as Frame), text: "changed" },
				}),
			"protocol_error",
		);
		const tools = opencode([]);
		tools[1] = {
			type: "step_finish",
			sessionID: "s",
			part: {
				sessionID: "s",
				messageID: "m",
				type: "step-finish",
				reason: "tool-calls",
			},
		};
		const t = new RuntimeTextDecoder("opencode");
		t.push(tools[0]);
		expectCode(() => {
			t.push(tools[1]);
			t.finish();
		}, "protocol_error");
	});

	it("classifies empty success as empty_output", () => {
		const d = new RuntimeTextDecoder("claude");
		for (const frame of claude([], { result: "" })) d.push(frame);
		expectCode(() => d.finish(), "empty_output");
	});

	it("enforces event and aggregate output limits", () => {
		const huge = "x".repeat(257 * 1024);
		const tooBig = claude([huge]);
		expectCode(
			() => new RuntimeTextDecoder("claude").push(tooBig[2]),
			"resource_limit",
		);
		const chunks = Array.from({ length: 18 }, () => "x".repeat(240 * 1024));
		const d = new RuntimeTextDecoder("claude");
		const frames = claude(chunks);
		for (const frame of frames) {
			try {
				d.push(frame);
			} catch (error) {
				expect(error).toMatchObject({ code: "resource_limit" });
				return;
			}
		}
		throw new Error("expected aggregate resource limit");
	});
});
