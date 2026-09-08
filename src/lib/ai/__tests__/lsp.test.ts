// @vitest-environment node
// The child-process seam is mocked so a synthetic node child stands in for a
// language server; no real language server is ever executed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../child-process.js", () => ({ spawn: mocks.spawn }));

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn as realSpawn } from "node:child_process";
import { LspError, LspFrameDecoder, LspSession, LSP_LIMITS } from "../lsp.js";

/**
 * A minimal server: answers initialize, then answers definition/references
 * with one location. `mode` perturbs it to exercise the failure paths.
 */
const server = (mode: string) => `
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
};
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const split = buffer.indexOf('\\r\\n\\r\\n');
    if (split === -1) return;
    const length = Number(/content-length:\\s*(\\d+)/i.exec(buffer.slice(0, split).toString())[1]);
    const start = split + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.slice(start, start + length).toString());
    buffer = buffer.slice(start + length);
    if (message.method === 'initialize') {
      ${mode === "no-init" ? "/* never answers */" : "send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });"}
      ${mode === "server-request" ? "send({ jsonrpc: '2.0', id: 9001, method: 'workspace/applyEdit', params: {} });" : ""}
    } else if (message.method && message.id !== undefined) {
      ${
				mode === "error"
					? "send({ jsonrpc: '2.0', id: message.id, error: { code: -1, message: 'no' } });"
					: mode === "malformed"
						? "send({ jsonrpc: '2.0', id: message.id, result: [{ uri: 'file:///a.ts' }] });"
						: mode === "link"
							? "send({ jsonrpc: '2.0', id: message.id, result: [{ targetUri: 'file:///a.ts', targetSelectionRange: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } }] });"
							: mode === "null"
								? "send({ jsonrpc: '2.0', id: message.id, result: null });"
								: mode === "hover-markup"
									? "send({ jsonrpc: '2.0', id: message.id, result: { contents: { kind: 'markdown', value: '**const** x: number' } } });"
									: mode === "hover-string"
										? "send({ jsonrpc: '2.0', id: message.id, result: { contents: 'plain hover' } });"
										: mode === "hover-marked-array"
											? "send({ jsonrpc: '2.0', id: message.id, result: { contents: [{ language: 'ts', value: 'const x: number' }, 'docs here'] } });"
											: mode === "hover-huge"
												? "send({ jsonrpc: '2.0', id: message.id, result: { contents: { kind: 'markdown', value: 'é'.repeat(20000) } } });"
												: mode === "hover-bad"
													? "send({ jsonrpc: '2.0', id: message.id, result: { contents: [42] } });"
													: "send({ jsonrpc: '2.0', id: message.id, result: [{ uri: 'file:///a.ts', range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } }] });"
			}
    }
  }
});
`;

function useServer(mode = "normal") {
	mocks.spawn.mockImplementation(() =>
		realSpawn(process.execPath, ["-e", server(mode)], {
			stdio: ["pipe", "pipe", "pipe"],
		}),
	);
}

async function session(mode = "normal") {
	useServer(mode);
	return LspSession.start("synthetic-lsp", [], "file:///repo");
}

beforeEach(() => mocks.spawn.mockReset());

describe("LspFrameDecoder", () => {
	const frame = (body: string) =>
		`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;

	it("decodes a whole frame", () => {
		const decoder = new LspFrameDecoder();
		expect(decoder.push(frame('{"jsonrpc":"2.0","id":1}'))).toEqual([
			{ jsonrpc: "2.0", id: 1 },
		]);
	});

	it("decodes frames split across chunks", () => {
		const decoder = new LspFrameDecoder();
		const whole = frame('{"jsonrpc":"2.0","id":1}');
		expect(decoder.push(whole.slice(0, 10))).toEqual([]);
		expect(decoder.push(whole.slice(10))).toEqual([{ jsonrpc: "2.0", id: 1 }]);
	});

	it("decodes several frames from one chunk", () => {
		const decoder = new LspFrameDecoder();
		expect(
			decoder.push(frame('{"jsonrpc":"2.0","id":1}') + frame('{"jsonrpc":"2.0","id":2}')),
		).toHaveLength(2);
	});

	it("rejects a header without a content length", () => {
		const decoder = new LspFrameDecoder();
		expect(() => decoder.push("Content-Type: x\r\n\r\n{}")).toThrow(LspError);
	});

	it("rejects an unparsable body", () => {
		const decoder = new LspFrameDecoder();
		expect(() => decoder.push(frame("not json"))).toThrow(LspError);
	});

	it("rejects an oversized declared frame", () => {
		const decoder = new LspFrameDecoder();
		expect(() =>
			decoder.push(`Content-Length: ${LSP_LIMITS.frameBytes + 1}\r\n\r\n`),
		).toThrow(expect.objectContaining({ code: "resource_limit" }));
	});

	it("rejects an unbounded header", () => {
		const decoder = new LspFrameDecoder();
		expect(() => decoder.push("x".repeat(LSP_LIMITS.frameBytes + 1))).toThrow(
			expect.objectContaining({ code: "resource_limit" }),
		);
	});
});

describe("LspSession", () => {
	it("returns one-based definition locations", async () => {
		const lsp = await session();
		try {
			expect(await lsp.definitions("file:///a.ts", 10, 3)).toEqual([
				{
					uri: "file:///a.ts",
					startLine: 5,
					startCharacter: 2,
					endLine: 5,
					endCharacter: 8,
				},
			]);
		} finally {
			await lsp.close();
		}
	});

	it("accepts a location link as well as a location", async () => {
		const lsp = await session("link");
		try {
			expect((await lsp.references("file:///a.ts", 10, 3))[0]).toMatchObject({
				uri: "file:///a.ts",
				startLine: 5,
			});
		} finally {
			await lsp.close();
		}
	});

	it("treats an empty result as no locations", async () => {
		const lsp = await session("null");
		try {
			expect(await lsp.definitions("file:///a.ts", 1, 0)).toEqual([]);
		} finally {
			await lsp.close();
		}
	});

	it("rejects a server error response", async () => {
		const lsp = await session("error");
		try {
			await expect(lsp.definitions("file:///a.ts", 1, 0)).rejects.toMatchObject({
				code: "protocol_error",
			});
		} finally {
			await lsp.close();
		}
	});

	it("rejects a malformed location", async () => {
		const lsp = await session("malformed");
		try {
			await expect(lsp.definitions("file:///a.ts", 1, 0)).rejects.toMatchObject({
				code: "protocol_error",
			});
		} finally {
			await lsp.close();
		}
	});

	it("refuses a server-initiated request instead of acting on it", async () => {
		// The server asks us to apply a workspace edit during startup; the
		// session must answer "method not found" and stay usable.
		const lsp = await session("server-request");
		try {
			expect(await lsp.definitions("file:///a.ts", 10, 3)).toHaveLength(1);
		} finally {
			await lsp.close();
		}
	});

	it("reports an unavailable server rather than pretending", async () => {
		// A missing binary fails asynchronously, exactly as node:spawn does.
		mocks.spawn.mockImplementation(() => {
			const child = new EventEmitter() as EventEmitter & {
				stdin: PassThrough;
				stdout: PassThrough;
				stderr: PassThrough;
				kill: () => boolean;
				exitCode: number | null;
				signalCode: string | null;
			};
			child.stdin = new PassThrough();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.kill = () => true;
			child.exitCode = null;
			child.signalCode = null;
			// A failed spawn closes without ever answering initialize.
			setImmediate(() => child.emit("close", null, null));
			return child;
		});
		const error = await LspSession.start(
			"diffing-definitely-not-installed",
			[],
			"file:///repo",
		).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(LspError);
		expect((error as LspError).code).toBe("unavailable");
	});

	it("rejects requests after close", async () => {
		const lsp = await session();
		await lsp.close();
		await expect(lsp.definitions("file:///a.ts", 1, 0)).rejects.toBeInstanceOf(
			LspError,
		);
	});

	it("returns markdown hover contents", async () => {
		const lsp = await session("hover-markup");
		try {
			expect(await lsp.hover("file:///a.ts", 10, 3)).toBe(
				"**const** x: number",
			);
		} finally {
			await lsp.close();
		}
	});

	it("accepts a plain-string hover", async () => {
		const lsp = await session("hover-string");
		try {
			expect(await lsp.hover("file:///a.ts", 10, 3)).toBe("plain hover");
		} finally {
			await lsp.close();
		}
	});

	it("renders a language-tagged MarkedString as a fenced block", async () => {
		const lsp = await session("hover-marked-array");
		try {
			expect(await lsp.hover("file:///a.ts", 10, 3)).toBe(
				"```ts\nconst x: number\n```\n\ndocs here",
			);
		} finally {
			await lsp.close();
		}
	});

	it("returns null when the server has no hover", async () => {
		const lsp = await session("null");
		try {
			expect(await lsp.hover("file:///a.ts", 10, 3)).toBeNull();
		} finally {
			await lsp.close();
		}
	});

	it("bounds an oversized hover without splitting a character", async () => {
		const lsp = await session("hover-huge");
		try {
			const result = await lsp.hover("file:///a.ts", 10, 3);
			if (result === null) throw new Error("expected hover contents");
			expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(
				LSP_LIMITS.hoverBytes + 5,
			);
			expect(result.endsWith("…")).toBe(true);
			expect(result.includes("�")).toBe(false);
		} finally {
			await lsp.close();
		}
	});

	it("rejects an unusable hover payload", async () => {
		const lsp = await session("hover-bad");
		try {
			await expect(lsp.hover("file:///a.ts", 10, 3)).rejects.toMatchObject({
				code: "protocol_error",
			});
		} finally {
			await lsp.close();
		}
	});
});
