// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	MAX_AI_REQUEST_BYTES,
	AiRequestError,
	parseAiRunRequest,
	readAiRunRequest,
} from "../request.js";

const base = () => ({
	trigger: "user",
	conversationId: "conversation-1",
	modelId: "codex/subscription/codex/test",
	surface: "diff",
	action: "ask",
	context: { kind: "diff" },
});
const wire = (patch: Record<string, unknown> = {}) => ({ ...base(), ...patch });
const actions = [
	"ask",
	"summarize",
	"review-risks",
	"explain",
	"draft-comment",
	"improve-comment",
	"shorten-comment",
	"make-specific",
	"draft-reply",
	"suggest-change",
	"review-map",
	"explain-hunk",
	"draft-review-summary",
	"critique-plan",
	"find-plan-gaps",
	"rewrite-plan-section",
	"compare-plan-versions",
	"critique-mockup",
	"find-mockup-gaps",
	"rewrite-region",
	"generate-screen",
	"compare-mockup-versions",
];

describe("AI request wire contract", () => {
	it.each(["diff", "pr-diff", "plan", "mockup"])(
		"accepts %s context",
		(surface) => {
			const context =
				surface === "plan"
					? { kind: "plan", planId: "p", title: "Plan", version: 1 }
					: surface === "mockup"
						? { kind: "mockup", mockupId: "m", title: "Mockup", version: 1 }
						: { kind: "diff" };
			expect(parseAiRunRequest(wire({ surface, context }))).toMatchObject({
				surface,
				context,
			});
		},
	);
	it.each(actions)("accepts known action %s", (action) => {
		expect(parseAiRunRequest(wire({ action })).action).toBe(action);
	});
	it.each([null, [], "request", 42])(
		"rejects non-object request %j",
		(value) => {
			expect(() => parseAiRunRequest(value)).toThrow(AiRequestError);
		},
	);
	it.each([
		["numeric context", { context: 1 }],
		["string context", { context: "x" }],
		["numeric conversation", { conversationId: 1 }],
		["numeric model", { modelId: 1 }],
		["numeric prompt", { prompt: 1 }],
		["unknown action", { action: "nope" }],
		["unknown surface", { surface: "nope" }],
		["wrong surface-kind", { surface: "plan", context: { kind: "diff" } }],
		["attachments string", { context: { kind: "diff", attachmentPaths: "x" } }],
		["replies string", { context: { kind: "diff", replies: "x" } }],
		["bad role", { history: [{ role: "system", text: "x" }] }],
		[
			"excess history",
			{
				history: Array.from({ length: 201 }, () => ({ role: "user", text: "x" })),
			},
		],
		[
			"fractional lines",
			{ context: { kind: "diff", startLine: 1.5, endLine: 2 } },
		],
		["reversed lines", { context: { kind: "diff", startLine: 3, endLine: 2 } }],
		[
			"excess paths",
			{ context: { kind: "diff", attachmentPaths: Array(9).fill("x") } },
		],
		[
			"excess images",
			{
				context: {
					kind: "diff",
					imageAttachments: Array(5).fill({ url: "u", name: "n", mimeType: "x" }),
				},
			},
		],
		[
			"invalid image",
			{
				context: {
					kind: "diff",
					imageAttachments: [{ url: 1, name: "n", mimeType: "x" }],
				},
			},
		],
		["resolved images", { resolvedImages: [] }],
		["context attachments", { context: { kind: "diff", attachments: [] } }],
		["unknown top-level", { extra: true }],
		[
			"invalid plan version",
			{
				surface: "plan",
				context: { kind: "plan", planId: "p", title: "p", version: 0 },
			},
		],
	] as const)("rejects %s", (_label, patch) => {
		expect(() => parseAiRunRequest(wire(patch))).toThrow(AiRequestError);
	});
	it("enforces UTF-8 text budgets", () => {
		expect(() => parseAiRunRequest(wire({ prompt: "é".repeat(65537) }))).toThrow(
			AiRequestError,
		);
	});
});

function request(body: BodyInit, init: RequestInit = {}) {
	return new Request("http://test", {
		method: "POST",
		body,
		duplex: "half",
		...init,
	} as RequestInit & { duplex: "half" });
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("readAiRunRequest", () => {
	it("accepts JSON split inside a multibyte character", async () => {
		const bytes = new TextEncoder().encode(
			JSON.stringify(wire({ prompt: "café" })),
		);
		const split = bytes.indexOf(0xc3) + 1;
		expect(split).toBeGreaterThan(0);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, split));
				controller.enqueue(bytes.slice(split));
				controller.close();
			},
		});
		const raw = request(body);
		await expect(readAiRunRequest(raw)).resolves.toMatchObject({
			prompt: "café",
		});
		expect(raw.body?.locked).toBe(false);
	});

	it("counts actual bytes despite a false Content-Length and cancels the reader", async () => {
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(MAX_AI_REQUEST_BYTES + 1));
			},
			cancel() {
				canceled = true;
			},
		});
		const raw = request(body, { headers: { "content-length": "1" } });
		await expect(readAiRunRequest(raw)).rejects.toMatchObject({ status: 413 });
		expect(canceled).toBe(true);
		expect(raw.body?.locked).toBe(false);
	});

	it.each(["{", new Uint8Array([0xff, 0xfe])])(
		"rejects malformed body %j",
		async (body) => {
			await expect(readAiRunRequest(request(body))).rejects.toMatchObject({
				status: 400,
			});
		},
	);

	it("cancels and unlocks a reader while a pull is pending", async () => {
		const pulling = deferred();
		const release = deferred();
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			pull() {
				pulling.resolve();
				return release.promise;
			},
			cancel() {
				canceled = true;
			},
		});
		const controller = new AbortController();
		const raw = request(body, { signal: controller.signal });
		const rejected = expect(readAiRunRequest(raw)).rejects.toMatchObject({
			status: 400,
		});
		await pulling.promise;
		controller.abort();
		release.resolve();
		await rejected;
		expect(canceled).toBe(true);
		expect(raw.body?.locked).toBe(false);
	});
});
