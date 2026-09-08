type Frame = Record<string, unknown>;

export const claude = (
	chunks: string[],
	options: { session?: string; result?: string } = {},
): Frame[] => {
	const session = options.session ?? "s";
	const result = options.result ?? chunks.join("");
	const frames: Frame[] = [
		{
			type: "stream_event",
			session_id: session,
			uuid: "u-start",
			event: {
				type: "message_start",
				message: { id: "m", role: "assistant", content: [] },
			},
		},
		{
			type: "stream_event",
			session_id: session,
			uuid: "u-block",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			},
		},
	];
	chunks.forEach((text, index) =>
		frames.push({
			type: "stream_event",
			session_id: session,
			uuid: `u-delta-${index}`,
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text },
			},
		}),
	);
	frames.push(
		{
			type: "stream_event",
			session_id: session,
			uuid: "u-stop-block",
			event: { type: "content_block_stop", index: 0 },
		},
		{
			type: "stream_event",
			session_id: session,
			uuid: "u-stop-message",
			event: { type: "message_stop" },
		},
		{
			type: "assistant",
			session_id: session,
			message: {
				id: "m",
				role: "assistant",
				content: [{ type: "text", text: chunks.join("") }],
			},
		},
		{
			type: "result",
			session_id: session,
			subtype: "success",
			is_error: false,
			result,
		},
	);
	return frames;
};

export const cursor = (
	chunks: string[],
	options: { session?: string; result?: string } = {},
): Frame[] => {
	const session = options.session ?? "s";
	const result = options.result ?? chunks.join("");
	return [
		...chunks.map((text, index) => ({
			type: "assistant",
			session_id: session,
			timestamp_ms: index + 1,
			message: { role: "assistant", content: [{ type: "text", text }] },
		})),
		...chunks.map((text, index) => ({
			type: "assistant",
			session_id: session,
			timestamp_ms: index + 1,
			model_call_id: `call-${index}`,
			message: { role: "assistant", content: [{ type: "text", text }] },
		})),
		{
			type: "assistant",
			session_id: session,
			message: { role: "assistant", content: [{ type: "text", text: result }] },
		},
		{
			type: "result",
			session_id: session,
			subtype: "success",
			is_error: false,
			result,
		},
	];
};

export const opencode = (
	chunks: string[],
	options: { session?: string; result?: string } = {},
): Frame[] => {
	const session = options.session ?? "s";
	return [
		{
			type: "step_start",
			sessionID: session,
			part: { sessionID: session, messageID: "m", type: "step-start" },
		},
		...chunks.map((text, index) => ({
			type: "text",
			sessionID: session,
			part: {
				sessionID: session,
				messageID: "m",
				id: `p${index}`,
				type: "text",
				text,
			},
		})),
		{
			type: "step_finish",
			sessionID: session,
			part: {
				sessionID: session,
				messageID: "m",
				type: "step-finish",
				reason: "stop",
			},
		},
	];
};

export function asNodeScript(frames: Frame[]): string {
	return frames
		.map((frame) => `console.log(${JSON.stringify(JSON.stringify(frame))});`)
		.join("\n");
}
