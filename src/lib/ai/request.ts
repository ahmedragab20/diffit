import { z } from "zod";
import type { AiRunRequest } from "./types.js";

export const MAX_AI_REQUEST_BYTES = 4 * 1024 * 1024;
const text = (bytes: number) =>
	z
		.string()
		.max(bytes)
		.refine((value) => Buffer.byteLength(value, "utf8") <= bytes);
const identifier = text(512).refine(
	(value) => !!value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
);
const line = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const path = text(4096).refine((value) => !!value.trim());
const image = z
	.object({
		url: text(4096),
		name: text(512),
		mimeType: text(128),
		size: z.number().int().nonnegative().optional(),
	})
	.strict();
const shared = {
	draft: text(128 * 1024).optional(),
	commentBody: text(128 * 1024).optional(),
	replies: z
		.array(text(128 * 1024))
		.max(128)
		.optional(),
	attachmentPaths: z.array(path).max(8).optional(),
	imageAttachments: z.array(image).max(4).optional(),
};
const selection = z
	.object({
		filePath: path,
		side: z.enum(["additions", "deletions"]),
		startLine: line,
		endLine: line,
		selectedText: text(64 * 1024),
	})
	.strict()
	.refine((value) => value.endLine >= value.startLine);
const diff = z
	.object({
		...shared,
		kind: z.enum(["diff", "file", "selection", "comment-thread"]),
		repoName: text(512).optional(),
		branch: text(512).optional(),
		focusedFilePath: path.optional(),
		filePath: path.optional(),
		side: z.enum(["additions", "deletions"]).optional(),
		startLine: line.optional(),
		endLine: line.optional(),
		patch: text(2 * 1024 * 1024).optional(),
		selectedText: text(128 * 1024).optional(),
		selections: z.array(selection).max(8).optional(),
	})
	.strict()
	.refine(
		(value) =>
			value.startLine === undefined ||
			value.endLine === undefined ||
			value.endLine >= value.startLine,
	);
const plan = z
	.object({
		...shared,
		kind: z.enum([
			"plan",
			"plan-selection",
			"plan-thread",
			"plan-version-compare",
		]),
		planId: identifier,
		title: text(4096),
		version: line,
		body: text(2 * 1024 * 1024).optional(),
		bodyDraft: text(2 * 1024 * 1024).optional(),
		selectedText: text(128 * 1024).optional(),
		section: text(4096).optional(),
		previousVersion: line.optional(),
		previousBody: text(2 * 1024 * 1024).optional(),
	})
	.strict();
const mockup = z
	.object({
		...shared,
		kind: z.enum([
			"mockup",
			"mockup-screen",
			"mockup-region",
			"mockup-thread",
			"mockup-version-compare",
		]),
		mockupId: identifier,
		title: text(4096),
		version: line,
		screenId: identifier.optional(),
		screenLabel: text(4096).optional(),
		viewport: z.enum(["desktop", "tablet", "mobile"]).optional(),
		html: text(2 * 1024 * 1024).optional(),
		selectedHtml: text(128 * 1024).optional(),
		region: text(4096).optional(),
		previousVersion: line.optional(),
		previousHtml: text(2 * 1024 * 1024).optional(),
	})
	.strict();
const contextLabel = z
	.object({
		kind: text(128).optional(),
		filePath: path.optional(),
		label: text(4096).optional(),
		version: line.optional(),
		attachmentPaths: z.array(path).max(8).optional(),
		selectionLabels: z.array(text(4096)).max(8).optional(),
		imageAttachments: z.array(image).max(4).optional(),
	})
	.strict();
const schema = z
	.object({
		trigger: z.literal("user"),
		conversationId: text(160).refine((value) => !!value.trim()),
		modelId: identifier.refine((value) =>
			/^(codex|claude|opencode|cursor|xai|openai|anthropic)\/\S+$/.test(value),
		),
		surface: z.enum(["diff", "pr-diff", "plan", "mockup"]),
		mode: z.enum(["answer", "investigate"]).optional(),
		action: z.enum([
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
		]),
		prompt: text(128 * 1024).optional(),
		context: z.union([diff, plan, mockup]),
		reasoningEffort: text(64).optional(),
		serviceTier: text(64).optional(),
		history: z
			.array(
				z
					.object({
						id: identifier.optional(),
						role: z.enum(["user", "assistant"]),
						text: text(128 * 1024),
						createdAt: z.number().finite().nonnegative().optional(),
						modelId: identifier.optional(),
						context: contextLabel.optional(),
					})
					.strict(),
			)
			.max(200)
			.optional(),
	})
	.strict()
	.refine(({ surface, context }) =>
		surface === "plan"
			? context.kind.startsWith("plan")
			: surface === "mockup"
				? context.kind.startsWith("mockup")
				: !context.kind.startsWith("plan") && !context.kind.startsWith("mockup"),
	);

export class AiRequestError extends Error {
	constructor(
		readonly status: 400 | 404 | 413 | 415,
		message = "Invalid AI request.",
	) {
		super(message);
		this.name = "AiRequestError";
	}
}

/** Only wire references are accepted; resolved images and attachment contents are server-owned. */
export function parseAiRunRequest(value: unknown): AiRunRequest {
	if (
		!value ||
		typeof value !== "object" ||
		(value as { trigger?: unknown }).trigger !== "user"
	)
		throw new AiRequestError(
			400,
			"AI inference requires an explicit user trigger.",
		);
	const context = (value as { context?: unknown }).context;
	if (
		context &&
		typeof context === "object" &&
		"patch" in context &&
		context.patch !== undefined
	) {
		if (
			typeof context.patch !== "string" ||
			/^(?:\[object Object\](?:,\[object Object\])*)(?:\n(?:\[object Object\](?:,\[object Object\])*))*$/.test(
				context.patch.trim(),
			)
		)
			throw new AiRequestError(
				400,
				"The selected diff context could not be serialized. Refresh the review and try again.",
			);
	}
	const result = schema.safeParse(value);
	if (!result.success) throw new AiRequestError(400);
	return result.data;
}

/** Count actual bytes, including requests without a trustworthy Content-Length header. */
export async function readAiRunRequest(
	request: Request,
): Promise<AiRunRequest> {
	if (!request.body) throw new AiRequestError(400);
	const reader = request.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytes = 0;
	let body = "";
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	request.signal.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			request.signal.throwIfAborted();
			const { value, done } = await reader.read();
			request.signal.throwIfAborted();
			bytes += value?.byteLength ?? 0;
			if (bytes > MAX_AI_REQUEST_BYTES)
				throw new AiRequestError(413, "AI request exceeds the 4 MB limit.");
			body += decoder.decode(value, { stream: !done });
			if (done) break;
		}
		return parseAiRunRequest(JSON.parse(body));
	} catch (error) {
		if (error instanceof AiRequestError) throw error;
		throw new AiRequestError(400);
	} finally {
		request.signal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
