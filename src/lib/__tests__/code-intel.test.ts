// @vitest-environment node
// The child-process seam is mocked so a synthetic node child stands in for a
// language server; no real language server is ever executed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../ai/child-process.js", () => ({ spawn: mocks.spawn }));

import { spawn as realSpawn } from "node:child_process";
import { LanguageServers } from "../ai/language-servers.js";
import {
	codeIntel,
	codeIntelCapabilities,
	type CodeIntelRequest,
} from "../code-intel.js";

const ROOT = "/repo";

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
		useServer(JSON.stringify([{ uri: "file:///repo/src/a.ts", range }]));
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
