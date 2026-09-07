import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatComments } from "./lib/comment-format.js";
import { buildGitDiffArgs, parseDiffOptions } from "./lib/diff-options.js";
import {
	AWAIT_PLAN_TIMEOUT_NEXT_ACTION,
	AWAIT_REVIEW_TIMEOUT_NEXT_ACTION,
	AWAIT_TOOL_DESCRIPTION_SUFFIX,
	DEFAULT_AWAIT_TIMEOUT_SECONDS,
	PLAN_SUBMIT_NEXT_ACTION,
} from "./lib/handoff.js";
import { formatPlanReview } from "./lib/plan-format.js";
import {
	diffScopeKey,
	sameDiffScope,
	acquireServerStartupLease,
	isLockAlive,
	resolveActiveServerLock,
	removeServerLock,
	removeServerLockIfOwned,
	writeServerLock,
	type ServerLock,
	type ServerStartupLease,
} from "./lib/server-lock.js";
import { startServer } from "./server.js";
import { probeLockReviewUiSync } from "./lib/lock-probe.js";
import {
	generateSessionToken,
	isLoopbackHost,
	SESSION_TOKEN_HEADER,
} from "./lib/server-auth.js";
import {
	appendSessionToken,
	joinSessionApiUrl,
	reviewSessionBaseUrl,
	reviewSessionUrl,
} from "./lib/session-url.js";
import type { Plan } from "./lib/plan-types.js";
import type { Mockup } from "./lib/mockup-types.js";
import { formatMockupReview } from "./lib/mockup-format.js";
import { formatSubmitHints, type MockupStateHint } from "./lib/mockup-lint.js";
import type { ReviewComment } from "./lib/types.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
	const packagePath = resolve(moduleDirectory, "..", "package.json");
	let pkg: { version?: unknown };
	try {
		pkg = JSON.parse(readFileSync(packagePath, "utf-8")) as {
			version?: unknown;
		};
	} catch {
		throw new Error(`Invalid package.json at ${packagePath}`);
	}
	if (typeof pkg.version !== "string" || !pkg.version) {
		throw new Error(`Invalid package version in ${packagePath}`);
	}
	return pkg.version;
}

export const MCP_VERSION = readPackageVersion();

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const MUTATING = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
} as const;

const IDEMPOTENT_MUTATION = { ...MUTATING, idempotentHint: true } as const;

const AWAIT = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
} as const;

const commentSchema = z.object({
	id: z.string(),
	filePath: z.string(),
	side: z.enum(["deletions", "additions"]),
	lineNumber: z.number(),
	startLineNumber: z.number().optional(),
	lineContent: z.string(),
	body: z.string(),
	status: z.enum(["open", "resolved"]),
	createdAt: z.number(),
	/** Optional triage label; omitted / none = untriaged. Emitted on agent handoff XML. */
	severity: z.enum(["blocking", "nit", "question", "praise", "none"]).optional(),
	replies: z.array(
		z.object({
			id: z.string(),
			body: z.string(),
			createdAt: z.number(),
			role: z.enum(["user", "agent"]).optional(),
			model: z.string().optional(),
			createdAtPlanVersion: z.number().optional(),
		}),
	),
});

function textResult(text: string, structuredContent: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], structuredContent };
}

/** Resolve and validate an immutable repository binding without invoking a shell. */
export function resolveMcpRepository(
	repoPath = process.cwd(),
	explicit = false,
): string {
	if (explicit && !isAbsolute(repoPath)) {
		throw new Error("diffing mcp: --repo must be an absolute path");
	}

	let candidate: string;
	try {
		candidate = realpathSync(repoPath);
		if (!statSync(candidate).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new Error(
			`diffing mcp: repository path is not an accessible directory: ${repoPath}`,
		);
	}

	try {
		return execFileSync(
			"git",
			["-C", candidate, "rev-parse", "--show-toplevel"],
			{
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		).trim();
	} catch {
		throw new Error(
			`diffing mcp: path is not inside a Git repository: ${candidate}`,
		);
	}
}

interface DiffResponse {
	patch: string;
	repoName: string;
	branch: string;
	customMode: boolean;
	binaryFiles: Array<{
		path: string;
		type: "added" | "deleted" | "changed" | "untracked";
	}>;
	tabSizeMap: Record<string, number>;
	untrackedFiles: string[];
	showMode?: boolean;
	commits?: unknown[];
	truncated?: number;
}

export interface CreateMcpServerOptions {
	repoRoot: string;
	ownerId?: string;
	clientDir?: string;
	startServerFn?: typeof startServer;
	now?: () => number;
	readLock?: (repoRoot: string) => ServerLock | null;
	writeLock?: (lock: ServerLock) => void;
	removeLock?: (repoRoot: string) => void;
	lockIsAlive?: (lock: ServerLock, repoRoot: string) => boolean;
	acquireStartupLease?: (
		repoRoot: string,
		ownerId: string,
	) => ServerStartupLease | null;
	reviewUiIsReachable?: (lock: ServerLock) => boolean;
}

interface SessionStatus {
	repository: string;
	serverState: "running" | "not-running";
	mode: "none" | "web" | "gh-pr" | "tui";
	url: string | null;
	managedBy: "mcp" | "user" | null;
	diffArgs: string[];
	nextAction: string;
}

function lockUrl(lock: ServerLock): string | null {
	return reviewSessionUrl(lock);
}

async function requestJson<T>(
	base: string,
	path: string,
	init?: RequestInit,
	authToken?: string,
): Promise<T> {
	let response: Response;
	try {
		const headers = new Headers(init?.headers);
		if (authToken) headers.set(SESSION_TOKEN_HEADER, authToken);
		response = await fetch(joinSessionApiUrl(base, path), { ...init, headers });
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(
				`Request to ${path} was cancelled. Retry the MCP tool when ready.`,
			);
		}
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Cannot reach the diffing review server at ${base}: ${detail}. ` +
				"Call review_session_status, then start_review_session if needed.",
		);
	}

	const raw = await response.text();
	if (!response.ok) {
		let detail = raw.trim();
		try {
			const parsed = JSON.parse(raw) as { error?: unknown };
			if (typeof parsed.error === "string") detail = parsed.error;
		} catch {
			// Preserve the response body when it is not JSON.
		}
		throw new Error(
			`diffing server rejected ${init?.method ?? "GET"} ${path} with HTTP ${response.status}` +
				(detail ? `: ${detail}` : "") +
				".",
		);
	}

	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(
			`diffing server returned malformed JSON for ${path}. Check that client and server versions match.`,
		);
	}
}

function sameScope(
	lock: ServerLock,
	requestedScope: string,
	requestedArgs: string[],
): boolean {
	if (lock.scope) return sameDiffScope(lock.scope, requestedScope);
	// Locks written by older diffing versions had no scope metadata. Reuse only
	// for the default request; a non-default request must never silently inherit
	// an unknown scope.
	return requestedArgs.length === 0;
}

const SAFE_MCP_BOOLEAN_DIFF_ARGS = new Set([
	"--staged",
	"--cached",
	"--merge",
	"--no-indent-heuristic",
	"--ignore-space-change",
	"--ignore-all-space",
	"--ignore-blank-lines",
	"--ignore-cr-at-eol",
	"--function-context",
	"--find-copies-harder",
	"--pickaxe-all",
	"--no-ext-diff",
	"-b",
	"-w",
	"-W",
]);

const SAFE_MCP_VALUE_DIFF_ARGS = new Set([
	"--diff-algorithm",
	"--anchored",
	"--ws-error-highlight",
	"--unified",
	"--inter-hunk-context",
	"--find-copies",
	"--find-renames",
	"--break-rewrites",
	"--diff-filter",
	"--ignore-submodules",
	"-U",
	"-C",
	"-M",
	"-B",
	"-S",
	"-G",
]);

const SAFE_MCP_ENUM_VALUES: Record<string, ReadonlySet<string>> = {
	"--diff-algorithm": new Set(["minimal", "patience", "histogram", "myers"]),
	"--ws-error-highlight": new Set(["none", "default", "all"]),
	"--ignore-submodules": new Set(["none", "untracked", "dirty", "all"]),
};

const MAX_MCP_CONTEXT_LINES = 100_000;

function boundedMcpInteger(
	name: string,
	value: string,
	maximum: number,
): number {
	if (!/^\d+$/.test(value)) {
		throw new Error(
			`${name} requires a non-negative integer, received ${JSON.stringify(value)}.`,
		);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > maximum) {
		throw new Error(
			`${name} requires a safe integer from 0 to ${maximum}, received ${JSON.stringify(value)}.`,
		);
	}
	return parsed;
}

function validateMcpDiffValue(name: string, value: string): void {
	if (value.includes("\0"))
		throw new Error(`Value for ${name} must not contain NUL bytes.`);
	const allowed = SAFE_MCP_ENUM_VALUES[name];
	if (allowed && !allowed.has(value)) {
		throw new Error(
			`Unsupported value ${JSON.stringify(value)} for ${name}. Expected one of: ${[...allowed].join(", ")}.`,
		);
	}
	if (name === "--unified" || name === "--inter-hunk-context" || name === "-U") {
		boundedMcpInteger(name, value, MAX_MCP_CONTEXT_LINES);
	}
	if (["--find-copies", "--find-renames", "-C", "-M"].includes(name)) {
		boundedMcpInteger(name, value, 100);
	}
	if (name === "--break-rewrites" || name === "-B") {
		const parts = value.split("/");
		const invalidPart = parts.some((part) => {
			if (!/^\d+$/.test(part)) return true;
			const parsed = Number(part);
			return !Number.isSafeInteger(parsed) || parsed > 100;
		});
		if (parts.length > 2 || invalidPart) {
			throw new Error(
				`${name} requires one or two slash-separated integers from 0 to 100, received ${JSON.stringify(value)}.`,
			);
		}
	}
	if (
		name === "--diff-filter" &&
		!/^(?:[ACDMRTUXBacdmrtuxb]+\*?|\*)$/.test(value)
	) {
		throw new Error(
			`${name} contains unsupported filter letters: ${JSON.stringify(value)}.`,
		);
	}
}

function attachedShortOption(
	arg: string,
): { name: string; value: string } | null {
	const match = /^(-[UCMBGS])(.+)$/.exec(arg);
	return match ? { name: match[1], value: match[2] } : null;
}

/** Validate MCP-controlled git arguments before the general CLI parser sees them. */
export function validateMcpDiffArgs(diffArgs: string[]): void {
	let pathsOnly = false;
	for (let index = 0; index < diffArgs.length; index += 1) {
		const arg = diffArgs[index];
		if (arg.includes("\0"))
			throw new Error("diffArgs must not contain NUL bytes.");
		if (pathsOnly) continue;
		if (arg === "--") {
			pathsOnly = true;
			continue;
		}
		if (!arg.startsWith("-")) continue;
		if (SAFE_MCP_BOOLEAN_DIFF_ARGS.has(arg)) continue;

		const attached = attachedShortOption(arg);
		if (attached) {
			validateMcpDiffValue(attached.name, attached.value);
			continue;
		}

		const equals = arg.indexOf("=");
		const name = equals >= 0 ? arg.slice(0, equals) : arg;
		if (SAFE_MCP_VALUE_DIFF_ARGS.has(name)) {
			let value: string;
			if (equals < 0) {
				value = diffArgs[index + 1];
				if (value === undefined || value === "--" || value.startsWith("-")) {
					throw new Error(`Safe diff option ${name} requires a value.`);
				}
				index += 1;
			} else if (arg.slice(equals + 1).length === 0) {
				throw new Error(`Safe diff option ${name} requires a value.`);
			} else {
				value = arg.slice(equals + 1);
			}
			validateMcpDiffValue(name, value);
			continue;
		}

		throw new Error(
			`Unsafe or unsupported diff argument ${JSON.stringify(arg)}. ` +
				"start_review_session accepts only revision/path scope, filtering, whitespace, context, and rename-detection options; output, external-driver, and diffing runtime flags are forbidden.",
		);
	}
}

export function normalizeMcpDiffArgs(diffArgs: string[]): string[] {
	const normalized: string[] = [];
	let pathsOnly = false;
	for (let index = 0; index < diffArgs.length; index += 1) {
		const arg = diffArgs[index];
		if (arg === "--") pathsOnly = true;
		if (!pathsOnly && SAFE_MCP_VALUE_DIFF_ARGS.has(arg)) {
			const separator = arg.startsWith("--") ? "=" : "";
			normalized.push(`${arg}${separator}${diffArgs[index + 1]}`);
			index += 1;
		} else {
			normalized.push(arg);
		}
	}
	return normalized;
}

function expectedBuiltMcpArg(arg: string): string | null {
	const aliases: Record<string, string> = {
		"--cached": "--staged",
		"-b": "--ignore-space-change",
		"-w": "--ignore-all-space",
		"-W": "--function-context",
	};
	if (aliases[arg]) return aliases[arg];

	const attached = attachedShortOption(arg);
	if (attached) {
		const { name, value } = attached;
		if (name === "-U") return `--unified=${Number(value)}`;
		if (name === "-C") return Number(value) === 40 ? "-C" : `-C${Number(value)}`;
		if (name === "-M") return Number(value) === 50 ? "-M" : `-M${Number(value)}`;
		return arg;
	}

	const equals = arg.indexOf("=");
	if (equals < 0) return SAFE_MCP_BOOLEAN_DIFF_ARGS.has(arg) ? arg : null;
	const name = arg.slice(0, equals);
	const value = arg.slice(equals + 1);
	if (name === "--find-copies")
		return Number(value) === 40 ? "-C" : `-C${Number(value)}`;
	if (name === "--find-renames")
		return Number(value) === 50 ? "-M" : `-M${Number(value)}`;
	if (name === "--break-rewrites") return `-B${value}`;
	return arg;
}

function assertMcpModifiersAreEmitted(
	normalizedArgs: string[],
	parsed: ReturnType<typeof parseDiffOptions>,
): void {
	const builtArgs = buildGitDiffArgs(parsed);
	const separator = normalizedArgs.indexOf("--");
	const scopeArgs =
		separator < 0 ? normalizedArgs : normalizedArgs.slice(0, separator);
	for (const arg of scopeArgs) {
		if (!arg.startsWith("-")) continue;
		const expected = expectedBuiltMcpArg(arg);
		if (expected && !builtArgs.includes(expected)) {
			throw new Error(
				`Unsupported diff argument ${JSON.stringify(arg)}: it is not preserved in the final Git diff arguments.`,
			);
		}
	}
}

function validateMcpModifierAnchoring(
	diffArgs: string[],
	parsed: ReturnType<typeof parseDiffOptions>,
): void {
	if (parsed.revisions.length > 0 || parsed.pathspecs.length > 0) return;
	const baseline = new Set([
		"--staged",
		"--cached",
		"--patch",
		"-p",
		"--no-ext-diff",
		"--no-textconv",
	]);
	const modifiers = diffArgs
		.slice(
			0,
			Math.max(
				0,
				diffArgs.indexOf("--") === -1 ? diffArgs.length : diffArgs.indexOf("--"),
			),
		)
		.filter((arg) => arg.startsWith("-") && !baseline.has(arg));
	if (modifiers.length > 0) {
		throw new Error(
			`Diff modifiers ${modifiers.map((arg) => JSON.stringify(arg)).join(", ")} require a revision or a pathspec after --. ` +
				"Without that anchor diffing uses its baseline working-tree engine, which cannot honor these modifiers.",
		);
	}
}

interface SessionStartResult extends Record<string, unknown> {
	status: "started" | "reused";
	repository: string;
	url: string;
	mode: "web";
	managedBy: "mcp" | "user";
	diffArgs: string[];
	nextAction: string;
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
	const repoRoot = resolveMcpRepository(options.repoRoot, true);
	const startServerFn = options.startServerFn ?? startServer;
	const now = options.now ?? Date.now;
	const readLock = options.readLock ?? resolveActiveServerLock;
	const writeLock = options.writeLock ?? writeServerLock;
	const removeLock = options.removeLock ?? removeServerLock;
	const lockIsAlive = options.lockIsAlive ?? isLockAlive;
	const acquireStartupLease =
		options.acquireStartupLease ?? acquireServerStartupLease;
	const reviewUiIsReachable =
		options.reviewUiIsReachable ?? probeLockReviewUiSync;
	const ownerId = options.ownerId ?? randomUUID();
	const defaultClientDir = existsSync(resolve(moduleDirectory, "client"))
		? resolve(moduleDirectory, "client")
		: resolve(repoRoot, "dist/client");
	const clientDir = options.clientDir ?? defaultClientDir;

	const instructions =
		`diffing is bound to ${repoRoot} for this connection. ` +
		"First call review_session_status. If no web session is running, call start_review_session; it is safe to retry and never replaces a user session. " +
		"For code review, prefer diff_summary then paged diff_files/diff_hunks/diff_slice over get_diff; create_comment as needed. " +
		"Handoff: default is async — share the UI URL and end your turn; use await_review only when the human is reviewing now or asked you to wait. " +
		"For a GitHub PR session, call gh_overview and bounded diff tools; use gh_list_threads/reviews for discussion, and mutate GitHub only with explicit user authorization. " +
		"For plan review, call submit_plan, share the plan URL, and park unless asked to wait; then await_plan_review when sync waiting. " +
		"For HTML mockup review, call submit_mockup, share the mockup URL, and park unless asked to wait; then await_mockup_review when sync waiting. " +
		"A changes-requested verdict means revise and resubmit the same planId; rejected means stop; approved means proceed. " +
		"Wait tools return released or timeout with disposition/nextAction; timeout means park (do not silent-loop). MCP connects only to the loopback diffing server; explicitly authorized GitHub tools may make the server call GitHub.";

	const server = new McpServer(
		{ name: "diffing", version: MCP_VERSION },
		{ instructions },
	);
	let reviewCursor: { identity: string; round: number } | null = null;
	let planCursor: { identity: string; round: number } | null = null;
	let mockupCursor: { identity: string; round: number } | null = null;
	// Keep this MCP connection pinned after it starts or reuses a session. A
	// later human launch may change the repository-wide active pointer, but it
	// must not silently retarget in-flight MCP tools.
	let selectedLock: ServerLock | null = null;

	function liveLock(): ServerLock | null {
		if (selectedLock && lockIsAlive(selectedLock, repoRoot)) return selectedLock;
		selectedLock = null;
		const lock = readLock(repoRoot);
		return lock && lockIsAlive(lock, repoRoot) ? lock : null;
	}

	function ensureReusableLock(lock: ServerLock): void {
		if (
			lock.owner === "mcp" &&
			(lock.pid !== process.pid || lock.ownerId !== ownerId)
		) {
			throw new Error(
				`A different diffing MCP connection (${lock.pid}/${lock.ownerId ?? "legacy"}) owns this repository session. ` +
					"Its web server lifecycle is tied to that MCP connection; stop it or wait for it to exit, then retry.",
			);
		}
		if (!isLoopbackHost(lock.host)) {
			throw new Error(
				`The active diffing session is bound to non-loopback host ${JSON.stringify(lock.host)}. ` +
					"MCP refuses LAN/remote review URLs; end it and call start_review_session for a loopback-only session.",
			);
		}
	}

	type LiveSession = { lock: ServerLock; apiOrigin: string; identity: string };

	function requireAnySession(): LiveSession {
		const lock = liveLock();
		if (!lock) {
			throw new Error(
				`No diffing review session is running for ${repoRoot}. ` +
					'Start one with start_review_session, `diffing --web`, or `diffing "gh pr <ref>"`, then retry.',
			);
		}
		ensureReusableLock(lock);
		const apiOrigin = reviewSessionBaseUrl(lock);
		if (!apiOrigin) {
			throw new Error(
				"The active diffing session does not expose a reachable loopback API.",
			);
		}
		return {
			lock,
			apiOrigin,
			identity: `${lock.pid}:${lock.startedAt}:${lock.port}:${lock.ownerId ?? ""}`,
		};
	}

	function requireWebSession(): LiveSession {
		const session = requireAnySession();
		const mode = session.lock.mode ?? "web";
		if (mode === "gh-pr") {
			throw new Error(
				"The active diffing session is a GitHub PR review, not a local review. " +
					"Use gh_* tools and bounded diff_* inspect tools, or end the PR session for local review/plan tools.",
			);
		}
		return session;
	}

	function requireGhPrSession(): LiveSession {
		const session = requireAnySession();
		if ((session.lock.mode ?? "web") !== "gh-pr") {
			throw new Error(
				'This tool requires an active GitHub PR session (`diffing "gh pr <ref>"` or --gh-pr).',
			);
		}
		return session;
	}

	function requestSessionJson<T>(
		session: LiveSession,
		path: string,
		init: RequestInit = {},
	): Promise<T> {
		const headers = new Headers(init.headers);
		if (session.lock.mode === "tui") {
			if (!session.lock.capability)
				throw new Error("The TUI lock is missing its API capability.");
			headers.set("X-Diffing-Capability", session.lock.capability);
		} else if (session.lock.authToken) {
			headers.set(SESSION_TOKEN_HEADER, session.lock.authToken);
		}
		return requestJson<T>(
			session.apiOrigin,
			path,
			{ ...init, headers },
			session.lock.authToken,
		);
	}

	function requestBaseJson<T>(path: string, init?: RequestInit): Promise<T> {
		return requestSessionJson<T>(requireWebSession(), path, init);
	}

	/** Bounded inspect works for web, tui, and gh-pr sessions. */
	function requireInspectSession(): LiveSession {
		return requireAnySession();
	}

	async function seedReviewCursor(
		session: ReturnType<typeof requireWebSession>,
		signal?: AbortSignal,
	): Promise<number> {
		if (reviewCursor?.identity === session.identity) return reviewCursor.round;
		const status = await requestSessionJson<{ round?: number }>(
			session,
			"/api/review/status",
			{ signal },
		);
		// On first attachment replay the latest cached handoff if one exists.
		reviewCursor = {
			identity: session.identity,
			round: Math.max(0, (status.round ?? 0) - 1),
		};
		return reviewCursor.round;
	}

	async function seedPlanCursor(
		session: ReturnType<typeof requireWebSession>,
		signal?: AbortSignal,
		force = false,
	): Promise<number> {
		if (!force && planCursor?.identity === session.identity)
			return planCursor.round;
		const status = await requestSessionJson<{ round?: number }>(
			session,
			"/api/plan-review/status",
			{ signal },
		);
		planCursor = {
			identity: session.identity,
			round: force ? (status.round ?? 0) : Math.max(0, (status.round ?? 0) - 1),
		};
		return planCursor.round;
	}

	async function seedMockupCursor(
		session: ReturnType<typeof requireWebSession>,
		signal?: AbortSignal,
		force = false,
	): Promise<number> {
		if (!force && mockupCursor?.identity === session.identity)
			return mockupCursor.round;
		const status = await requestSessionJson<{ round?: number }>(
			session,
			"/api/mockup-review/status",
			{ signal },
		);
		mockupCursor = {
			identity: session.identity,
			round: force ? (status.round ?? 0) : Math.max(0, (status.round ?? 0) - 1),
		};
		return mockupCursor.round;
	}

	function sessionStatus(): SessionStatus {
		const lock = liveLock();
		if (!lock) {
			return {
				repository: repoRoot,
				serverState: "not-running",
				mode: "none",
				url: null,
				managedBy: null,
				diffArgs: [],
				nextAction: "Call start_review_session, then get_diff.",
			};
		}
		const mode = lock.mode ?? "web";
		const url = lockUrl(lock);
		const inaccessible = url === null;
		return {
			repository: repoRoot,
			serverState: "running",
			mode,
			url,
			managedBy: lock.owner === "mcp" ? "mcp" : "user",
			diffArgs: lock.diffArgs ?? [],
			nextAction: inaccessible
				? "This session is not loopback-only, so MCP will not connect to it. End it manually and call start_review_session."
				: mode === "tui"
					? "Use bounded diff_summary/diff_files/diff_hunks/diff_slice/diff_search, then local review tools."
					: mode === "gh-pr"
						? "Use gh_overview, then diff_summary→diff_files→diff_hunks/diff_slice/diff_search. For discussion use gh_list_threads (prefer unresolvedOnly). Do not fetch the full patch via get_diff."
						: "Prefer diff_summary→diff_files→diff_slice over get_diff. Use plan-review tools when gating implementation.",
		};
	}

	server.registerTool(
		"review_session_status",
		{
			title: "Get review session status",
			description:
				"Inspect the repository binding and active diffing session. Works when no web server is running; use its nextAction before other tools.",
			inputSchema: {},
			outputSchema: {
				repository: z.string(),
				serverState: z.enum(["running", "not-running"]),
				mode: z.enum(["none", "web", "gh-pr", "tui"]),
				url: z.string().nullable(),
				managedBy: z.enum(["mcp", "user"]).nullable(),
				diffArgs: z.array(z.string()),
				nextAction: z.string(),
			},
			annotations: READ_ONLY,
		},
		async () => {
			const status = sessionStatus();
			return textResult(
				status.serverState === "running"
					? `diffing ${status.mode} session is running for ${repoRoot}${status.url ? ` at ${status.url}` : ""}. ${status.nextAction}`
					: `No diffing web session is running for ${repoRoot}. ${status.nextAction}`,
				{ ...status },
			);
		},
	);

	let startQueue: Promise<void> = Promise.resolve();
	server.registerTool(
		"start_review_session",
		{
			title: "Start or reuse a local review session",
			description:
				"Idempotently reuse a matching web review session or start a headless loopback-only session on an OS-selected port. Modifiers require a revision or pathspec anchor so the custom engine honors them. Arguments are never passed to a shell; incompatible sessions are reported, never stopped.",
			inputSchema: {
				diffArgs: z
					.array(z.string())
					.optional()
					.describe(
						'Optional git-diff arguments, for example ["--staged"] or ["main...HEAD", "--", "src/"].',
					),
			},
			outputSchema: {
				status: z.enum(["started", "reused"]),
				repository: z.string(),
				url: z.string(),
				mode: z.literal("web"),
				managedBy: z.enum(["mcp", "user"]),
				diffArgs: z.array(z.string()),
				nextAction: z.string(),
			},
			annotations: IDEMPOTENT_MUTATION,
		},
		async ({ diffArgs = [] }) => {
			validateMcpDiffArgs(diffArgs);
			const normalizedArgs = normalizeMcpDiffArgs(diffArgs);
			const parsed = parseDiffOptions(normalizedArgs);
			validateMcpModifierAnchoring(diffArgs, parsed);
			// The allowlist preserves line-oriented patches. These assignments are a
			// second invariant at the typed boundary in case the general parser grows
			// new defaults later.
			parsed.outputMode = "web";
			parsed.host = "127.0.0.1";
			parsed.port = undefined;
			parsed.noOpen = true;
			parsed.noExtDiff = true;
			parsed.textconv = false;
			parsed.extDiff = undefined;
			// `undefined` is the parser's canonical ordinary unified-patch mode.
			parsed.outputFormat = undefined;
			parsed.outputFile = undefined;
			parsed.exitCode = false;
			parsed.quiet = false;
			parsed.check = false;
			parsed.binary = false;
			assertMcpModifiersAreEmitted(normalizedArgs, parsed);
			const requestedScope = diffScopeKey(parsed);

			const operation = startQueue.then(async (): Promise<SessionStartResult> => {
				const reuse = (existing: ServerLock): SessionStartResult => {
					ensureReusableLock(existing);
					const mode = existing.mode ?? "web";
					if (mode !== "web") {
						throw new Error(
							`A live ${mode} diffing session already owns this repository. ` +
								"diffing will not replace or stop it; end that session manually before starting a local web review.",
						);
					}
					if (!sameScope(existing, requestedScope, diffArgs)) {
						throw new Error(
							"A live diffing web session already shows a different diff scope. " +
								`Requested arguments: ${JSON.stringify(diffArgs)}. ` +
								"Use the existing session or end it manually; diffing will not replace it.",
						);
					}
					if (!reviewUiIsReachable(existing)) {
						throw new Error(
							"A live diffing API matches this scope, but its human review UI is unavailable. " +
								"The client bundle may be missing or mid-rebuild; rebuild it or restart that session before retrying.",
						);
					}
					const url = lockUrl(existing);
					if (!url)
						throw new Error(
							"The active diffing web session has no safe loopback URL.",
						);
					selectedLock = existing;
					return {
						status: "reused",
						repository: repoRoot,
						url,
						mode: "web",
						managedBy: existing.owner === "mcp" ? "mcp" : "user",
						diffArgs: existing.diffArgs ?? diffArgs,
						nextAction: "Call get_diff to inspect the active diff.",
					};
				};

				const beforeLease = liveLock();
				if (beforeLease) return reuse(beforeLease);

				const lease = acquireStartupLease(repoRoot, ownerId);
				if (!lease) {
					throw new Error(
						"Another diffing process is starting a review session for this repository. " +
							"Retry start_review_session after that startup completes.",
					);
				}

				try {
					// Cross-process race guard: the lease winner must recheck server.json
					// because another process may have completed startup before acquisition.
					const afterLease = liveLock();
					if (afterLease) return reuse(afterLease);

					const authToken = generateSessionToken();
					const started = await startServerFn({
						port: 0,
						host: "127.0.0.1",
						clientDir,
						diffOpts: parsed,
						security: {
							bindHost: "127.0.0.1",
							authToken,
						},
					});
					const lock: ServerLock = {
						port: started.port,
						host: "127.0.0.1",
						pid: process.pid,
						repoRoot,
						startedAt: now(),
						version: MCP_VERSION,
						mode: "web",
						scope: requestedScope,
						diffArgs: [...diffArgs],
						owner: "mcp",
						ownerId,
						sessionId: ownerId,
						authToken,
					};
					try {
						writeLock(lock);
					} catch (error) {
						await started.close?.().catch(() => {});
						// Never report success and never leave a lock claiming ownership.
						const persisted = readLock(repoRoot);
						if (persisted?.owner === "mcp" && persisted.ownerId === ownerId) {
							removeLock(repoRoot);
						}
						const detail = error instanceof Error ? error.message : String(error);
						throw new Error(
							`The review server bound locally but its discovery lock could not be written: ${detail}. ` +
								"No MCP session was claimed and the unadvertised listener was closed; retry after fixing lock storage.",
						);
					}
					selectedLock = lock;
					return {
						status: "started",
						repository: repoRoot,
						url: lockUrl(lock)!,
						mode: "web",
						managedBy: "mcp",
						diffArgs: [...diffArgs],
						nextAction: "Call get_diff to inspect the active diff.",
					};
				} finally {
					lease.release();
				}
			});

			startQueue = operation.then(
				() => undefined,
				() => undefined,
			);
			const result = await operation;
			return textResult(
				`${result.status === "started" ? "Started" : "Reused"} review session at ${result.url}.`,
				result,
			);
		},
	);

	server.registerTool(
		"get_diff",
		{
			title: "Get the active local diff",
			description:
				"Fetch the complete patch and basic repository metadata from the active local web review. Start or locate the session first.",
			inputSchema: {},
			outputSchema: {
				patch: z.string(),
				repoName: z.string(),
				branch: z.string(),
				customMode: z.boolean(),
				binaryFiles: z.array(
					z.object({
						path: z.string(),
						type: z.enum(["added", "deleted", "changed", "untracked"]),
					}),
				),
				tabSizeMap: z.record(z.string(), z.number()),
				untrackedFiles: z.array(z.string()),
				showMode: z.boolean().optional(),
				commits: z.array(z.unknown()).optional(),
				truncated: z.number().optional(),
			},
			annotations: READ_ONLY,
		},
		async () => {
			const diff = await requestBaseJson<DiffResponse>("/api/diff");
			const structured = {
				patch: diff.patch,
				repoName: diff.repoName,
				branch: diff.branch,
				customMode: diff.customMode,
				binaryFiles: diff.binaryFiles,
				tabSizeMap: diff.tabSizeMap,
				untrackedFiles: diff.untrackedFiles,
				...(typeof diff.showMode === "boolean" ? { showMode: diff.showMode } : {}),
				...(Array.isArray(diff.commits) ? { commits: diff.commits } : {}),
				...(typeof diff.truncated === "number"
					? { truncated: diff.truncated }
					: {}),
			};
			return textResult(diff.patch || "(The active diff is empty.)", structured);
		},
	);

	server.registerTool(
		"diff_summary",
		{
			title: "Summarize the active diff (bounded)",
			description:
				"Return bounded totals, top-level directory buckets, and change-kind counts without transferring the patch. " +
				'Optional exclude=["lockfiles"] drops lock/generated basenames from counts only. ' +
				"Works for web, TUI, and GitHub PR sessions. Prefer this over get_diff.",
			inputSchema: {
				exclude: z.array(z.enum(["lockfiles"])).optional(),
			},
			outputSchema: { result: z.unknown() },
			annotations: READ_ONLY,
		},
		async ({ exclude } = { exclude: undefined }) => {
			const session = requireInspectSession();
			const query = new URLSearchParams();
			if (exclude?.length) query.set("exclude", exclude.join(","));
			const suffix = query.size ? `?${query}` : "";
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				`/api/diff/summary${suffix}`,
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"diff_files",
		{
			title: "Page changed files (bounded)",
			description:
				"Return a bounded page of changed-file metadata. Optional path is a git pathspec-ish glob " +
				"(src/lib/**, **/foo.ts). cursor/nextCursor index the filtered list; each row still has the global file index. " +
				"Works for web, TUI, and GitHub PR sessions.",
			inputSchema: {
				cursor: z.number().int().nonnegative().optional(),
				limit: z.number().int().positive().max(1000).optional(),
				path: z.string().min(1).optional(),
			},
			outputSchema: { result: z.unknown() },
			annotations: READ_ONLY,
		},
		async ({ cursor = 0, limit = 100, path }) => {
			const session = requireInspectSession();
			const query = new URLSearchParams({
				cursor: String(cursor),
				limit: String(limit),
			});
			if (path) query.set("path", path);
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				`/api/diff/files?${query}`,
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"diff_hunks",
		{
			title: "Page hunk metadata (bounded)",
			description:
				"Return bounded hunk metadata for one file. Pass path (glob resolving to exactly one file) or file (global index), not both. " +
				"Pass generation from diff_summary to reject stale navigation. Works for web, TUI, and GitHub PR sessions.",
			inputSchema: {
				file: z.number().int().nonnegative().optional(),
				path: z.string().min(1).optional(),
				generation: z.number().int().nonnegative().optional(),
				cursor: z.number().int().nonnegative().optional(),
				limit: z.number().int().positive().max(1000).optional(),
			},
			outputSchema: { result: z.unknown() },
			annotations: READ_ONLY,
		},
		async ({ file, path, generation, cursor = 0, limit = 100 }) => {
			const session = requireInspectSession();
			const query = new URLSearchParams({
				cursor: String(cursor),
				limit: String(limit),
			});
			if (file !== undefined) query.set("file", String(file));
			if (path) query.set("path", path);
			if (generation !== undefined) query.set("generation", String(generation));
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				`/api/diff/hunks?${query}`,
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"diff_slice",
		{
			title: "Read a bounded diff slice",
			description:
				"Read exact logical rows for one file with strict line and byte budgets; use nextRow to continue. " +
				"Pass path (glob resolving to exactly one file) or file (global index), not both. " +
				"Works for web, TUI, and GitHub PR sessions. Prefer this over get_diff.",
			inputSchema: {
				file: z.number().int().nonnegative().optional(),
				path: z.string().min(1).optional(),
				start: z.number().int().nonnegative().optional(),
				generation: z.number().int().nonnegative().optional(),
				maxLines: z.number().int().positive().max(1000).optional(),
				maxBytes: z
					.number()
					.int()
					.positive()
					.max(4 * 1024 * 1024)
					.optional(),
			},
			outputSchema: { result: z.unknown() },
			annotations: READ_ONLY,
		},
		async ({
			file,
			path,
			start = 0,
			generation,
			maxLines = 120,
			maxBytes = 256 * 1024,
		}) => {
			const session = requireInspectSession();
			const query = new URLSearchParams({
				start: String(start),
				maxLines: String(maxLines),
				maxBytes: String(maxBytes),
			});
			if (file !== undefined) query.set("file", String(file));
			if (path) query.set("path", path);
			if (generation !== undefined) query.set("generation", String(generation));
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				`/api/diff/slice?${query}`,
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"diff_search",
		{
			title: "Search the active diff (bounded)",
			description:
				"Search changed paths and content with bounded hits/bytes and generation-safe continuation coordinates. " +
				"Optional path glob limits hits to matching files (in addition to file+row continuation). " +
				"Works for web, TUI, and GitHub PR sessions.",
			inputSchema: {
				query: z.string().min(1),
				path: z.string().min(1).optional(),
				generation: z.number().int().nonnegative().optional(),
				file: z.number().int().nonnegative().optional(),
				row: z.number().int().nonnegative().optional(),
				limit: z.number().int().positive().max(1000).optional(),
				maxBytes: z
					.number()
					.int()
					.positive()
					.max(4 * 1024 * 1024)
					.optional(),
			},
			outputSchema: { result: z.unknown() },
			annotations: READ_ONLY,
		},
		async ({
			query,
			path,
			generation,
			file = 0,
			row = 0,
			limit = 100,
			maxBytes = 256 * 1024,
		}) => {
			const session = requireInspectSession();
			const params = new URLSearchParams({
				q: query,
				file: String(file),
				row: String(row),
				limit: String(limit),
				maxBytes: String(maxBytes),
			});
			if (path) params.set("path", path);
			if (generation !== undefined) params.set("generation", String(generation));
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				`/api/diff/search?${params}`,
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	// ── GitHub PR tools (mode: gh-pr) ──────────────────────────────────────────

	server.registerTool(
		"gh_overview",
		{
			title: "GitHub PR overview (slim)",
			description:
				"Return compact PR identity, SHAs, size stats, and thread/review/draft counts without the patch or full conversation bodies. " +
				"Requires an active gh-pr session.",
			inputSchema: {},
			outputSchema: { result: z.unknown() },
			annotations: READ_ONLY,
		},
		async () => {
			const session = requireGhPrSession();
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				"/api/gh/overview",
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"gh_list_threads",
		{
			title: "List published PR review threads",
			description:
				"Page published GitHub review threads with filters. Prefer unresolvedOnly=true. " +
				"Bodies are truncated by default; set fullBody for complete text. format=xml for agent XML.",
			inputSchema: {
				unresolvedOnly: z.boolean().optional(),
				path: z.string().optional(),
				author: z.string().optional(),
				cursor: z.number().int().nonnegative().optional(),
				limit: z.number().int().positive().max(200).optional(),
				replyCursor: z.number().int().nonnegative().optional(),
				replyLimit: z.number().int().positive().max(100).optional(),
				bodyMaxChars: z.number().int().positive().max(50_000).optional(),
				fullBody: z.boolean().optional(),
				format: z.enum(["json", "xml"]).optional(),
			},
			outputSchema: { result: z.unknown() },
			annotations: READ_ONLY,
		},
		async ({
			unresolvedOnly,
			path,
			author,
			cursor = 0,
			limit = 50,
			replyCursor,
			replyLimit,
			bodyMaxChars = 500,
			fullBody,
			format = "json",
		}) => {
			const session = requireGhPrSession();
			const params = new URLSearchParams({
				cursor: String(cursor),
				limit: String(limit),
				bodyMaxChars: String(bodyMaxChars),
				format,
			});
			if (replyCursor != null) params.set("replyCursor", String(replyCursor));
			if (replyLimit != null) params.set("replyLimit", String(replyLimit));
			if (unresolvedOnly) params.set("unresolvedOnly", "true");
			if (path) params.set("path", path);
			if (author) params.set("author", author);
			if (fullBody) params.set("fullBody", "true");
			if (format === "xml") {
				const headers = new Headers();
				if (session.lock.authToken)
					headers.set(SESSION_TOKEN_HEADER, session.lock.authToken);
				const res = await fetch(
					joinSessionApiUrl(session.apiOrigin, `/api/gh/threads?${params}`),
					{ headers },
				);
				const text = await res.text();
				if (!res.ok) throw new Error(text || res.statusText);
				return textResult(text, { result: { format: "xml", xml: text } });
			}
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				`/api/gh/threads?${params}`,
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"gh_list_reviews",
		{
			title: "List published PR review events",
			description:
				"Page submitted GitHub review verdicts and overall comments. Bodies truncated by default.",
			inputSchema: {
				cursor: z.number().int().nonnegative().optional(),
				limit: z.number().int().positive().max(100).optional(),
				bodyMaxChars: z.number().int().positive().max(50_000).optional(),
				fullBody: z.boolean().optional(),
				state: z.string().optional(),
				format: z.enum(["json", "xml"]).optional(),
			},
			outputSchema: { result: z.unknown() },
			annotations: READ_ONLY,
		},
		async ({
			cursor = 0,
			limit = 50,
			bodyMaxChars = 500,
			fullBody,
			state,
			format = "json",
		}) => {
			const session = requireGhPrSession();
			const params = new URLSearchParams({
				cursor: String(cursor),
				limit: String(limit),
				bodyMaxChars: String(bodyMaxChars),
				format,
			});
			if (fullBody) params.set("fullBody", "true");
			if (state) params.set("state", state);
			if (format === "xml") {
				const headers = new Headers();
				if (session.lock.authToken)
					headers.set(SESSION_TOKEN_HEADER, session.lock.authToken);
				const res = await fetch(
					joinSessionApiUrl(session.apiOrigin, `/api/gh/reviews?${params}`),
					{ headers },
				);
				const text = await res.text();
				if (!res.ok) throw new Error(text || res.statusText);
				return textResult(text, { result: { format: "xml", xml: text } });
			}
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				`/api/gh/reviews?${params}`,
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"gh_list_draft_comments",
		{
			title: "List local PR draft comments",
			description:
				"Return in-progress local draft comments for the active PR session (not published on GitHub).",
			inputSchema: {},
			outputSchema: { comments: z.array(commentSchema) },
			annotations: READ_ONLY,
		},
		async () => {
			const session = requireGhPrSession();
			const comments = await requestSessionJson<ReviewComment[]>(
				session,
				"/api/gh/pr-session/comments",
			);
			return textResult(formatComments(comments), { comments });
		},
	);

	server.registerTool(
		"gh_create_draft_comment",
		{
			title: "Create a local PR draft comment",
			description:
				"Create a local draft inline comment on the active PR session. Does not publish to GitHub. " +
				"Use gh_submit_review only when the user explicitly authorized publishing.",
			inputSchema: {
				filePath: z.string().min(1),
				side: z.enum(["deletions", "additions"]),
				lineNumber: z.number().int().nonnegative(),
				startLineNumber: z.number().int().positive().optional(),
				lineContent: z.string().optional(),
				body: z.string().min(1),
				severity: z
					.enum(["blocking", "nit", "question", "praise", "none"])
					.optional(),
			},
			outputSchema: { comment: commentSchema },
			annotations: MUTATING,
		},
		async ({
			filePath,
			side,
			lineNumber,
			startLineNumber,
			lineContent,
			body,
			severity,
		}) => {
			const session = requireGhPrSession();
			const comment = await requestSessionJson<ReviewComment>(
				session,
				"/api/gh/pr-session/comments",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						filePath,
						side,
						lineNumber,
						startLineNumber,
						lineContent: lineContent ?? "",
						body,
						severity: severity === "none" ? undefined : severity,
					}),
				},
			);
			return textResult(
				`Created PR draft comment ${comment.id} on ${comment.filePath}:${comment.lineNumber}.`,
				{
					comment,
				},
			);
		},
	);

	server.registerTool(
		"gh_refresh",
		{
			title: "Refresh GitHub PR session",
			description:
				"Re-fetch PR metadata, patch, and published conversations into the local session (force-push / new review sync).",
			inputSchema: {},
			outputSchema: { result: z.unknown() },
			annotations: MUTATING,
		},
		async () => {
			const session = requireGhPrSession();
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				"/api/gh/pr/refresh",
				{
					method: "POST",
				},
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"gh_submit_review",
		{
			title: "Submit PR review to GitHub",
			description:
				"Publish local draft comments and a decision to GitHub. " +
				"REQUIRES explicit user authorization — this mutates the remote pull request. Prefer dryRun first.",
			inputSchema: {
				decision: z.enum(["approve", "comment", "request-changes", "draft"]),
				body: z.string().optional(),
				dryRun: z.boolean().optional(),
				pendingReviewId: z.number().int().positive().optional(),
			},
			outputSchema: { result: z.unknown() },
			annotations: { ...MUTATING, openWorldHint: true, destructiveHint: false },
		},
		async ({ decision, body, dryRun, pendingReviewId }) => {
			const session = requireGhPrSession();
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				"/api/gh/submit",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						decision,
						body: body ?? "",
						dryRun: dryRun === true,
						pendingReviewId,
					}),
				},
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"gh_submit_pending_review",
		{
			title: "Submit a pending GitHub review",
			description:
				"Finish an existing PENDING GitHub review (APPROVE, REQUEST_CHANGES, or COMMENT). " +
				"REQUIRES explicit user authorization — this mutates the remote pull request.",
			inputSchema: {
				reviewId: z.number().int().positive(),
				event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
				body: z.string().optional(),
			},
			outputSchema: { result: z.unknown() },
			annotations: { ...MUTATING, openWorldHint: true, destructiveHint: false },
		},
		async ({ reviewId, event, body }) => {
			const session = requireGhPrSession();
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				`/api/gh/reviews/${reviewId}/submit`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ event, body }),
				},
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"gh_discard_pending_review",
		{
			title: "Discard a pending GitHub review",
			description:
				"Delete an unpublished PENDING GitHub review. REQUIRES explicit user authorization.",
			inputSchema: {
				reviewId: z.number().int().positive(),
			},
			outputSchema: { result: z.unknown() },
			annotations: { ...MUTATING, openWorldHint: true, destructiveHint: true },
		},
		async ({ reviewId }) => {
			const session = requireGhPrSession();
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				`/api/gh/reviews/${reviewId}`,
				{ method: "DELETE" },
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"gh_update_pr",
		{
			title: "Update pull request title or body",
			description:
				"PATCH the PR title and/or description on GitHub. REQUIRES explicit user authorization. Prefer dryRun first.",
			inputSchema: {
				title: z.string().optional(),
				body: z.string().optional(),
				dryRun: z.boolean().optional(),
			},
			outputSchema: { result: z.unknown() },
			annotations: { ...MUTATING, openWorldHint: true },
		},
		async ({ title, body, dryRun }) => {
			const session = requireGhPrSession();
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				"/api/gh/pr",
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title, body, dryRun: dryRun === true }),
				},
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"gh_set_pr_state",
		{
			title: "Close or reopen the pull request",
			description:
				"Close or reopen the active pull request on GitHub. REQUIRES explicit user authorization. Prefer dryRun first.",
			inputSchema: {
				state: z.enum(["open", "closed"]),
				dryRun: z.boolean().optional(),
			},
			outputSchema: { result: z.unknown() },
			annotations: { ...MUTATING, openWorldHint: true, destructiveHint: true },
		},
		async ({ state, dryRun }) => {
			const session = requireGhPrSession();
			const path = state === "closed" ? "/api/gh/pr/close" : "/api/gh/pr/reopen";
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				path,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ dryRun: dryRun === true }),
				},
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"gh_merge_pr",
		{
			title: "Merge the pull request",
			description:
				"Merge the active pull request on GitHub with an expected-head check. " +
				"REQUIRES explicit user authorization. Prefer dryRun first. Does not bypass branch protection.",
			inputSchema: {
				method: z.enum(["merge", "squash", "rebase"]).optional(),
				expectedHeadSha: z.string().optional(),
				dryRun: z.boolean().optional(),
			},
			outputSchema: { result: z.unknown() },
			annotations: { ...MUTATING, openWorldHint: true, destructiveHint: true },
		},
		async ({ method, expectedHeadSha, dryRun }) => {
			const session = requireGhPrSession();
			const result = await requestSessionJson<Record<string, unknown>>(
				session,
				"/api/gh/pr/merge",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						method: method ?? "merge",
						expectedHeadSha,
						dryRun: dryRun === true,
					}),
				},
			);
			return textResult(JSON.stringify(result), { result });
		},
	);

	server.registerTool(
		"create_comment",
		{
			title: "Create an inline review comment",
			description:
				"Create a local inline comment on an exact line (or inclusive range) from get_diff. " +
				"side is additions for +/context in the new file and deletions for a removed line. " +
				"Optional severity triages the finding for the human and is included in the agent handoff XML.",
			inputSchema: {
				filePath: z
					.string()
					.min(1)
					.describe("Repository-relative file path exactly as shown in the patch."),
				side: z
					.enum(["deletions", "additions"])
					.describe("Which side of the patch contains the target line."),
				lineNumber: z
					.number()
					.int()
					.positive()
					.describe(
						"Target line number on the selected side (bottom of range if multi-line).",
					),
				startLineNumber: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Optional first line for an inclusive multi-line comment."),
				lineContent: z
					.string()
					.describe(
						"Target line text (or joined multi-line span), used to preserve context in the review UI.",
					),
				body: z.string().min(1).describe("Actionable review comment in Markdown."),
				severity: z
					.enum(["blocking", "nit", "question", "praise", "none"])
					.optional()
					.describe(
						"Optional triage: blocking = must fix; nit = optional polish; question = needs answer; praise = no change. Omit or none = untriaged.",
					),
			},
			outputSchema: { status: z.literal("created"), comment: commentSchema },
			annotations: MUTATING,
		},
		async (input) => {
			const payload = {
				...input,
				// Match HTTP/UI: do not persist bare "none".
				severity:
					input.severity && input.severity !== "none" ? input.severity : undefined,
			};
			const comment = await requestBaseJson<ReviewComment>("/api/comments", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			return textResult(
				`Created inline comment ${comment.id} on ${comment.filePath}:${comment.lineNumber}.`,
				{
					status: "created",
					comment,
				},
			);
		},
	);

	server.registerTool(
		"await_review",
		{
			title: "Wait for code review handoff",
			description:
				"Sync wait for the human to click Send to agent. Prefer async handoff (share the UI URL and end the turn) unless they are reviewing now or asked you to wait. " +
				"Returns status=released or status=timeout; timeout includes disposition=park. " +
				AWAIT_TOOL_DESCRIPTION_SUFFIX,
			inputSchema: {
				timeoutSeconds: z
					.number()
					.positive()
					.max(3600)
					.optional()
					.describe(
						`Total wait budget in seconds; defaults to ${DEFAULT_AWAIT_TIMEOUT_SECONDS}.`,
					),
			},
			outputSchema: {
				status: z.enum(["released", "timeout"]),
				disposition: z.enum(["park"]).optional(),
				mode: z.enum(["standard", "comment-only"]),
				round: z.number(),
				openCount: z.number().optional(),
				decision: z
					.enum(["approved", "changes-requested", "rejected", "comment-only"])
					.optional(),
				comments: z.array(commentSchema).optional(),
				nextAction: z.string(),
			},
			annotations: AWAIT,
		},
		async ({ timeoutSeconds }, extra) => {
			const session = requireWebSession();
			const budgetMs = (timeoutSeconds ?? DEFAULT_AWAIT_TIMEOUT_SECONDS) * 1000;
			const progressToken = extra?._meta?.progressToken;
			let sinceRound = await seedReviewCursor(session, extra?.signal);
			const deadline = Date.now() + budgetMs;
			let cycle = 0;

			while (Date.now() < deadline) {
				const remaining = Math.max(1, deadline - Date.now());
				const result = await requestSessionJson<any>(
					session,
					`/api/review/await?timeoutMs=${Math.min(25000, remaining)}&sinceRound=${sinceRound}`,
					{ signal: extra?.signal },
				);
				if (result.status === "released") {
					const payload = result.payload;
					sinceRound = payload.round;
					reviewCursor = { identity: session.identity, round: sinceRound };
					const structured = {
						status: "released" as const,
						mode: payload.mode ?? "standard",
						round: payload.round,
						openCount: payload.openCount,
						...(payload.decision ? { decision: payload.decision } : {}),
						comments: payload.comments,
						nextAction:
							payload.mode === "comment-only"
								? "Reply to comments without editing files; resolve only comments the human considers addressed."
								: "Address open comments, reply with evidence, and resolve completed threads.",
					};
					return textResult(payload.commentXml, structured);
				}
				sinceRound = result.round ?? sinceRound;
				reviewCursor = { identity: session.identity, round: sinceRound };
				cycle += 1;
				if (progressToken !== undefined) {
					await extra
						.sendNotification({
							method: "notifications/progress",
							params: {
								progressToken,
								progress: cycle,
								total: Math.max(cycle, Math.ceil(budgetMs / 25000)),
								message:
									"Still waiting for a code-review handoff; long poll completed and will retry.",
							},
						})
						.catch(() => {});
				}
			}
			const structured = {
				status: "timeout" as const,
				disposition: "park" as const,
				mode: "standard" as const,
				round: sinceRound,
				nextAction: AWAIT_REVIEW_TIMEOUT_NEXT_ACTION,
			};
			return textResult(structured.nextAction, structured);
		},
	);

	server.registerTool(
		"list_comments",
		{
			title: "List code review comments",
			description:
				"Fetch code-review comments as XML plus structured data. Use openOnly=true when addressing the current review round.",
			inputSchema: {
				openOnly: z
					.boolean()
					.optional()
					.describe("Return only unresolved comments when true."),
			},
			outputSchema: { comments: z.array(commentSchema) },
			annotations: READ_ONLY,
		},
		async ({ openOnly }) => {
			const all = await requestBaseJson<ReviewComment[]>("/api/comments");
			const comments = openOnly
				? all.filter((comment) => comment.status === "open")
				: all;
			return textResult(formatComments(comments), { comments });
		},
	);

	server.registerTool(
		"reply_to_comment",
		{
			title: "Reply to a code review comment",
			description:
				"Post an agent reply to an existing code-review thread. Include concise evidence of the answer or applied change.",
			inputSchema: {
				commentId: z
					.string()
					.min(1)
					.describe("Comment id from list_comments or await_review."),
				body: z.string().min(1).describe("Reply body in Markdown."),
				model: z
					.string()
					.optional()
					.describe("Optional agent/model identifier shown in the UI."),
			},
			outputSchema: { status: z.literal("replied"), commentId: z.string() },
			annotations: MUTATING,
		},
		async ({ commentId, body, model }) => {
			await requestBaseJson<unknown>(
				`/api/comments/${encodeURIComponent(commentId)}/replies`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ body, role: "agent", model }),
				},
			);
			return textResult(`Replied to ${commentId}.`, {
				status: "replied",
				commentId,
			});
		},
	);

	server.registerTool(
		"resolve_comment",
		{
			title: "Resolve a code review comment",
			description:
				"Mark a code-review thread resolved after its request is fully addressed. Safe to retry.",
			inputSchema: {
				commentId: z.string().min(1).describe("Comment id to resolve."),
			},
			outputSchema: { status: z.literal("resolved"), commentId: z.string() },
			annotations: IDEMPOTENT_MUTATION,
		},
		async ({ commentId }) => {
			await requestBaseJson<unknown>(
				`/api/comments/${encodeURIComponent(commentId)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ status: "resolved" }),
				},
			);
			return textResult(`Resolved ${commentId}.`, {
				status: "resolved",
				commentId,
			});
		},
	);

	server.registerTool(
		"unresolve_comment",
		{
			title: "Unresolve a code review comment",
			description:
				"Re-open a previously resolved code-review thread. Safe to retry.",
			inputSchema: {
				commentId: z.string().min(1).describe("Comment id to re-open."),
			},
			outputSchema: { status: z.literal("open"), commentId: z.string() },
			annotations: IDEMPOTENT_MUTATION,
		},
		async ({ commentId }) => {
			await requestBaseJson<unknown>(
				`/api/comments/${encodeURIComponent(commentId)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ status: "open" }),
				},
			);
			return textResult(`Re-opened ${commentId}.`, {
				status: "open",
				commentId,
			});
		},
	);

	server.registerTool(
		"edit_comment",
		{
			title: "Edit a code review comment body",
			description:
				"Replace the body of an existing code-review comment (human or agent).",
			inputSchema: {
				commentId: z.string().min(1).describe("Comment id to edit."),
				body: z.string().min(1).describe("New Markdown body."),
			},
			outputSchema: { status: z.literal("edited"), commentId: z.string() },
			annotations: MUTATING,
		},
		async ({ commentId, body }) => {
			await requestBaseJson<unknown>(
				`/api/comments/${encodeURIComponent(commentId)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ body }),
				},
			);
			return textResult(`Edited ${commentId}.`, {
				status: "edited",
				commentId,
			});
		},
	);

	server.registerTool(
		"delete_comment",
		{
			title: "Delete a code review comment",
			description: "Permanently delete a code-review thread and its replies.",
			inputSchema: {
				commentId: z.string().min(1).describe("Comment id to delete."),
			},
			outputSchema: { status: z.literal("deleted"), commentId: z.string() },
			annotations: MUTATING,
		},
		async ({ commentId }) => {
			await requestBaseJson<unknown>(
				`/api/comments/${encodeURIComponent(commentId)}`,
				{
					method: "DELETE",
				},
			);
			return textResult(`Deleted ${commentId}.`, {
				status: "deleted",
				commentId,
			});
		},
	);

	server.registerTool(
		"apply_suggestion",
		{
			title: "Apply a suggestion block from a comment",
			description:
				"Apply the first ```suggestion fence in a comment to the working-tree file (additions side). Supports multi-line ranges. Resolves the comment on success.",
			inputSchema: {
				commentId: z
					.string()
					.min(1)
					.describe("Comment id containing a ```suggestion fence."),
			},
			outputSchema: { status: z.literal("applied"), commentId: z.string() },
			annotations: MUTATING,
		},
		async ({ commentId }) => {
			await requestBaseJson<unknown>(
				`/api/comments/${encodeURIComponent(commentId)}/apply-suggestion`,
				{ method: "POST" },
			);
			return textResult(`Applied suggestion from ${commentId}.`, {
				status: "applied",
				commentId,
			});
		},
	);

	server.registerTool(
		"resolve_all_comments",
		{
			title: "Resolve all open code review comments",
			description:
				"Mark every open code-review thread as resolved. Safe to retry.",
			inputSchema: {},
			outputSchema: { status: z.literal("resolved-all"), resolved: z.number() },
			annotations: IDEMPOTENT_MUTATION,
		},
		async () => {
			const result = await requestBaseJson<{ ok: boolean; resolved: number }>(
				"/api/comments/resolve-all",
				{ method: "POST" },
			);
			return textResult(`Resolved ${result.resolved} comment(s).`, {
				status: "resolved-all",
				resolved: result.resolved,
			});
		},
	);

	server.registerTool(
		"get_review_history",
		{
			title: "Get review handoff history",
			description:
				'List past "Send to agent" rounds (newest first). In-memory only — empty after server restart.',
			inputSchema: {},
			outputSchema: {
				rounds: z.array(
					z.object({
						round: z.number(),
						sentAt: z.number(),
						openCount: z.number(),
						decision: z.string().optional(),
						mode: z.string().optional(),
						filePaths: z.array(z.string()),
					}),
				),
			},
			annotations: READ_ONLY,
		},
		async () => {
			const data = await requestBaseJson<{
				rounds: Array<Record<string, unknown>>;
			}>("/api/review/history");
			return textResult(`Review history: ${data.rounds?.length ?? 0} round(s).`, {
				rounds: data.rounds ?? [],
			});
		},
	);

	server.registerTool(
		"report_progress",
		{
			title: "Report agent progress to the human UI",
			description:
				"Push a short status message (and optional percent) to the review UI so the human sees what you are doing.",
			inputSchema: {
				message: z.string().min(1).describe("Short progress message."),
				model: z.string().optional().describe("Model / agent name."),
				agentId: z
					.string()
					.optional()
					.describe("Stable agent id for multi-agent sessions."),
				commentId: z.string().optional().describe("Related comment id, if any."),
				pct: z
					.number()
					.min(0)
					.max(100)
					.optional()
					.describe("Optional 0–100 progress."),
			},
			outputSchema: { status: z.literal("ok") },
			annotations: MUTATING,
		},
		async ({ message, model, agentId, commentId, pct }) => {
			await requestBaseJson<unknown>("/api/agent/progress", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message, model, agentId, commentId, pct }),
			});
			return textResult("Progress reported.", { status: "ok" });
		},
	);

	server.registerTool(
		"edit_reply",
		{
			title: "Edit a reply on a code review comment",
			description:
				"Replace the body of an existing reply on a code-review thread.",
			inputSchema: {
				commentId: z.string().min(1).describe("Parent comment id."),
				replyId: z.string().min(1).describe("Reply id to edit."),
				body: z.string().min(1).describe("New Markdown body."),
			},
			outputSchema: {
				status: z.literal("edited"),
				commentId: z.string(),
				replyId: z.string(),
			},
			annotations: MUTATING,
		},
		async ({ commentId, replyId, body }) => {
			await requestBaseJson<unknown>(
				`/api/comments/${encodeURIComponent(commentId)}/replies/${encodeURIComponent(replyId)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ body }),
				},
			);
			return textResult(`Edited reply ${replyId} on ${commentId}.`, {
				status: "edited",
				commentId,
				replyId,
			});
		},
	);

	server.registerTool(
		"delete_reply",
		{
			title: "Delete a reply on a code review comment",
			description: "Permanently delete a reply from a code-review thread.",
			inputSchema: {
				commentId: z.string().min(1).describe("Parent comment id."),
				replyId: z.string().min(1).describe("Reply id to delete."),
			},
			outputSchema: {
				status: z.literal("deleted"),
				commentId: z.string(),
				replyId: z.string(),
			},
			annotations: MUTATING,
		},
		async ({ commentId, replyId }) => {
			await requestBaseJson<unknown>(
				`/api/comments/${encodeURIComponent(commentId)}/replies/${encodeURIComponent(replyId)}`,
				{ method: "DELETE" },
			);
			return textResult(`Deleted reply ${replyId} on ${commentId}.`, {
				status: "deleted",
				commentId,
				replyId,
			});
		},
	);

	server.registerTool(
		"submit_plan",
		{
			title: "Submit or resubmit a plan",
			description:
				"Submit Markdown for human plan review. Default handoff is async: return the URL and park. " +
				"Call await_plan_review only when the human is reviewing now or asked you to wait. " +
				"To revise after changes-requested, pass the same planId so a new version is created.",
			inputSchema: {
				title: z.string().optional().describe("Human-readable plan title."),
				body: z.string().min(1).describe("Complete Markdown plan body."),
				source: z
					.string()
					.optional()
					.describe("Optional source filename or workflow label."),
				model: z.string().optional().describe("Optional agent/model identifier."),
				planId: z
					.string()
					.optional()
					.describe("Existing plan id when resubmitting a revised version."),
			},
			outputSchema: {
				status: z.literal("submitted"),
				planId: z.string(),
				version: z.number(),
				url: z.string(),
				nextAction: z.string(),
			},
			annotations: MUTATING,
		},
		async ({ title, body, source, model, planId }) => {
			const session = requireWebSession();
			// Capture the current round before POST. A human can decide immediately
			// after submission; await_plan_review must still ask from this pre-submit
			// cursor instead of reseeding past that fast verdict.
			await seedPlanCursor(session, undefined, true);
			const plan = await requestSessionJson<Plan>(session, "/api/plans", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: planId, title, body, source, model }),
			});
			const url = appendSessionToken(
				`${session.apiOrigin}/plan/${plan.id}`,
				session.lock.authToken,
			);
			return textResult(
				`Submitted plan ${plan.id} (v${plan.version}) at ${url}. ${PLAN_SUBMIT_NEXT_ACTION}`,
				{
					status: "submitted",
					planId: plan.id,
					version: plan.version,
					url,
					nextAction: PLAN_SUBMIT_NEXT_ACTION,
				},
			);
		},
	);

	server.registerTool(
		"await_plan_review",
		{
			title: "Wait for plan review verdict",
			description:
				"Sync wait for a plan verdict (Submit review). Prefer async handoff after submit_plan unless the human is reviewing now or asked you to wait. " +
				"Returns status=released or status=timeout; timeout includes disposition=park. " +
				AWAIT_TOOL_DESCRIPTION_SUFFIX,
			inputSchema: {
				timeoutSeconds: z
					.number()
					.positive()
					.max(3600)
					.optional()
					.describe(
						`Total wait budget in seconds; defaults to ${DEFAULT_AWAIT_TIMEOUT_SECONDS}.`,
					),
			},
			outputSchema: {
				status: z.enum(["released", "timeout"]),
				disposition: z.enum(["park"]).optional(),
				mode: z.enum(["standard", "comment-only"]),
				round: z.number(),
				planId: z.string().optional(),
				decision: z
					.enum([
						"pending",
						"approved",
						"changes-requested",
						"rejected",
						"comment-only",
					])
					.optional(),
				decisionComment: z.string().optional(),
				openCommentCount: z.number().optional(),
				plan: z.unknown().optional(),
				nextAction: z.string(),
			},
			annotations: AWAIT,
		},
		async ({ timeoutSeconds }, extra) => {
			const session = requireWebSession();
			const budgetMs = (timeoutSeconds ?? DEFAULT_AWAIT_TIMEOUT_SECONDS) * 1000;
			const progressToken = extra?._meta?.progressToken;
			let sinceRound = await seedPlanCursor(session, extra?.signal);
			const deadline = Date.now() + budgetMs;
			let cycle = 0;

			while (Date.now() < deadline) {
				const remaining = Math.max(1, deadline - Date.now());
				const result = await requestSessionJson<any>(
					session,
					`/api/plan-review/await?timeoutMs=${Math.min(25000, remaining)}&sinceRound=${sinceRound}`,
					{ signal: extra?.signal },
				);
				if (result.status === "released") {
					const payload = result.payload;
					sinceRound = payload.round;
					planCursor = { identity: session.identity, round: sinceRound };
					const nextAction =
						payload.mode === "comment-only"
							? "Reply to plan comments without changing implementation files."
							: payload.decision === "approved"
								? "Proceed with the approved plan."
								: payload.decision === "changes-requested"
									? "Revise the plan and call submit_plan with the same planId."
									: "Stop; the plan was rejected.";
					const structured = {
						status: "released" as const,
						mode: payload.mode ?? "standard",
						round: payload.round,
						planId: payload.planId,
						decision: payload.decision,
						...(payload.decisionComment
							? { decisionComment: payload.decisionComment }
							: {}),
						openCommentCount: payload.openCommentCount,
						plan: payload.plan,
						nextAction,
					};
					return textResult(payload.reviewXml, structured);
				}
				sinceRound = result.round ?? sinceRound;
				planCursor = { identity: session.identity, round: sinceRound };
				cycle += 1;
				if (progressToken !== undefined) {
					await extra
						.sendNotification({
							method: "notifications/progress",
							params: {
								progressToken,
								progress: cycle,
								total: Math.max(cycle, Math.ceil(budgetMs / 25000)),
								message:
									"Still waiting for a plan verdict; long poll completed and will retry.",
							},
						})
						.catch(() => {});
				}
			}
			const structured = {
				status: "timeout" as const,
				disposition: "park" as const,
				mode: "standard" as const,
				round: sinceRound,
				nextAction: AWAIT_PLAN_TIMEOUT_NEXT_ACTION,
			};
			return textResult(structured.nextAction, structured);
		},
	);

	server.registerTool(
		"list_plans",
		{
			title: "List submitted plans",
			description:
				"List every submitted plan with its current verdict, version, and inline comments.",
			inputSchema: {},
			outputSchema: { plans: z.array(z.unknown()) },
			annotations: READ_ONLY,
		},
		async () => {
			const plans = await requestBaseJson<Plan[]>("/api/plans");
			const summary = plans
				.map((plan) => {
					const open = (plan.comments ?? []).filter(
						(comment) => comment.status === "open",
					).length;
					return `${plan.id} [${plan.decision}] v${plan.version} — ${open} open comment(s) — ${plan.title}`;
				})
				.join("\n");
			return textResult(summary || "No plans submitted yet.", { plans });
		},
	);

	server.registerTool(
		"get_plan",
		{
			title: "Get a plan",
			description:
				"Fetch one current plan as plan-review XML and structured data, including verdict and inline comments.",
			inputSchema: {
				planId: z
					.string()
					.min(1)
					.describe("Plan id from submit_plan or list_plans."),
			},
			outputSchema: { plan: z.unknown() },
			annotations: READ_ONLY,
		},
		async ({ planId }) => {
			const plan = await requestBaseJson<Plan>(
				`/api/plans/${encodeURIComponent(planId)}`,
			);
			return textResult(formatPlanReview(plan), { plan });
		},
	);

	server.registerTool(
		"get_plan_versions",
		{
			title: "List plan versions",
			description: "List all submitted versions of a plan, oldest first.",
			inputSchema: {
				planId: z.string().min(1).describe("Plan id to inspect."),
			},
			outputSchema: { versions: z.array(z.unknown()) },
			annotations: READ_ONLY,
		},
		async ({ planId }) => {
			const versions = await requestBaseJson<NonNullable<Plan["versions"]>>(
				`/api/plans/${encodeURIComponent(planId)}/versions`,
			);
			const summary = versions
				.map((version) => {
					const date = new Date(version.createdAt)
						.toISOString()
						.slice(0, 16)
						.replace("T", " ");
					return `v${version.version} — ${date} — ${version.title}`;
				})
				.join("\n");
			return textResult(summary || "No versions recorded.", { versions });
		},
	);

	server.registerTool(
		"get_plan_version",
		{
			title: "Get a plan version",
			description:
				"Fetch the current or a historical plan version as plan-review XML with version-anchored comments.",
			inputSchema: {
				planId: z.string().min(1).describe("Plan id to inspect."),
				version: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Historical version number; omit for current."),
			},
			outputSchema: {
				plan: z.unknown(),
				version: z.unknown().optional(),
				currentVersion: z.number().optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ planId, version }) => {
			const encodedId = encodeURIComponent(planId);
			const plan = await requestBaseJson<Plan>(`/api/plans/${encodedId}`);
			if (version === undefined)
				return textResult(formatPlanReview(plan), { plan });
			const data = await requestBaseJson<{
				version: NonNullable<Plan["versions"]>[number];
				plan: { currentVersion: number };
			}>(`/api/plans/${encodedId}/versions/${version}`);
			return textResult(
				formatPlanReview(plan, { viewingVersion: data.version.version }),
				{
					plan,
					version: data.version,
					currentVersion: data.plan.currentVersion,
				},
			);
		},
	);

	async function findPlanForComment(commentId: string): Promise<Plan | null> {
		const plans = await requestBaseJson<Plan[]>("/api/plans");
		return (
			plans.find((plan) =>
				(plan.comments ?? []).some((comment) => comment.id === commentId),
			) ?? null
		);
	}

	server.registerTool(
		"reply_to_plan_comment",
		{
			title: "Reply to a plan comment",
			description: "Post an agent reply to an existing inline plan-review thread.",
			inputSchema: {
				commentId: z
					.string()
					.min(1)
					.describe("Plan comment id from get_plan or await_plan_review."),
				body: z.string().min(1).describe("Reply body in Markdown."),
				model: z
					.string()
					.optional()
					.describe("Optional agent/model identifier shown in the UI."),
			},
			outputSchema: {
				status: z.literal("replied"),
				commentId: z.string(),
				planId: z.string(),
			},
			annotations: MUTATING,
		},
		async ({ commentId, body, model }) => {
			const plan = await findPlanForComment(commentId);
			if (!plan)
				throw new Error(
					`Plan comment ${commentId} was not found. Refresh the plan before retrying.`,
				);
			await requestBaseJson<unknown>(
				`/api/plans/${encodeURIComponent(plan.id)}/comments/${encodeURIComponent(commentId)}/replies`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ body, role: "agent", model }),
				},
			);
			return textResult(`Replied to plan comment ${commentId}.`, {
				status: "replied",
				commentId,
				planId: plan.id,
			});
		},
	);

	server.registerTool(
		"resolve_plan_comment",
		{
			title: "Resolve a plan comment",
			description:
				"Mark an inline plan-review thread resolved after it is fully addressed. Safe to retry.",
			inputSchema: {
				commentId: z.string().min(1).describe("Plan comment id to resolve."),
			},
			outputSchema: {
				status: z.literal("resolved"),
				commentId: z.string(),
				planId: z.string(),
			},
			annotations: IDEMPOTENT_MUTATION,
		},
		async ({ commentId }) => {
			const plan = await findPlanForComment(commentId);
			if (!plan)
				throw new Error(
					`Plan comment ${commentId} was not found. Refresh the plan before retrying.`,
				);
			await requestBaseJson<unknown>(
				`/api/plans/${encodeURIComponent(plan.id)}/comments/${encodeURIComponent(commentId)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ status: "resolved" }),
				},
			);
			return textResult(`Resolved plan comment ${commentId}.`, {
				status: "resolved",
				commentId,
				planId: plan.id,
			});
		},
	);

	const MOCKUP_SUBMIT_NEXT_ACTION =
		"Share the mockup URL and park unless the human is reviewing now or asked you to wait. Then call await_mockup_review.";

	server.registerTool(
		"submit_mockup",
		{
			title: "Submit HTML mockup for review",
			description:
				"Submit HTML mockup screen(s) for visual review. HARD RULE — one state per screen: every distinct state, variant, or case MUST be its own screens[] entry (stable id + label). NEVER encode state as in-page tabs, accordions, toggle switches, modals, dropdowns, or any JS content-swapping — each state is a separate screen. Pass html or screens[].html inline — do NOT write mockup files into the consumer git tree. Share the URL and park unless asked to wait. Resubmit with mockupId to bump version.",
			inputSchema: {
				title: z.string().optional(),
				html: z.string().optional(),
				screens: z
					.array(
						z.object({
							id: z.string().optional(),
							label: z.string().optional(),
							html: z.string(),
							stateOf: z.string().optional(),
							flow: z.string().optional(),
						}),
					)
					.optional(),
				mockupId: z.string().optional(),
				source: z.string().optional(),
				model: z.string().optional(),
				mode: z.enum(["fragment", "document"]).optional(),
				designSystem: z.string().optional(),
				planId: z.string().optional(),
				fromMockupId: z.string().optional(),
				blank: z.boolean().optional(),
			},
			outputSchema: {
				mockupId: z.string(),
				version: z.number(),
				url: z.string(),
				nextAction: z.string(),
			},
			annotations: { readOnlyHint: false, idempotentHint: false },
		},
		async ({
			title,
			html,
			screens,
			mockupId,
			source,
			model,
			mode,
			designSystem,
			planId,
			fromMockupId,
			blank,
		}) => {
			const session = requireWebSession();
			await seedMockupCursor(session, undefined, true);
			const mockup = await requestSessionJson<Mockup>(session, "/api/mockups", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: mockupId,
					title,
					html,
					screens,
					source,
					model,
					mode,
					designSystemId: designSystem,
					planId,
					fromMockupId,
					blank,
				}),
			});
			const url = appendSessionToken(
				`${session.apiOrigin}/mockup/${mockup.id}`,
				session.lock.authToken,
			);
			const hints = (mockup as Mockup & { hints?: MockupStateHint[] }).hints ?? [];
			const hintText = formatSubmitHints(hints);
			return textResult(
				`Submitted mockup ${mockup.id} (v${mockup.version}) at ${url}.${hintText} ${MOCKUP_SUBMIT_NEXT_ACTION}`,
				{
					mockupId: mockup.id,
					version: mockup.version,
					url,
					nextAction: MOCKUP_SUBMIT_NEXT_ACTION,
					...(hints.length > 0 ? { hints } : {}),
				},
			);
		},
	);

	server.registerTool(
		"await_mockup_review",
		{
			title: "Wait for mockup review verdict",
			description:
				"Sync wait for a mockup verdict. Prefer async handoff after submit_mockup unless asked to wait.",
			inputSchema: { timeoutSeconds: z.number().optional() },
			outputSchema: {
				status: z.enum(["released", "timeout"]),
				disposition: z.enum(["continue", "park"]).optional(),
				decision: z.string().optional(),
				reviewXml: z.string().optional(),
				mockup: z.unknown().optional(),
				round: z.number().optional(),
			},
			annotations: { readOnlyHint: true, idempotentHint: false },
		},
		async ({ timeoutSeconds }, extra) => {
			const session = requireWebSession();
			const deadline = Date.now() + Math.max(1, timeoutSeconds ?? 25) * 1000;
			let sinceRound = await seedMockupCursor(session, extra?.signal);
			while (Date.now() < deadline) {
				const remaining = Math.max(deadline - Date.now(), 0);
				const result = await requestSessionJson<{
					status: string;
					payload?: {
						decision?: string;
						reviewXml?: string;
						mockup?: unknown;
						round?: number;
					};
					round?: number;
				}>(
					session,
					`/api/mockup-review/await?timeoutMs=${Math.min(25000, remaining)}&sinceRound=${sinceRound}`,
					{ signal: extra?.signal },
				);
				if (result.status === "released" && result.payload) {
					mockupCursor = {
						identity: session.identity,
						round: result.payload.round ?? sinceRound,
					};
					return textResult(
						result.payload.reviewXml ?? `decision=${result.payload.decision}`,
						{
							status: "released",
							disposition: "continue",
							decision: result.payload.decision,
							reviewXml: result.payload.reviewXml,
							mockup: result.payload.mockup,
							round: result.payload.round,
						},
					);
				}
				sinceRound = result.round ?? sinceRound;
				mockupCursor = { identity: session.identity, round: sinceRound };
			}
			return textResult(
				"Timeout waiting for mockup review. Park and retry await_mockup_review when the human is ready.",
				{
					status: "timeout",
					disposition: "park",
					round: sinceRound,
				},
			);
		},
	);

	server.registerTool(
		"list_mockups",
		{
			title: "List mockups",
			description: "List submitted HTML mockups for this repository.",
			inputSchema: {},
			outputSchema: { mockups: z.array(z.unknown()) },
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => {
			const all = await requestBaseJson<Mockup[]>("/api/mockups");
			return textResult(`${all.length} mockup(s)`, { mockups: all });
		},
	);

	server.registerTool(
		"get_mockup",
		{
			title: "Get a mockup",
			description: "Fetch one mockup by id, including comments and screens.",
			inputSchema: { mockupId: z.string().min(1) },
			outputSchema: { mockup: z.unknown() },
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async ({ mockupId }) => {
			const mockup = await requestBaseJson<Mockup>(
				`/api/mockups/${encodeURIComponent(mockupId)}`,
			);
			return textResult(formatMockupReview(mockup), { mockup });
		},
	);

	server.registerTool(
		"get_mockup_versions",
		{
			title: "List mockup versions",
			description: "List version snapshots for a mockup.",
			inputSchema: { mockupId: z.string().min(1) },
			outputSchema: { versions: z.array(z.unknown()) },
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async ({ mockupId }) => {
			const versions = await requestBaseJson<unknown[]>(
				`/api/mockups/${encodeURIComponent(mockupId)}/versions`,
			);
			return textResult(`${versions.length} version(s)`, { versions });
		},
	);

	server.registerTool(
		"get_mockup_version",
		{
			title: "Get a mockup version",
			description: "Fetch one historical mockup version.",
			inputSchema: {
				mockupId: z.string().min(1),
				version: z.number().int().positive(),
			},
			outputSchema: { version: z.unknown(), mockup: z.unknown() },
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async ({ mockupId, version }) => {
			const data = await requestBaseJson<{ version: unknown; mockup: unknown }>(
				`/api/mockups/${encodeURIComponent(mockupId)}/versions/${version}`,
			);
			return textResult(`v${version}`, data);
		},
	);

	async function findMockupForComment(commentId: string): Promise<Mockup> {
		const all = await requestBaseJson<Mockup[]>("/api/mockups?include=comments");
		const mockup = all.find((m) =>
			(m.comments ?? []).some((c) => c.id === commentId),
		);
		if (!mockup) throw new Error(`Mockup comment ${commentId} was not found.`);
		return mockup;
	}

	server.registerTool(
		"reply_to_mockup_comment",
		{
			title: "Reply to a mockup comment",
			description: "Post an agent reply on a mockup comment thread.",
			inputSchema: {
				commentId: z.string().min(1),
				body: z.string().min(1),
				model: z.string().optional(),
			},
			outputSchema: { ok: z.boolean() },
			annotations: { readOnlyHint: false, idempotentHint: false },
		},
		async ({ commentId, body, model }) => {
			const mockup = await findMockupForComment(commentId);
			await requestBaseJson<unknown>(
				`/api/mockups/${encodeURIComponent(mockup.id)}/comments/${encodeURIComponent(commentId)}/replies`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ body, model, role: "agent" }),
				},
			);
			return textResult(`Replied to ${commentId}`, { ok: true });
		},
	);

	server.registerTool(
		"resolve_mockup_comment",
		{
			title: "Resolve a mockup comment",
			description: "Mark a mockup comment thread resolved.",
			inputSchema: { commentId: z.string().min(1) },
			outputSchema: { ok: z.boolean() },
			annotations: { readOnlyHint: false, idempotentHint: false },
		},
		async ({ commentId }) => {
			const mockup = await findMockupForComment(commentId);
			await requestBaseJson<unknown>(
				`/api/mockups/${encodeURIComponent(mockup.id)}/comments/${encodeURIComponent(commentId)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ status: "resolved" }),
				},
			);
			return textResult(`Resolved ${commentId}`, { ok: true });
		},
	);

	server.registerTool(
		"unresolve_mockup_comment",
		{
			title: "Unresolve a mockup comment",
			description: "Re-open a resolved mockup comment thread.",
			inputSchema: { commentId: z.string().min(1) },
			outputSchema: { ok: z.boolean() },
			annotations: { readOnlyHint: false, idempotentHint: false },
		},
		async ({ commentId }) => {
			const mockup = await findMockupForComment(commentId);
			await requestBaseJson<unknown>(
				`/api/mockups/${encodeURIComponent(mockup.id)}/comments/${encodeURIComponent(commentId)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ status: "open" }),
				},
			);
			return textResult(`Unresolved ${commentId}`, { ok: true });
		},
	);

	server.registerTool(
		"apply_mockup_suggestion",
		{
			title: "Apply a mockup suggestion",
			description:
				"Apply the first ```suggestion fence in a mockup comment to that comment's screen. Uses replace-region when the comment has a data-diffing target, otherwise exact-text patch. Pass expectedVersion to abort with 409 on conflict.",
			inputSchema: {
				commentId: z.string().min(1),
				expectedVersion: z.number().int().positive().optional(),
			},
			outputSchema: { ok: z.boolean() },
			annotations: MUTATING,
		},
		async ({ commentId, expectedVersion }) => {
			const mockup = await findMockupForComment(commentId);
			await requestBaseJson<unknown>(
				`/api/mockups/${encodeURIComponent(mockup.id)}/comments/${encodeURIComponent(commentId)}/apply-suggestion`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(expectedVersion != null ? { expectedVersion } : {}),
				},
			);
			return textResult(`Applied suggestion from ${commentId}`, { ok: true });
		},
	);

	server.registerTool(
		"inspect_mockup",
		{
			title: "Inspect a mockup (bounded)",
			description:
				"Read compact, bounded mockup data. view=summary (headline stats), comments (paged comment list), comment (one thread), screen (screen list), preview (layout report and optional screenshot metadata — never starts AI). Filter by comment scope: status, screenId, viewport (desktop|tablet|mobile), version. Page with cursor/limit; context=none|anchor|source controls how much anchor data is included. Prefer this over get_mockup, which returns every screen's full HTML.",
			inputSchema: {
				mockupId: z.string().min(1),
				view: z
					.enum(["summary", "comments", "comment", "screen", "preview"])
					.default("summary"),
				status: z.enum(["open", "resolved"]).optional(),
				screenId: z.string().optional(),
				viewport: z.enum(["desktop", "tablet", "mobile"]).optional(),
				version: z.number().int().positive().optional(),
				commentId: z.string().optional(),
				cursor: z.number().int().nonnegative().optional(),
				limit: z.number().int().positive().max(200).optional(),
				context: z.enum(["none", "anchor", "source"]).default("anchor"),
			},
			outputSchema: { data: z.unknown() },
			annotations: READ_ONLY,
		},
		async ({
			mockupId,
			view,
			status,
			screenId,
			viewport,
			version,
			commentId,
			cursor,
			limit,
			context,
		}) => {
			const params = new URLSearchParams();
			params.set("view", view);
			if (status) params.set("status", status);
			if (screenId) params.set("screen", screenId);
			if (viewport) params.set("viewport", viewport);
			if (version !== undefined) params.set("version", String(version));
			if (commentId) params.set("id", commentId);
			if (cursor !== undefined) params.set("cursor", String(cursor));
			if (limit !== undefined) params.set("limit", String(limit));
			params.set("context", context);
			const data = await requestBaseJson<unknown>(
				`/api/mockups/${encodeURIComponent(mockupId)}/inspect?${params.toString()}`,
			);
			return textResult(`inspect_mockup ${view} for ${mockupId}`, { data });
		},
	);

	server.registerTool(
		"revise_mockup",
		{
			title: "Revise a mockup screen",
			description:
				"One-screen revision of an HTML mockup. op=upsert adds/replaces a screen (html inline, never files on disk), op=remove deletes a screen, op=patch replaces the first exact occurrence of expectedText with replacement, op=replace-region replaces the inner HTML of the first [data-diffing=region] element. Every success bumps the mockup version; pass expectedVersion to guard against racing edits (409 version-mismatch on conflict, nothing applied). For revisions touching many screens, resubmit via submit_mockup with the same mockupId instead.",
			inputSchema: {
				mockupId: z.string().min(1),
				op: z.enum(["upsert", "remove", "patch", "replace-region"]),
				screenId: z.string().min(1),
				html: z.string().optional(),
				label: z.string().optional(),
				expectedText: z.string().optional(),
				region: z.string().optional(),
				replacement: z.string().optional(),
				expectedVersion: z.number().int().positive().optional(),
			},
			outputSchema: {
				mockupId: z.string(),
				version: z.number(),
				screenIds: z.array(z.string()),
				occurrences: z.number().optional(),
			},
			annotations: MUTATING,
		},
		async ({
			mockupId,
			op,
			screenId,
			html,
			label,
			expectedText,
			region,
			replacement,
			expectedVersion,
		}) => {
			const headers = { "Content-Type": "application/json" };
			const base = `/api/mockups/${encodeURIComponent(mockupId)}/screens/${encodeURIComponent(screenId)}`;
			if (op === "upsert") {
				if (!html) throw new Error("revise_mockup op=upsert requires html");
				const mockup = await requestBaseJson<Mockup>(base, {
					method: "PUT",
					headers,
					body: JSON.stringify({ html, label, expectedVersion }),
				});
				const hints =
					(mockup as Mockup & { hints?: MockupStateHint[] }).hints ?? [];
				const hintText = formatSubmitHints(hints);
				return textResult(
					`Upserted screen ${screenId} on ${mockupId} → v${mockup.version}.${hintText}`,
					{
						mockupId,
						version: mockup.version,
						screenIds: mockup.screens.map((s) => s.id),
						...(hints.length > 0 ? { hints } : {}),
					},
				);
			}
			if (op === "remove") {
				const qs =
					expectedVersion === undefined ? "" : `?expectedVersion=${expectedVersion}`;
				const mockup = await requestBaseJson<Mockup>(`${base}${qs}`, {
					method: "DELETE",
				});
				return textResult(
					`Removed screen ${screenId} from ${mockupId} → v${mockup.version}`,
					{
						mockupId,
						version: mockup.version,
						screenIds: mockup.screens.map((s) => s.id),
					},
				);
			}
			if (op === "replace-region") {
				if (!region || replacement === undefined) {
					throw new Error(
						"revise_mockup op=replace-region requires region and replacement",
					);
				}
				const data = await requestBaseJson<{
					mockup: Mockup;
					occurrences: number;
				}>(base, {
					method: "PATCH",
					headers,
					body: JSON.stringify({ region, replacement, expectedVersion }),
				});
				return textResult(
					`Replaced region "${region}" on ${screenId} (${data.occurrences} match(es)) → v${data.mockup.version}`,
					{
						mockupId,
						version: data.mockup.version,
						screenIds: data.mockup.screens.map((s) => s.id),
						occurrences: data.occurrences,
					},
				);
			}
			if (expectedText === undefined || replacement === undefined) {
				throw new Error(
					"revise_mockup op=patch requires expectedText and replacement",
				);
			}
			const data = await requestBaseJson<{
				mockup: Mockup;
				occurrences: number;
			}>(base, {
				method: "PATCH",
				headers,
				body: JSON.stringify({ expectedText, replacement, expectedVersion }),
			});
			return textResult(
				`Patched ${screenId} on ${mockupId} (${data.occurrences} exact match(es)) → v${data.mockup.version}`,
				{
					mockupId,
					version: data.mockup.version,
					screenIds: data.mockup.screens.map((s) => s.id),
					occurrences: data.occurrences,
				},
			);
		},
	);

	const threadOpSchema = z.discriminatedUnion("op", [
		z.object({
			op: z.literal("reply"),
			commentId: z.string().min(1),
			body: z.string().min(1),
			role: z.string().optional(),
			model: z.string().optional(),
		}),
		z.object({
			op: z.literal("edit"),
			commentId: z.string().min(1),
			replyId: z.string().optional(),
			body: z.string().min(1),
		}),
		z.object({
			op: z.literal("delete"),
			commentId: z.string().min(1),
			replyId: z.string().optional(),
		}),
		z.object({ op: z.literal("resolve"), commentId: z.string().min(1) }),
		z.object({ op: z.literal("unresolve"), commentId: z.string().min(1) }),
	]);

	server.registerTool(
		"update_mockup_threads",
		{
			title: "Update mockup threads (atomic batch)",
			description:
				"Atomically apply mockup thread operations: reply (agent answer), edit/delete replies, delete comments, resolve/unresolve. Every operation is validated against the mockup before any is applied — one invalid op aborts the whole batch with no changes. Thread ops never bump the mockup version. Prefer this over single-op reply_to_mockup_comment / resolve_mockup_comment when doing several edits.",
			inputSchema: {
				mockupId: z.string().min(1),
				operations: z.array(threadOpSchema).min(1),
			},
			outputSchema: {
				applied: z.number(),
				results: z.array(z.unknown()),
			},
			annotations: MUTATING,
		},
		async ({ mockupId, operations }) => {
			const data = await requestBaseJson<{
				applied: number;
				results: unknown[];
			}>(`/api/mockups/${encodeURIComponent(mockupId)}/threads/batch`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ operations }),
			});
			return textResult(`Applied ${data.applied} thread op(s) to ${mockupId}`, {
				applied: data.applied,
				results: data.results,
			});
		},
	);

	server.registerTool(
		"get_design_system",
		{
			title: "Get the repo design system",
			description:
				"Read the published (or draft) per-repo design system: tokens, guidelines, components. Call this before authoring mockup HTML. Omit id for the default system.",
			inputSchema: { id: z.string().optional() },
			outputSchema: { system: z.unknown().nullable() },
			annotations: READ_ONLY,
		},
		async ({ id }) => {
			const path = id
				? `/api/design-systems/${encodeURIComponent(id)}`
				: "/api/design-systems/default";
			try {
				const system = await requestBaseJson<unknown>(path);
				return textResult("design system", { system });
			} catch {
				return textResult("No design system published yet.", { system: null });
			}
		},
	);

	server.registerTool(
		"extract_design_system",
		{
			title: "Extract a draft design system from the repo",
			description:
				"Scan the consumer repo for CSS custom properties / token JSON and write a draft design system. Does not publish. Human must publish before fragment mockups inherit it.",
			inputSchema: {
				id: z.string().optional(),
				title: z.string().optional(),
			},
			outputSchema: { system: z.unknown(), extract: z.unknown() },
			annotations: MUTATING,
		},
		async ({ id, title }) => {
			const systemId = id || "default";
			const data = await requestBaseJson<{ system: unknown; extract: unknown }>(
				`/api/design-systems/${encodeURIComponent(systemId)}/extract`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ from: "css", title }),
				},
			);
			return textResult(
				`Draft design system ${systemId}. Human must publish before it wraps mockups.`,
				data,
			);
		},
	);

	server.registerTool(
		"propose_design_system",
		{
			title: "Propose a design-system draft",
			description:
				"Update the draft design system (tokens, guidelines, components). Does not publish. Agents may propose; only the human publishes.",
			inputSchema: {
				id: z.string().optional(),
				title: z.string().optional(),
				guidelines: z.string().optional(),
				tokens: z.unknown().optional(),
			},
			outputSchema: { system: z.unknown() },
			annotations: MUTATING,
		},
		async ({ id, title, guidelines, tokens }) => {
			const systemId = id || "default";
			const system = await requestBaseJson(
				`/api/design-systems/${encodeURIComponent(systemId)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title, guidelines, tokens }),
				},
			);
			return textResult(`Proposed draft on ${systemId}`, { system });
		},
	);

	server.registerTool(
		"publish_design_system",
		{
			title: "Publish the design system",
			description:
				"Publish the current draft as a new revision. Prefer letting the human do this in the UI. Use only when the user explicitly asked to publish.",
			inputSchema: { id: z.string().optional() },
			outputSchema: { system: z.unknown() },
			annotations: MUTATING,
		},
		async ({ id }) => {
			const systemId = id || "default";
			const system = await requestBaseJson(
				`/api/design-systems/${encodeURIComponent(systemId)}/publish`,
				{ method: "POST" },
			);
			return textResult(`Published ${systemId}`, { system });
		},
	);

	server.registerTool(
		"get_mockup_handoff",
		{
			title: "Get mockup implementation handoff",
			description:
				"Compact handoff after a mockup is approved: tokens, screens with intent, components used, leftover nits. Prefer this over dumping every screen's HTML.",
			inputSchema: { mockupId: z.string().min(1) },
			outputSchema: {
				xml: z.string().optional(),
				mockupId: z.string().optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ mockupId }) => {
			const data = await requestBaseJson<Record<string, unknown>>(
				`/api/mockups/${encodeURIComponent(mockupId)}/handoff`,
			);
			return textResult(typeof data.xml === "string" ? data.xml : "handoff", data);
		},
	);

	server.registerResource(
		"agent-guide",
		"diffing://agent-guide",
		{
			title: "diffing agent guide",
			description:
				"Portable quick reference for the native code-review and plan-review workflows.",
			mimeType: "text/markdown",
		},
		async () => ({
			contents: [
				{
					uri: "diffing://agent-guide",
					mimeType: "text/markdown",
					text: `# diffing agent guide

This MCP connection is immutably bound to \`${repoRoot}\`.

## Handoff (sync vs async)
- **Async (default):** share the UI/plan URL and end the turn. Resume when the human says the review or verdict is ready.
- **Sync:** call \`await_review\` / \`await_plan_review\` only when the human is reviewing now or asked you to wait.
- \`status=timeout\` + \`disposition=park\` means the wait budget elapsed — park; do not silent-loop. At most one extra await if they asked you to keep waiting.

## Code review
1. Call \`review_session_status\`; call \`start_review_session\` if needed.
2. Prefer \`diff_summary\` → paged \`diff_files\` → \`diff_hunks\` / bounded \`diff_slice\`; use \`get_diff\` only as an escape hatch.
3. Use \`create_comment\` for actionable inline findings.
4. Prefer async handoff; use \`await_review\` for sync waits. On resume, one \`await_review\` (or \`list_comments\`) replays a prior Send-to-agent.
5. In \`comment-only\` mode, reply without editing files.

## Plan review
1. Start or reuse a review session.
2. Call \`submit_plan\`, share the URL, and park unless asked to wait.
3. On resume or sync wait, call \`await_plan_review\` (or \`get_plan\` / \`list_plans\`).
4. On \`changes-requested\`, revise and resubmit with the same \`planId\`.
5. On \`approved\`, proceed; on \`rejected\`, stop.

## Mockup review
1. Call \`submit_mockup\`, share the URL, and park unless asked to wait; resubmit with the same \`mockupId\` to bump the version.
2. On resume or sync wait, call \`await_mockup_review\` (or \`list_mockups\` / \`get_mockup\`).
3. For bounded reads prefer \`inspect_mockup\` (view=summary/comments/comment/screen, filters by status/screenId/viewport/version).
4. To revise one screen use \`revise_mockup\` (upsert/remove/patch/replace-region with \`expectedVersion\` guard); thread ops go through atomic \`update_mockup_threads\`.
5. On \`approved\`, implement; on \`changes-requested\`, revise and resubmit; on \`rejected\`, stop.

## GitHub PR
1. In \`gh-pr\` mode call \`gh_overview\`, then the bounded diff tools.
2. Fetch published discussion with \`gh_list_threads\` (prefer unresolved) and \`gh_list_reviews\`.
3. Local drafts do not publish. Call \`gh_submit_review\` or mutate published threads only with explicit user authorization.

MCP connects only to the loopback diffing server and never terminates a user-owned session. Explicitly authorized GitHub operations may make that server call GitHub.`,
				},
			],
		}),
	);

	server.registerPrompt(
		"review_local_changes",
		{
			title: "Review local changes with diffing",
			description:
				"Workflow prompt for inspecting a local diff and leaving inline review feedback.",
			argsSchema: {
				focus: z
					.string()
					.optional()
					.describe(
						"Optional review focus such as security, correctness, or tests.",
					),
			},
		},
		async ({ focus }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text:
							`Use diffing to review the local changes in ${repoRoot}. ` +
							"Check review_session_status, start_review_session if needed, inspect with bounded diff_summary/diff_files/diff_hunks/diff_slice calls, and create only actionable inline comments. " +
							`Review every changed file${focus ? ` with special attention to ${focus}` : ""}.`,
					},
				},
			],
		}),
	);

	server.registerPrompt(
		"submit_plan_for_review",
		{
			title: "Submit an implementation plan for review",
			description:
				"Workflow prompt for submitting a plan and acting on the human verdict.",
			argsSchema: {
				plan: z
					.string()
					.describe("Complete Markdown implementation plan to submit."),
			},
		},
		async ({ plan }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text:
							`Use diffing for plan review in ${repoRoot}. Start or reuse a review session, submit this plan, share the plan URL, and park (async handoff) unless the human asked you to wait. ` +
							"When they are ready or asked you to block, call await_plan_review. " +
							"On changes-requested revise and resubmit the same planId; on rejected stop; on approved proceed. " +
							"Timeout means park — do not silent-loop.\n\n" +
							plan,
					},
				},
			],
		}),
	);

	return server;
}

export async function startMcpServer(
	options: { repoPath?: string } = {},
): Promise<void> {
	const repoRoot = resolveMcpRepository(
		options.repoPath ?? process.cwd(),
		options.repoPath !== undefined,
	);
	// diffing's git and file stores are intentionally process-scoped. Binding
	// once before constructing the server keeps every tool on the same repo.
	process.chdir(repoRoot);
	const ownerId = randomUUID();
	const server = createMcpServer({ repoRoot, ownerId });
	const cleanupOwnedSession = () => {
		removeServerLockIfOwned(repoRoot, process.pid, ownerId);
	};
	process.once("exit", cleanupOwnedSession);
	// Once the MCP client disconnects, an owned HTTP server would otherwise
	// keep the stdio process alive. Exiting tears down that in-process server;
	// the ownership check above ensures a reused user server is never touched.
	process.stdin.once("end", () => process.exit(0));
	await server.connect(new StdioServerTransport());
}
