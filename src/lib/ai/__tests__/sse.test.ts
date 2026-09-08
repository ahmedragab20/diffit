import { describe, expect, it } from "vitest";
import { consumeSseData } from "../sse.js";

const encoder = new TextEncoder();

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(chunks[index++]);
			else controller.close();
		},
	});
}

function chunks(...values: string[]): Uint8Array[] {
	return values.map((value) => encoder.encode(value));
}

describe("consumeSseData", () => {
	it("awaits fragmented UTF-8 and split CRLF and bare CR frames", async () => {
		const bytes = encoder.encode(
			"data: café\r\n\r\ndata: next\r\n\r\ndata: last\r\n\r\n",
		);
		const received: string[] = [];
		await consumeSseData(
			stream(Array.from(bytes, (byte) => new Uint8Array([byte]))),
			(data) => {
				received.push(data);
			},
		);
		expect(received).toEqual(["café", "next", "last"]);
		const bare: string[] = [];
		await consumeSseData(stream(chunks("data: bare\r\r")), (data) => {
			bare.push(data);
		});
		expect(bare).toEqual(["bare"]);
	});

	it("joins multiline data fields and ignores comments and event fields", async () => {
		const received: string[] = [];
		await consumeSseData(
			stream(
				chunks(": comment\n", "event: ignored\ndata: one\n", "data: two\n\n"),
			),
			(data) => {
				received.push(data);
			},
		);
		expect(received).toEqual(["one\ntwo"]);
	});

	it("flushes a trailing final frame", async () => {
		const received: string[] = [];
		await consumeSseData(stream(chunks("data: trailing")), (data) => {
			received.push(data);
		});
		expect(received).toEqual(["trailing"]);
	});

	it("cancels and unlocks the stream when the callback rejects", async () => {
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("data: value\n\n"));
			},
			cancel() {
				canceled = true;
			},
		});
		await expect(
			consumeSseData(body, async () => {
				throw new Error("sink failed");
			}),
		).rejects.toThrow("sink failed");
		expect(canceled).toBe(true);
		expect(body.locked).toBe(false);
	});

	it("stops and unlocks an otherwise open stream when callback returns true", async () => {
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("data: stop\n\n"));
			},
			cancel() {
				canceled = true;
			},
		});
		await consumeSseData(body, () => true);
		expect(canceled).toBe(true);
		expect(body.locked).toBe(false);
	});

	it("rejects frames larger than 1,048,576 JavaScript characters", async () => {
		const oversized = `data: ${"x".repeat(1_048_577)}\n\n`;
		await expect(
			consumeSseData(stream(chunks(oversized)), () => {}),
		).rejects.toThrow();
	});

	it("rejects AbortError while waiting for the next frame and unlocks the stream", async () => {
		const controller = new AbortController();
		let waiting!: () => void;
		const readPending = new Promise<void>((resolve) => {
			waiting = resolve;
		});
		let pulls = 0;
		let canceled = false;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(streamController) {
					if (pulls++ === 0)
						streamController.enqueue(encoder.encode("data: first\n\n"));
					else waiting();
				},
				cancel() {
					canceled = true;
				},
			},
			{ highWaterMark: 0 },
		);
		const pending = consumeSseData(body, () => {}, controller.signal);
		const rejected = expect(pending).rejects.toMatchObject({
			name: "AbortError",
		});
		await readPending;
		controller.abort();
		await rejected;
		expect(canceled).toBe(true);
		expect(body.locked).toBe(false);
	});

	it("rejects total stream bytes before decoding and cancels", async () => {
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
			},
			cancel() {
				canceled = true;
			},
		});
		await expect(consumeSseData(body, () => {})).rejects.toThrow(
			"total size limit",
		);
		expect(canceled).toBe(true);
		expect(body.locked).toBe(false);
	});

	it("rejects too many empty frames and unlocks the reader", async () => {
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("\n".repeat(100001)));
			},
			cancel() {
				canceled = true;
			},
		});
		await expect(consumeSseData(body, () => {})).rejects.toThrow("event limit");
		expect(canceled).toBe(true);
		expect(body.locked).toBe(false);
	});
});
