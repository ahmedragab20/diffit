const MAX_FRAME_CHARS = 1_048_576;

/** Consume SSE data across arbitrary UTF-8/newline chunks; true ends the stream. */
export async function consumeSseData(
	body: ReadableStream<Uint8Array>,
	onData: (data: string) => boolean | void | Promise<boolean | void>,
	signal?: AbortSignal,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let line = "";
	let data: string[] = [];
	let frameChars = 0;
	let streamBytes = 0;
	let frames = 0;
	let skipLf = false;
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	const dispatch = async () => {
		if (++frames > 100_000) throw new Error("AI stream exceeds the event limit.");
		const frame = data;
		data = [];
		frameChars = 0;
		if (!frame.length) return false;
		signal?.throwIfAborted();
		const stop = await onData(frame.join("\n"));
		signal?.throwIfAborted();
		return stop === true;
	};
	const consumeLine = async () => {
		frameChars += line.length + 1;
		if (frameChars > MAX_FRAME_CHARS)
			throw new Error("AI stream frame exceeds the size limit.");
		if (!line) return dispatch();
		if (line === "data") data.push("");
		else if (line.startsWith("data:")) {
			const value = line.slice(5);
			data.push(value.startsWith(" ") ? value.slice(1) : value);
		}
		return false;
	};

	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const { value, done } = await reader.read();
			signal?.throwIfAborted();
			streamBytes += value?.byteLength ?? 0;
			if (streamBytes > 16 * 1024 * 1024)
				throw new Error("AI stream exceeds the total size limit.");
			const chunk = decoder.decode(value, { stream: !done });
			let start = 0;
			for (let index = 0; index < chunk.length; index++) {
				const char = chunk[index];
				if (skipLf) {
					skipLf = false;
					if (char === "\n") {
						start = index + 1;
						continue;
					}
				}
				if (char !== "\r" && char !== "\n") continue;
				line += chunk.slice(start, index);
				if (await consumeLine()) return;
				line = "";
				start = index + 1;
				skipLf = char === "\r";
			}
			line += chunk.slice(start);
			if (frameChars + line.length > MAX_FRAME_CHARS)
				throw new Error("AI stream frame exceeds the size limit.");
			if (done) break;
		}
		if (line && (await consumeLine())) return;
		await dispatch();
	} finally {
		signal?.removeEventListener("abort", abort);
		try {
			await reader.cancel();
		} catch {
			/* Keep the original stream outcome. */
		}
		reader.releaseLock();
	}
}
