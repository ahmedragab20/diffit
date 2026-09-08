import { createHash } from "node:crypto";
import { AiRunError, DEFAULT_AI_RUN_POLICY } from "./lifecycle.js";

type RecordValue = Record<string, unknown>;
type Source = "claude" | "cursor" | "opencode";
function record(value: unknown): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new AiRunError("protocol_error");
	return value as RecordValue;
}
function string(value: unknown): string {
	if (typeof value !== "string") throw new AiRunError("protocol_error");
	return value;
}
function id(value: unknown): string {
	const result = string(value);
	if (!result || result.length > 512) throw new AiRunError("protocol_error");
	return result;
}
function content(value: unknown): string {
	if (!Array.isArray(value)) throw new AiRunError("protocol_error");
	return value
		.map((entry) => {
			const block = record(entry);
			if (block.type === "text") return string(block.text);
			if (
				["thinking", "redacted_thinking", "tool_use", "tool_result"].includes(
					string(block.type),
				)
			)
				return "";
			throw new AiRunError("protocol_error");
		})
		.join("");
}
interface MessageState {
	text: string;
	stopped: boolean;
	blocks: Map<number, { type: string; closed: boolean }>;
}

/** Version-one, text-only decoding. Native tool events never become assistant text or tool authority. */
export class RuntimeTextDecoder {
	private readonly source: Source;
	private session?: string;
	private terminal = false;
	private finalText?: string;
	private text = "";
	private outputBytes = 0;
	private inputBytes = 0;
	private events = 0;
	private activeMessage?: string;
	private stepMessage?: string;
	private readonly messages = new Map<string, MessageState>();
	private readonly parts = new Map<
		string,
		{ text: string; messageId: string }
	>();
	private readonly eventIds = new Map<string, string>();

	constructor(source: Source | "codex") {
		if (source === "codex") throw new AiRunError("unsupported_capability");
		this.source = source;
	}

	push(value: unknown): string {
		if (this.terminal) throw new AiRunError("protocol_error");
		const frame = record(value);
		const serialized = JSON.stringify(frame);
		const bytes = Buffer.byteLength(serialized, "utf8");
		this.inputBytes += bytes;
		if (
			++this.events > DEFAULT_AI_RUN_POLICY.maxEvents ||
			bytes > DEFAULT_AI_RUN_POLICY.maxEventBytes ||
			this.inputBytes > 16 * 1024 * 1024
		)
			throw new AiRunError("resource_limit");
		if (frame.is_error !== undefined && typeof frame.is_error !== "boolean")
			throw new AiRunError("protocol_error");
		if (frame.type === "error" || frame.is_error === true || frame.error != null)
			throw new AiRunError("provider_failed");
		const session = id(
			this.source === "opencode" ? frame.sessionID : frame.session_id,
		);
		if (this.session !== undefined && session !== this.session)
			throw new AiRunError("protocol_error");
		this.session = session;
		if (this.source === "claude" && frame.uuid !== undefined) {
			const eventId = id(frame.uuid);
			const hash = createHash("sha256").update(serialized).digest("hex");
			const previous = this.eventIds.get(eventId);
			if (previous !== undefined) {
				if (previous !== hash) throw new AiRunError("protocol_error");
				return "";
			}
			this.eventIds.set(eventId, hash);
		}
		const delta =
			this.source === "opencode" ? this.openCode(frame) : this.agent(frame);
		this.outputBytes += Buffer.byteLength(delta, "utf8");
		if (this.outputBytes > DEFAULT_AI_RUN_POLICY.maxOutputBytes)
			throw new AiRunError("resource_limit");
		this.text += delta;
		return delta;
	}

	finish(): string {
		if (!this.terminal) throw new AiRunError("protocol_error");
		const result = this.finalText ?? this.text;
		if (!result.trim()) throw new AiRunError("empty_output");
		return result;
	}

	private agent(frame: RecordValue): string {
		switch (frame.type) {
			case "result": {
				if (frame.subtype !== "success" || frame.is_error !== false)
					throw new AiRunError("provider_failed");
				if (frame.stop_reason === "max_tokens" || frame.stop_reason === "refusal")
					throw new AiRunError("provider_failed");
				if (frame.deferred_tool_use != null)
					throw new AiRunError("unsupported_capability");
				if ([...this.messages.values()].some((message) => !message.stopped))
					throw new AiRunError("protocol_error");
				const result = string(frame.result);
				if (
					Buffer.byteLength(result, "utf8") > DEFAULT_AI_RUN_POLICY.maxOutputBytes
				)
					throw new AiRunError("resource_limit");
				this.finalText = result;
				this.terminal = true;
				return "";
			}
			case "assistant": {
				const message = record(frame.message);
				if (message.role !== "assistant") throw new AiRunError("protocol_error");
				const text = content(message.content);
				if (this.source === "cursor") {
					// Cursor documents timestamp-only events as deltas; both flush forms duplicate them.
					if (
						frame.timestamp_ms !== undefined &&
						(typeof frame.timestamp_ms !== "number" ||
							!Number.isFinite(frame.timestamp_ms))
					)
						throw new AiRunError("protocol_error");
					if (frame.model_call_id !== undefined) id(frame.model_call_id);
					return frame.timestamp_ms !== undefined &&
						frame.model_call_id === undefined
						? text
						: "";
				}
				const messageId = id(message.id);
				const previous = this.messages.get(messageId);
				if (previous) {
					if (!previous.stopped || previous.text !== text)
						throw new AiRunError("protocol_error");
					return "";
				}
				this.messages.set(messageId, { text, stopped: true, blocks: new Map() });
				return text;
			}
			case "stream_event":
				if (this.source !== "claude") throw new AiRunError("protocol_error");
				id(frame.uuid);
				if (frame.parent_tool_use_id != null)
					throw new AiRunError("unsupported_capability");
				return this.claudeEvent(record(frame.event));
			case "system":
				string(frame.subtype);
				return "";
			case "user":
				if (record(frame.message).role !== "user")
					throw new AiRunError("protocol_error");
				return "";
			case "tool_call":
				if (
					this.source !== "cursor" ||
					!["started", "completed"].includes(string(frame.subtype))
				)
					throw new AiRunError("protocol_error");
				record(frame.tool_call);
				return "";
			case "rate_limit_event":
				if (this.source !== "claude") throw new AiRunError("protocol_error");
				record(frame.rate_limit_info);
				return "";
			case "thinking":
				// Private model reasoning is never assistant text.
				return "";
			default:
				throw new AiRunError("protocol_error");
		}
	}

	private claudeEvent(event: RecordValue): string {
		if (event.type === "message_start") {
			if (this.activeMessage && !this.messages.get(this.activeMessage)?.stopped)
				throw new AiRunError("protocol_error");
			const message = record(event.message);
			if (message.role !== "assistant") throw new AiRunError("protocol_error");
			const messageId = id(message.id);
			if (this.messages.has(messageId)) throw new AiRunError("protocol_error");
			const text = content(message.content);
			this.activeMessage = messageId;
			this.messages.set(messageId, { text, stopped: false, blocks: new Map() });
			return text;
		}
		const message = this.activeMessage
			? this.messages.get(this.activeMessage)
			: undefined;
		if (!message || message.stopped) throw new AiRunError("protocol_error");
		if (event.type === "message_stop") {
			if ([...message.blocks.values()].some((block) => !block.closed))
				throw new AiRunError("protocol_error");
			message.stopped = true;
			return "";
		}
		if (event.type === "message_delta") {
			const delta = record(event.delta);
			if (delta.stop_reason === "max_tokens" || delta.stop_reason === "refusal")
				throw new AiRunError("provider_failed");
			return "";
		}
		if (!Number.isSafeInteger(event.index) || Number(event.index) < 0)
			throw new AiRunError("protocol_error");
		const index = Number(event.index);
		const block = message.blocks.get(index);
		let text = "";
		if (event.type === "content_block_start") {
			if (block) throw new AiRunError("protocol_error");
			const value = record(event.content_block);
			const type = string(value.type);
			if (!["text", "thinking", "redacted_thinking", "tool_use"].includes(type))
				throw new AiRunError("protocol_error");
			message.blocks.set(index, { type, closed: false });
			if (type === "text") text = string(value.text);
		} else {
			if (!block || block.closed) throw new AiRunError("protocol_error");
			if (event.type === "content_block_stop") block.closed = true;
			else if (event.type === "content_block_delta") {
				const delta = record(event.delta);
				if (block.type === "text" && delta.type === "text_delta")
					text = string(delta.text);
				else if (
					!(
						block.type === "thinking" &&
						["thinking_delta", "signature_delta"].includes(string(delta.type))
					) &&
					!(block.type === "tool_use" && delta.type === "input_json_delta")
				)
					throw new AiRunError("protocol_error");
			} else throw new AiRunError("protocol_error");
		}
		message.text += text;
		return text;
	}

	private openCode(frame: RecordValue): string {
		const part = record(frame.part);
		if (part.sessionID !== this.session) throw new AiRunError("protocol_error");
		const messageId = id(part.messageID);
		if (frame.type === "step_start") {
			if (part.type !== "step-start" || this.stepMessage)
				throw new AiRunError("protocol_error");
			this.stepMessage = messageId;
			return "";
		}
		if (
			(frame.type === "tool_use" && part.type === "tool") ||
			(frame.type === "reasoning" && part.type === "reasoning")
		)
			return "";
		if (this.stepMessage !== messageId) throw new AiRunError("protocol_error");
		if (frame.type === "step_finish") {
			if (part.type !== "step-finish") throw new AiRunError("protocol_error");
			this.stepMessage = undefined;
			if (part.reason === "stop") this.terminal = true;
			else if (part.reason !== "tool-calls")
				throw new AiRunError("provider_failed");
			return "";
		}
		if (frame.type === "text") {
			if (part.type !== "text") throw new AiRunError("protocol_error");
			const partId = id(part.id);
			const text = string(part.text);
			const previous = this.parts.get(partId);
			if (previous !== undefined) {
				if (previous.text !== text || previous.messageId !== messageId)
					throw new AiRunError("protocol_error");
				return "";
			}
			this.parts.set(partId, { text, messageId });
			return text;
		}
		throw new AiRunError("protocol_error");
	}
}
