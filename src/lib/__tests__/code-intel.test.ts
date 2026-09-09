// @vitest-environment node
// The child-process seam is mocked so a synthetic node child stands in for a
// language server; no real language server is ever executed.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../ai/child-process.js", () => ({ spawn: mocks.spawn }));

import { spawn as realSpawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LanguageServers } from "../ai/language-servers.js";
import {
	codeIntel,
	codeIntelCapabilities,
	closeDraft,
	markersFromDiagnostics,
	syncDraft,
	type CodeIntelRequest,
} from "../code-intel.js";

/**
 * A real directory: the module opens documents off disk before asking about
 * them, so a fake root would make every lookup unreadable.
 */
const ROOT = mkdtempSync(join(tmpdir(), "code-intel-"));
mkdirSync(join(ROOT, "src"), { recursive: true });
writeFileSync(join(ROOT, "src/a.ts"), "export const a = 1;\n");

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** Answers initialize, then returns a result as configured. */
function useServer(resultJson: string) {
	const serverScript = `
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
			send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
		} else if (message.method && message.id !== undefined) {
			send({ jsonrpc: '2.0', id: message.id, result: ${resultJson} });
		}
	}
});
`;
	mocks.spawn.mockImplementation(() =>
		realSpawn(process.execPath, ["-e", serverScript], {
			stdio: ["pipe", "pipe", "pipe"],
		}),
	);
}

/** Answers a request with the list of methods the server has received. */
function useEchoServer() {
	const serverScript = `
let buffer = Buffer.alloc(0);
const seen = [];
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
		if (message.method) seen.push(message.method);
		if (message.method === 'initialize') {
			send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
		} else if (message.method && message.id !== undefined) {
			send({ jsonrpc: '2.0', id: message.id, result: { contents: { kind: 'markdown', value: seen.join(' ') } } });
		}
	}
});
`;
	mocks.spawn.mockImplementation(() =>
		realSpawn(process.execPath, ["-e", serverScript], {
			stdio: ["pipe", "pipe", "pipe"],
		}),
	);
}

const configured = () =>
	new LanguageServers({ ts: { command: "synthetic-lsp", args: [] } }, ROOT);

const clean = { customMode: false, prMode: false, staged: false };

/** One shared source range; the tests care about the uri, not the span. */
const range = { start: { line: 6, character: 1 }, end: { line: 6, character: 9 } };

function request(overrides: Partial<CodeIntelRequest> = {}): CodeIntelRequest {
	return {
		op: "hover",
		path: "src/a.ts",
		side: "additions",
		line: 7,
		character: 2,
		...overrides,
	};
}

beforeEach(() => mocks.spawn.mockReset());

describe("codeIntel", () => {
	it("refuses when no language server is configured", async () => {
		const servers = new LanguageServers({}, ROOT);
		const result = await codeIntel(servers, ROOT, clean, request());
		expect(result).toEqual({ available: false, reason: "not-configured" });
		await servers.close();
	});

	it("reports a missing server before the shape of the review", async () => {
		const servers = new LanguageServers({}, ROOT);
		const result = await codeIntel(
			servers,
			ROOT,
			{ ...clean, prMode: true },
			request(),
		);
		expect(result).toEqual({ available: false, reason: "not-configured" });
		await servers.close();
	});

	it("refuses a pull-request review", async () => {
		const servers = configured();
		const result = await codeIntel(
			servers,
			ROOT,
			{ ...clean, prMode: true },
			request(),
		);
		expect(result).toEqual({ available: false, reason: "pull-request" });
		await servers.close();
	});

	it("refuses a revision range", async () => {
		const servers = configured();
		const result = await codeIntel(
			servers,
			ROOT,
			{ ...clean, customMode: true },
			request(),
		);
		expect(result).toEqual({ available: false, reason: "revision-range" });
		await servers.close();
	});

	it("refuses a staged diff", async () => {
		const servers = configured();
		const result = await codeIntel(
			servers,
			ROOT,
			{ ...clean, staged: true },
			request(),
		);
		expect(result).toEqual({ available: false, reason: "staged" });
		await servers.close();
	});

	it("refuses the old side", async () => {
		const servers = configured();
		const result = await codeIntel(
			servers,
			ROOT,
			clean,
			request({ side: "deletions" }),
		);
		expect(result).toEqual({ available: false, reason: "old-side" });
		await servers.close();
	});

	it("refuses a path that escapes the repository", async () => {
		const servers = configured();
		const result = await codeIntel(
			servers,
			ROOT,
			clean,
			request({ path: "../etc/passwd" }),
		);
		expect(result).toEqual({ available: false, reason: "outside-repository" });
		await servers.close();
	});

	it("refuses an absolute path", async () => {
		const servers = configured();
		const result = await codeIntel(
			servers,
			ROOT,
			clean,
			request({ path: "/etc/passwd" }),
		);
		expect(result).toEqual({ available: false, reason: "outside-repository" });
		await servers.close();
	});

	it("refuses a language with no configured server", async () => {
		const servers = configured();
		const result = await codeIntel(
			servers,
			ROOT,
			clean,
			request({ path: "src/a.rs" }),
		);
		expect(result).toEqual({ available: false, reason: "unsupported-language" });
		await servers.close();
	});

	it("returns hover markdown", async () => {
		useServer(
			JSON.stringify({
				contents: { kind: "markdown", value: "**x**: number" },
			}),
		);
		const servers = configured();
		try {
			const result = await codeIntel(servers, ROOT, clean, request());
			expect(result).toEqual({
				available: true,
				op: "hover",
				hover: "**x**: number",
			});
		} finally {
			await servers.close();
		}
	});

	it("maps a definition inside the repository to a relative path", async () => {
		useServer(JSON.stringify([{ uri: pathToFileURL(join(ROOT, "src/a.ts")).href, range }]));
		const servers = configured();
		try {
			const result = await codeIntel(
				servers,
				ROOT,
				clean,
				request({ op: "definition" }),
			);
			expect(result).toEqual({
				available: true,
				op: "definition",
				locations: [
					{
						path: "src/a.ts",
						line: 7,
						character: 1,
						endLine: 7,
						endCharacter: 9,
						inRepository: true,
					},
				],
			});
		} finally {
			await servers.close();
		}
	});

	it("names a definition outside the repository without making it readable", async () => {
		useServer(JSON.stringify([{ uri: "file:///usr/lib/x.ts", range }]));
		const servers = configured();
		try {
			const result = await codeIntel(
				servers,
				ROOT,
				clean,
				request({ op: "definition" }),
			);
			expect(result).toEqual({
				available: true,
				op: "definition",
				locations: [
					{
						path: "/usr/lib/x.ts",
						line: 7,
						character: 1,
						endLine: 7,
						endCharacter: 9,
						inRepository: false,
					},
				],
			});
		} finally {
			await servers.close();
		}
	});

	it("drops a location with a non-file uri", async () => {
		useServer(JSON.stringify([{ uri: "untitled:Untitled-1", range }]));
		const servers = configured();
		try {
			const result = await codeIntel(
				servers,
				ROOT,
				clean,
				request({ op: "definition" }),
			);
			expect(result).toEqual({
				available: true,
				op: "definition",
				locations: [],
			});
		} finally {
			await servers.close();
		}
	});

	it("refuses a file that is not on disk", async () => {
		useServer(JSON.stringify(null));
		const servers = configured();
		try {
			const result = await codeIntel(servers, ROOT, clean, request({ path: "src/missing.ts" }));
			expect(result).toEqual({ available: false, reason: "file-unreadable" });
		} finally {
			await servers.close();
		}
	});

	it("refuses a file past the document size limit", async () => {
		writeFileSync(join(ROOT, "src/big.ts"), "x".repeat(4 * 1024 * 1024 + 1));
		useServer(JSON.stringify(null));
		const servers = configured();
		try {
			const result = await codeIntel(servers, ROOT, clean, request({ path: "src/big.ts" }));
			expect(result).toEqual({ available: false, reason: "file-too-large" });
		} finally {
			await servers.close();
		}
	});

	it("opens the document before asking about it", async () => {
		useEchoServer();
		const servers = configured();
		try {
			const result = await codeIntel(servers, ROOT, clean, request());
			if (result.available && result.op === "hover") {
				expect(result.hover).toContain("textDocument/didOpen");
			} else {
				throw new Error("Expected available hover result");
			}
		} finally {
			await servers.close();
		}
	});

	it("opens a document only once per session", async () => {
		useEchoServer();
		const servers = configured();
		try {
			await codeIntel(servers, ROOT, clean, request());
			const result = await codeIntel(servers, ROOT, clean, request());
			if (result.available && result.op === "hover" && result.hover) {
				const count = result.hover.split("textDocument/didOpen").length - 1;
				expect(count).toBe(1);
			} else {
				throw new Error("Expected available hover result");
			}
		} finally {
			await servers.close();
		}
	});

	it("sends a change when the file moved on since it was opened", async () => {
		useEchoServer();
		const servers = configured();
		try {
			await codeIntel(servers, ROOT, clean, request());
			writeFileSync(join(ROOT, "src/a.ts"), "export const a = 2;\n");
			await new Promise((r) => setTimeout(r, 12));
			const result = await codeIntel(servers, ROOT, clean, request());
			if (result.available && result.op === "hover") {
				expect(result.hover).toContain("textDocument/didChange");
			} else {
				throw new Error("Expected available hover result");
			}
		} finally {
			await servers.close();
		}
	});

	it("turns a failing language server into an explicit refusal", async () => {
		mocks.spawn.mockImplementation(() =>
			realSpawn(process.execPath, ["-e", "process.exit(1)"], {
				stdio: ["pipe", "pipe", "pipe"],
			}),
		);
		const servers = configured();
		try {
			const result = await codeIntel(servers, ROOT, clean, request());
			expect(result).toMatchObject({
				available: false,
				reason: "server-error",
			});
			expect(result).toHaveProperty("detail");
		} finally {
			await servers.close();
		}
	});
});

describe("codeIntelCapabilities", () => {
	it("reports nothing configured", () => {
		const servers = new LanguageServers({}, ROOT);
		const result = codeIntelCapabilities(servers, clean);
		expect(result).toEqual({
			configured: false,
			extensions: [],
			unavailable: "not-configured",
		});
	});

	it("reports the configured extensions", () => {
		const servers = configured();
		const result = codeIntelCapabilities(servers, clean);
		expect(result).toEqual({
			configured: true,
			extensions: ["ts"],
			unavailable: undefined,
		});
	});

	it("reports why a pull-request review cannot answer", () => {
		const servers = configured();
		const result = codeIntelCapabilities(servers, { ...clean, prMode: true });
		expect(result).toEqual({
			configured: true,
			extensions: ["ts"],
			unavailable: "pull-request",
		});
	});
});

describe("syncDraft", () => {
	it("refuses when no language server is configured", async () => {
		const servers = new LanguageServers({}, ROOT);
		try {
			const result = await syncDraft(
				servers,
				ROOT,
				clean,
				{ path: "src/a.ts", text: "test", version: 1 },
				() => {},
			);
			expect(result).toEqual({ ok: false, reason: "not-configured" });
		} finally {
			await servers.close();
		}
	});

	it("refuses a pull-request review", async () => {
		const servers = configured();
		try {
			const result = await syncDraft(
				servers,
				ROOT,
				{ ...clean, prMode: true },
				{ path: "src/a.ts", text: "test", version: 1 },
				() => {},
			);
			expect(result).toEqual({ ok: false, reason: "pull-request" });
		} finally {
			await servers.close();
		}
	});

	it("refuses a path that escapes the repository", async () => {
		const servers = configured();
		try {
			const result = await syncDraft(
				servers,
				ROOT,
				clean,
				{ path: "../evil.ts", text: "test", version: 1 },
				() => {},
			);
			expect(result).toEqual({ ok: false, reason: "outside-repository" });
		} finally {
			await servers.close();
		}
	});

	it("refuses a language with no configured server", async () => {
		const servers = configured();
		try {
			const result = await syncDraft(
				servers,
				ROOT,
				clean,
				{ path: "src/a.rs", text: "test", version: 1 },
				() => {},
			);
			expect(result).toEqual({ ok: false, reason: "unsupported-language" });
		} finally {
			await servers.close();
		}
	});

	it("refuses a draft past the document size limit", async () => {
		const servers = configured();
		try {
			const result = await syncDraft(
				servers,
				ROOT,
				clean,
				{ path: "src/a.ts", text: "x".repeat(4 * 1024 * 1024 + 1), version: 1 },
				() => {},
			);
			expect(result).toEqual({ ok: false, reason: "file-too-large" });
		} finally {
			await servers.close();
		}
	});

	it("opens the draft on first sync and changes it after", async () => {
		useEchoServer();
		const servers = configured();
		try {
			const result1 = await syncDraft(
				servers,
				ROOT,
				clean,
				{ path: "src/a.ts", text: "test1", version: 1 },
				() => {},
			);
			expect(result1).toEqual({ ok: true });

			const result2 = await syncDraft(
				servers,
				ROOT,
				clean,
				{ path: "src/a.ts", text: "test2", version: 2 },
				() => {},
			);
			expect(result2).toEqual({ ok: true });

			const codeIntelResult = await codeIntel(servers, ROOT, clean, request());
			if (codeIntelResult.available && codeIntelResult.op === "hover") {
				expect(codeIntelResult.hover).toContain("textDocument/didOpen");
				expect(codeIntelResult.hover).toContain("textDocument/didChange");
			} else {
				throw new Error("Expected available hover result");
			}
		} finally {
			await servers.close();
		}
	});

	it("leaves a draft alone when a lookup syncs from disk", async () => {
		useEchoServer();
		const servers = configured();
		try {
			const result = await syncDraft(
				servers,
				ROOT,
				clean,
				{ path: "src/a.ts", text: "draft text", version: 1 },
				() => {},
			);
			expect(result).toEqual({ ok: true });

			const codeIntelResult = await codeIntel(servers, ROOT, clean, request());
			if (codeIntelResult.available && codeIntelResult.op === "hover" && codeIntelResult.hover) {
				const openCount = codeIntelResult.hover.split("textDocument/didOpen").length - 1;
				const changeCount = codeIntelResult.hover.split("textDocument/didChange").length - 1;
				expect(openCount).toBe(1);
				expect(changeCount).toBe(0);
			} else {
				throw new Error("Expected available hover result");
			}
		} finally {
			await servers.close();
		}
	});
});

describe("markersFromDiagnostics", () => {
	it("maps a diagnostic onto a repository-relative marker", () => {
		const published = {
			uri: pathToFileURL(join(ROOT, "src/a.ts")).href,
			version: 7,
			diagnostics: [
				{
					severity: "warning" as const,
					message: "hm",
					source: "ts",
					startLine: 3,
					startCharacter: 1,
					endLine: 3,
					endCharacter: 5,
				},
			],
		};
		const result = markersFromDiagnostics(ROOT, published);
		expect(result).toEqual({
			path: "src/a.ts",
			version: 7,
			markers: [
				{
					severity: "warning",
					message: "hm",
					source: "ts",
					start: { line: 3, character: 1 },
					end: { line: 3, character: 5 },
				},
			],
		});
	});

	it("defaults a missing source", () => {
		const published = {
			uri: pathToFileURL(join(ROOT, "src/a.ts")).href,
			version: 7,
			diagnostics: [
				{
					severity: "warning" as const,
					message: "hm",
					startLine: 3,
					startCharacter: 1,
					endLine: 3,
					endCharacter: 5,
				},
			],
		};
		const result = markersFromDiagnostics(ROOT, published);
		expect(result).toEqual({
			path: "src/a.ts",
			version: 7,
			markers: [
				{
					severity: "warning",
					message: "hm",
					source: "lsp",
					start: { line: 3, character: 1 },
					end: { line: 3, character: 5 },
				},
			],
		});
	});

	it("ignores diagnostics for a file outside the repository", () => {
		const published = {
			uri: "file:///usr/lib/x.ts",
			version: 7,
			diagnostics: [
				{
					severity: "warning" as const,
					message: "hm",
					source: "ts",
					startLine: 3,
					startCharacter: 1,
					endLine: 3,
					endCharacter: 5,
				},
			],
		};
		const result = markersFromDiagnostics(ROOT, published);
		expect(result).toBeUndefined();
	});

	it("ignores a non-file uri", () => {
		const published = {
			uri: "untitled:Untitled-1",
			version: 7,
			diagnostics: [
				{
					severity: "warning" as const,
					message: "hm",
					source: "ts",
					startLine: 3,
					startCharacter: 1,
					endLine: 3,
					endCharacter: 5,
				},
			],
		};
		const result = markersFromDiagnostics(ROOT, published);
		expect(result).toBeUndefined();
	});
});

describe("codeIntel actions", () => {
	it("keeps only the open file from a multi-file rename", async () => {
		const here = pathToFileURL(join(ROOT, "src/a.ts")).href;
		useServer(
			JSON.stringify({
				changes: {
					[here]: [
						{
							range,
							newText: "renamed",
						},
					],
					"file:///elsewhere/b.ts": [
						{
							range,
							newText: "renamed",
						},
					],
				},
			}),
		);
		const servers = configured();
		try {
			const result = await codeIntel(
				servers,
				ROOT,
				clean,
				request({ op: "rename", newName: "renamed" }),
			);
			expect(result).toMatchObject({
				available: true,
				op: "rename",
				edits: {
					edits: [
						{
							range: {
								start: { line: 6, character: 1 },
								end: { line: 6, character: 9 },
							},
							newText: "renamed",
						},
					],
					otherEdits: 1,
					otherFiles: 1,
				},
			});
		} finally {
			await servers.close();
		}
	});

	it("marks a command-only action unavailable rather than hiding it", async () => {
		useServer(
			JSON.stringify([
				{ title: "Organize imports", command: "editor.action.organizeImports" },
				{
					title: "Fix this",
					edit: {
						changes: {
							[pathToFileURL(join(ROOT, "src/a.ts")).href]: [
								{ range, newText: "fixed" },
							],
						},
					},
				},
			]),
		);
		const servers = configured();
		try {
			const result = await codeIntel(
				servers,
				ROOT,
				clean,
				request({ op: "code-actions" }),
			);
			expect(result.available).toBe(true);
			if (!result.available || result.op !== "code-actions")
				throw new Error("expected code-actions");
			expect(result.actions[0]).toEqual({
				title: "Organize imports",
				kind: undefined,
				unavailable: "command-only",
			});
			expect(result.actions[1]?.unavailable).toBeUndefined();
			expect(result.actions[1]?.edits?.edits).toHaveLength(1);
		} finally {
			await servers.close();
		}
	});

	it("refuses a rename without a new name", async () => {
		const servers = configured();
		try {
			const result = await codeIntel(
				servers,
				ROOT,
				clean,
				request({ op: "rename" }),
			);
			expect(result).toEqual({ available: false, reason: "invalid-request" });
		} finally {
			await servers.close();
		}
	});
});
