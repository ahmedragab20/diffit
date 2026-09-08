#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
	parseDiffOptions,
	DEFAULTS,
	printHelp,
	intoShowMode,
	buildTuiGitDiffArgs,
} from "./lib/diff-options.js";
import { runTerminalDiff, validateEnvironment } from "./lib/diff-engine.js";
import { startServer } from "./server.js";
import { generateSessionToken, isWildcardBindHost } from "./lib/server-auth.js";
import { appendSessionToken } from "./lib/session-url.js";
import { loadSettings } from "./lib/settings.js";
import {
	acquireServerStartupLease,
	activateServerLock,
	diffScopeKey,
	listServerLocks,
	resolveActiveServerLock,
	resolveUnresponsiveServerLock,
	removeServerLockIfOwned,
	writeServerLock,
	type ServerLock,
	type ServerStartupLease,
} from "./lib/server-lock.js";
import { getBranchName, getRepoRoot } from "./lib/git.js";
import { playStartupDisplay } from "./lib/startup-display.js";
import { buildTuiDiffContext } from "./lib/tui-diff-context.js";
import { finishTuiChild } from "./lib/tui-child-lifecycle.js";
import {
	findReusableSession,
	openExistingSession,
	sessionMatchesLaunch,
	stopLockOwner,
	type SessionLaunchRequest,
} from "./lib/session-conflict.js";
import type { DiffOptions } from "./lib/diff-options.js";

function resolveServerPort(requested?: number): number {
	if (requested === undefined) return 0;
	if (!Number.isInteger(requested) || requested < 1 || requested > 65535) {
		console.error(
			`--port must be an integer between 1 and 65535 (got ${String(requested)}).`,
		);
		process.exit(5);
	}
	return requested;
}
import type { TuiSearchBridge } from "./lib/tui-search-bridge.js";

const args = process.argv.slice(2);

// ── GitHub PR mode (quoted `gh pr <ref>` or `--gh-pr <ref>`) ──────────────
// `diffing "gh pr 1234"` opens the same web UI pointed at a GitHub PR. The
// quoted form is checked *before* parseDiffOptions so it never collides with
// `git diff` revisions. The `--gh-pr <ref>` flag form is parsed later by
// parseDiffOptions and merged below.
//
// Two argv shapes are accepted:
//   1. Quoted:   `diffing "gh pr 1234"`           → argv = ['gh pr 1234', ...]
//   2. Unquoted: `diffing gh pr 1234`             → argv = ['gh', 'pr', '1234', ...]
// Shape (1) is the natural way most users pass a multi-word PR ref, so we
// re-split it. Only the leading `gh pr <ref>` tokens are consumed; trailing
// args (e.g. `--no-open`) survive for parseDiffOptions.
let prRef: string | null = null;
let ghPrConsumed = 0;
if (args[0]?.startsWith("gh pr ") === true) {
	const rest = args[0].slice("gh pr ".length).trim();
	if (rest) {
		prRef = rest;
		ghPrConsumed = 1;
	}
} else if (args[0] === "gh" && args[1] === "pr" && args[2] !== undefined) {
	prRef = args[2];
	ghPrConsumed = 3;
}
if (ghPrConsumed > 0) {
	// Remove only the `gh pr <ref>` tokens from `args` so the SUBCOMMANDS check
	// below doesn't match the leading `gh` and route to the agent-side
	// `diffing gh ...` verbs (overview/threads/reviews plus review lifecycle)
	// instead of opening the web UI.
	args.splice(0, ghPrConsumed);
}

// ── Agent / DX subcommands ──────────────────────────────
// Reserved verbs for handoff, plan review, GH PR automation, MCP, and
// diagnostics. Checked before git-diff parsing so they never collide with
// revisions. Full contracts: docs/cli.md §4–§5 and Agents.md.
//
//   await-review | comments | reply | resolve | unresolve | comment
//   progress | url | plan | gh | mcp | inspect | evidence | doctor | completion
//   update
//   mode | setup | init | onboard
//   view and show are handled separately (fall through to native/web modes).
const SUBCOMMANDS = new Set([
	"await-review",
	"reply",
	"resolve",
	"unresolve",
	"comment",
	"comments",
	"url",
	"mcp",
	"plan",
	"mockup",
	"design",
	"update",
	"gh",
	"doctor",
	"completion",
	"progress",
	"inspect",
	"evidence",
	"mode",
	"sessions",
	"setup",
	"init",
	"onboard",
]);
if (args[0] === "init" || args[0] === "onboard") {
	args[0] = "setup";
}
if (SUBCOMMANDS.has(args[0])) {
	if (args[0] === "mcp") {
		const mcpArgs = args.slice(1);
		if (mcpArgs.includes("--help") || mcpArgs.includes("-h")) {
			console.log(`Usage: diffing mcp [--repo <absolute-path>]

Run diffing as a local stdio MCP server bound to one Git repository.

The server advertises session, diff inspection, comment lifecycle, plan
review, progress, and history tools. Prefer MCP when the harness exposes
it; otherwise use the CLI mirrors (await-review, comments, plan, …).

Options:
  --repo <path>  Bind to this absolute Git repository path.
                 If omitted, the Git repository containing the current directory is used.
  -h, --help     Show this help.

See docs/cli.md §5 (MCP) for the full tool table.`);
			process.exit(0);
		}

		let repoPath: string | undefined;
		for (let index = 0; index < mcpArgs.length; index += 1) {
			const arg = mcpArgs[index];
			if (arg === "--repo") {
				const value = mcpArgs[index + 1];
				if (!value || value.startsWith("-")) {
					console.error("diffing mcp: --repo requires an absolute path");
					process.exit(5);
				}
				if (repoPath !== undefined) {
					console.error("diffing mcp: --repo may be specified only once");
					process.exit(5);
				}
				repoPath = value;
				index += 1;
			} else if (arg.startsWith("--repo=")) {
				if (repoPath !== undefined) {
					console.error("diffing mcp: --repo may be specified only once");
					process.exit(5);
				}
				repoPath = arg.slice("--repo=".length);
			} else {
				console.error(`diffing mcp: unknown option ${arg}`);
				process.exit(5);
			}
		}
		if (repoPath !== undefined && !isAbsolute(repoPath)) {
			console.error("diffing mcp: --repo must be an absolute path");
			process.exit(5);
		}

		const { startMcpServer } = await import("./mcp.js");
		await startMcpServer({ repoPath });
		// The MCP server owns stdio until the client disconnects (at which point
		// the event loop empties and the process exits). Park here so we never fall
		// through to diff parsing.
		await new Promise<never>(() => {});
	}
	const { runSubcommand } = await import("./cli-agent.js");
	const code = await runSubcommand(args[0], args.slice(1));
	process.exit(code);
}

// ── `view` subcommand ──────────────────────────────────
// A focused native diff browser. `--view` remains available for scripts, but
// the verb is the intended replacement for interactive `git diff`.
if (args[0] === "view") {
	args.shift();
	args.unshift("--view");
}

// ── `show` subcommand ──────────────────────────────────
// `diffing show <revspec>...` is a drop-in for `git show`. Unlike the agent
// subcommands above it is *not* a client-of-the-running-server — it just
// rewrites the parsed options to "show mode" and falls through to the normal
// web | terminal | tui flow. Strictly opt-in; `diffing <sha>` retains its
// `git diff <sha>` semantics.
let showSubcommand = false;
if (args[0] === "show") {
	showSubcommand = true;
	args.shift();
}

// A saved mode only changes interactive auto-selection. Quoted GitHub PR
// sessions are web-only; explicit mode flags are resolved by the parser.
const defaultInteractiveMode = prRef ? "web" : loadSettings().defaultMode;
const opts = parseDiffOptions(args, defaultInteractiveMode);

const sessionBehaviorFlags = [
	opts.reuseSession,
	opts.replaceSession,
	opts.newSession,
].filter(Boolean).length;
if (sessionBehaviorFlags > 1) {
	console.error(
		"Cannot combine --reuse-session, --replace-session, and --new-session.",
	);
	process.exit(5);
}

// `--gh-pr <ref>` is parsed by parseDiffOptions; merge it with the quoted /
// unquoted `gh pr <ref>` forms detected above so both entry points work.
if (!prRef && opts.ghPr) {
	prRef = opts.ghPr;
}

if (showSubcommand) {
	if (opts.revisions.length === 0 && !opts.help && !opts.version) {
		console.error("Usage: diffing show <revspec>... [-- <pathspec>...]");
		process.exit(5);
	}
	intoShowMode(opts);
}

if (opts.help) {
	printHelp();
	process.exit(0);
}

if (opts.version) {
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const pkg = JSON.parse(
		readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
	);
	console.log(pkg.version);
	process.exit(0);
}

const { handleFirstRunGate } = await import("./lib/setup.js");
await handleFirstRunGate({
	skipSetup: opts.skipSetup,
	cliImportMetaUrl: import.meta.url,
});

const envErr = validateEnvironment();
if (envErr) {
	console.error(envErr);
	process.exit(1);
}

// ── TUI mode: spawn the native Rust binary ─────────────
// If the env cannot support a TUI (piped stdin, CI, no raw mode) or the Rust
// binary is missing/broken, print one line to stderr and run `git diff`.
if (opts.outputMode === "tui") {
	const tuiResult = await launchTui(args, opts);
	// tuiResult === 0 means the TUI ran and exited cleanly. Any other value
	// means the fallback path ran; in that case runTerminalDiff already
	// printed the diff and we just propagate its exit code.
	process.exit(tuiResult);
}

// ── Terminal mode: behave exactly like `git diff` ───────
if (opts.outputMode === "terminal") {
	const exitCode = runTerminalDiff(opts);
	process.exit(exitCode);
}

// ── Web mode: launch the review server ──────────────────
const port = resolveServerPort(opts.port);
const host = opts.host;

if (isWildcardBindHost(host) && !opts.insecureNoAuth) {
	console.error(
		"Binding to all interfaces requires --insecure-no-auth. " +
			"Loopback review (default --host 127.0.0.1) uses a per-session API token instead.",
	);
	process.exit(1);
}

let repoRoot: string;
try {
	repoRoot = getRepoRoot();
} catch {
	repoRoot = process.cwd();
}

const launchRequest: SessionLaunchRequest = {
	mode: prRef ? "gh-pr" : "web",
	scope: diffScopeKey(opts),
	host,
	port: opts.port,
	prRef: prRef ?? undefined,
};
const matchingSession = () =>
	findReusableSession(listServerLocks(repoRoot), launchRequest);
const unresponsiveMatchingSession = () => {
	const lock = resolveUnresponsiveServerLock(repoRoot);
	if (!lock) return null;
	if (opts.reuseSession || sessionMatchesLaunch(lock, launchRequest)) return lock;
	return null;
};
const openAndActivateSession = async (lock: ServerLock): Promise<boolean> => {
	try {
		await openExistingSession(lock, { noOpen: opts.noOpen });
		activateServerLock(lock);
		return true;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return false;
	}
};
const defaultReuse = !(
	opts.reuseSession ||
	opts.replaceSession ||
	opts.newSession
);

let reusableSession = opts.reuseSession
	? resolveActiveServerLock(repoRoot)
	: defaultReuse
		? matchingSession()
		: null;
if (reusableSession) {
	if (!(await openAndActivateSession(reusableSession))) process.exit(3);
	process.exit(0);
}
let unresponsiveSession = opts.newSession ? null : unresponsiveMatchingSession();
if (unresponsiveSession && !opts.replaceSession) {
	console.error(
		`A matching diffing session (pid ${unresponsiveSession.pid}, port ${unresponsiveSession.port}) is still running but did not answer its health check. ` +
			"To avoid orphaning another port, no new server was started. Retry shortly, end that pid manually if it is stuck, or pass --new-session only when coexistence is intentional.",
	);
	process.exit(3);
}

const __pkgDir = dirname(fileURLToPath(import.meta.url));
const currentVersion = JSON.parse(
	readFileSync(resolve(__pkgDir, "..", "package.json"), "utf-8"),
).version;
const updateCheckPromise = (async () => {
	try {
		const { checkForUpdates } = await import("./lib/update-check.js");
		return await checkForUpdates(currentVersion);
	} catch {
		return null;
	}
})();
const authToken = opts.insecureNoAuth ? null : generateSessionToken();
if (isWildcardBindHost(host) && opts.insecureNoAuth) {
	console.error(
		"WARNING: diffing is exposed on the LAN without API authentication. " +
			"Anyone on your network can read and modify review data.",
	);
}
const clientDir = resolve(__pkgDir, "client");
const resolvedClientDir = existsSync(clientDir)
	? clientDir
	: resolve(process.cwd(), "dist/client");
// Kick off the browser module load in parallel with server start so open is
// ready the moment the port is bound.
const openModulePromise = opts.noOpen ? null : import("open");

const sessionOwnerId = randomUUID();
let startupLease: ServerStartupLease | null = acquireServerStartupLease(
	repoRoot,
	sessionOwnerId,
);
if (!startupLease) {
	// A competing launcher may have published the exact session between our
	// first registry scan and lease acquisition. Give reuse one final chance.
	reusableSession = opts.reuseSession
		? resolveActiveServerLock(repoRoot)
		: defaultReuse
			? matchingSession()
			: null;
	if (reusableSession) {
		if (!(await openAndActivateSession(reusableSession))) process.exit(3);
		process.exit(0);
	}
	unresponsiveSession = opts.newSession ? null : unresponsiveMatchingSession();
	if (unresponsiveSession && !opts.replaceSession) {
		console.error(
			`A matching diffing session (pid ${unresponsiveSession.pid}, port ${unresponsiveSession.port}) is still running but did not answer its health check. No new server was started.`,
		);
		process.exit(3);
	}
	console.error(
		"Another diffing process is starting a review for this repository. Retry in a moment.",
	);
	process.exit(3);
}

// The lease winner must recheck discovery: another process may have finished
// startup while this process was waiting to acquire the lease.
reusableSession = opts.reuseSession
	? resolveActiveServerLock(repoRoot)
	: defaultReuse
		? matchingSession()
		: null;
if (reusableSession) {
	startupLease.release();
	startupLease = null;
	if (!(await openAndActivateSession(reusableSession))) process.exit(3);
	process.exit(0);
}
unresponsiveSession = opts.newSession ? null : unresponsiveMatchingSession();
if (unresponsiveSession && !opts.replaceSession) {
	startupLease.release();
	startupLease = null;
	console.error(
		`A matching diffing session (pid ${unresponsiveSession.pid}, port ${unresponsiveSession.port}) is still running but did not answer its health check. No new server was started.`,
	);
	process.exit(3);
}

const activeSession = opts.replaceSession
	? resolveActiveServerLock(repoRoot) ?? resolveUnresponsiveServerLock(repoRoot)
	: null;
if (activeSession && opts.replaceSession) {
	try {
		console.error(
			`Stopping active diffing session (pid ${activeSession.pid})…`,
		);
		await stopLockOwner(activeSession);
	} catch (error) {
		startupLease.release();
		const detail = error instanceof Error ? error.message : String(error);
		console.error(detail);
		process.exit(1);
	}
}

let actualPort: number;
let prMode: boolean;
let runningServer: Awaited<ReturnType<typeof startServer>> | null = null;
try {
	runningServer = await startServer({
		port,
		host,
		clientDir: resolvedClientDir,
		diffOpts: opts,
		prRef: prRef ?? undefined,
		security: {
			bindHost: host,
			authToken,
			insecureNoAuth: opts.insecureNoAuth,
		},
	});
	actualPort = runningServer.port;
	prMode = runningServer.prMode;
	writeServerLock({
		port: actualPort,
		host,
		pid: process.pid,
		repoRoot,
		startedAt: Date.now(),
		version: currentVersion,
		mode: prMode ? "gh-pr" : "web",
		prRef: prMode ? (prRef ?? undefined) : undefined,
		scope: diffScopeKey(opts),
		ownerId: sessionOwnerId,
		sessionId: sessionOwnerId,
		authToken: authToken ?? undefined,
	});
} catch (error) {
	startupLease?.release();
	await runningServer?.close?.().catch(() => {});
	const detail = error instanceof Error ? error.message : String(error);
	console.error(`Failed to start diffing review safely: ${detail}`);
	process.exit(1);
}
startupLease?.release();
startupLease = null;

const localUrl = appendSessionToken(
	`http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actualPort}${prMode ? "/gh/pr" : ""}`,
	authToken ?? undefined,
);

console.log(`diffing server running at ${localUrl}`);
// Machine-readable readiness marker for herdr `wait output --match "DIFFING_READY"`
// (exact match instead of grepping the human banner for "http").
console.error(
	`DIFFING_READY ${localUrl} mode=${prMode ? "gh-pr" : "web"} pid=${process.pid}`,
);

// Open the browser as soon as the server is listening. The decorative quote
// animation used to block here (typewriter can take seconds) so the UI felt
// stuck until the quote finished — never gate the browser on that.
if (openModulePromise) {
	try {
		const settings = loadSettings();
		const openHost = host === "0.0.0.0" ? "127.0.0.1" : host;
		// PR mode mounts <PrReviewApp> only on `/gh/pr` — open that path so the
		// user lands on Submit-to-GitHub instead of the local review surface.
		const openUrl = appendSessionToken(
			`http://${openHost}:${actualPort}${prMode ? "/gh/pr" : ""}`,
			authToken ?? undefined,
		);
		const openModule = await openModulePromise;
		let appName: string | readonly string[] | undefined;
		if (settings.browser) {
			const apps = openModule.apps as Record<
				string,
				string | readonly string[]
			>;
			appName = apps[settings.browser] || settings.browser;
		}
		const options = appName ? { app: { name: appName } } : {};
		void openModule.default(openUrl, options);
	} catch (err) {
		console.error(
			"Failed to open browser:",
			err instanceof Error ? err.message : err,
		);
	}
}

// Decorative startup quote — await before update disclaimer so output stays ordered.
await playStartupDisplay();

try {
	const updateInfo = await updateCheckPromise;
	if (updateInfo?.hasUpdate) {
		const { printUpdateDisclaimer } = await import("./lib/update-check.js");
		printUpdateDisclaimer(currentVersion, updateInfo.latestVersion);
	}
} catch {
	// best-effort update check
}

const cleanupOwnedLock = () => {
	removeServerLockIfOwned(repoRoot, process.pid, sessionOwnerId);
};
process.once("exit", cleanupOwnedLock);
let shuttingDown = false;
const shutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("\nShutting down...");
	cleanupOwnedLock();
	await runningServer?.close?.().catch(() => {});
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// ── TUI helpers ─────────────────────────────────────────

import {
	findTuiBinaries as _findTuiBinaries,
	findTuiBinary as _findTuiBinary,
	findViewerTuiBinary as _findViewerTuiBinary,
} from "./lib/find-tui-binary.js";

/**
 * Wrapper around `findTuiBinary` that passes this script's `import.meta.url`
 * so the search paths anchor to the bundled CLI's directory. The real
 * implementation lives in `lib/find-tui-binary.ts` and is unit-tested there.
 */
export function findTuiBinary(requireViewer = false): string | null {
	if (!requireViewer) return _findTuiBinary(import.meta.url);
	return (
		_findTuiBinaries(import.meta.url).find((candidate) => {
			try {
				const help = execFileSync(candidate, ["--help"], {
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 5_000,
				});
				return help.includes("--view-only");
			} catch {
				return false;
			}
		}) ?? null
	);
}

/**
 * Fall back to default `git diff` output when the TUI cannot run.
 * Re-parses `args` so the terminal output exactly matches `diffing` (no flag)
 * in a non-TTY context.
 */
function runTerminalFallback(args: string[]): number {
	const terminalOpts = parseDiffOptions(
		args.filter((a) => a !== "--tui" && a !== "--view"),
	);
	// Force `outputMode: 'terminal'` so any auto-detection logic doesn't
	// second-guess the fallback path.
	terminalOpts.outputMode = "terminal";
	terminalOpts.tui = false;
	terminalOpts.viewOnly = false;
	return runTerminalDiff(terminalOpts);
}

/**
 * Launch the native-Rust TUI binary as a child process. Returns the process
 * exit code. If the TUI cannot start (no TTY, missing binary), prints a
 * single stderr line and falls back to the default `git diff` output.
 */
async function launchTui(args: string[], opts: DiffOptions): Promise<number> {
	const viewOnly = args.includes("--view");
	const requestedMode = viewOnly ? "diffing view" : "diffing --tui";
	// Gate 1 — TTY. The TUI needs a real terminal for raw mode + alternate screen.
	if (!process.stdout.isTTY || !process.stdin.isTTY) {
		console.error(`${requestedMode} requires a TTY; falling back to git diff`);
		return runTerminalFallback(args);
	}
	// Gate 2 — binary present and executable.
	const bin = viewOnly
		? await _findViewerTuiBinary(import.meta.url)
		: _findTuiBinary(import.meta.url);
	if (!bin) {
		console.error(
			`${viewOnly ? "compatible " : ""}diffing-tui binary not found; reinstall with \`npm i -g diffing@latest\` or build it with \`pnpm build:tui\`; falling back to git diff`,
		);
		return runTerminalFallback(args);
	}
	// Strip --tui before forwarding so the TUI binary doesn't see it twice
	// (and so the rest of the args mirror the web/terminal flows). The TUI
	// binary accepts --repo as its only named option; everything else is
	// forwarded to `git diff`.
	const forwarded = buildTuiGitDiffArgs(opts);
	// Determine the repo root for the TUI. If we can't, fall back gracefully.
	let repoRoot: string;
	try {
		repoRoot = getRepoRoot();
	} catch {
		repoRoot = process.cwd();
	}
	const defaultReuse =
		!viewOnly &&
		!(opts.reuseSession || opts.replaceSession || opts.newSession);
	const reusableSession = opts.reuseSession
		? resolveActiveServerLock(repoRoot)
		: defaultReuse
			? findReusableSession(listServerLocks(repoRoot), {
					mode: "tui",
					scope: diffScopeKey(opts),
					host: "127.0.0.1",
				})
			: null;
	if (reusableSession) {
		activateServerLock(reusableSession);
		await openExistingSession(reusableSession, { noOpen: opts.noOpen });
		return 0;
	}
	const activeSession = opts.replaceSession
		? resolveActiveServerLock(repoRoot)
		: null;
	if (activeSession && opts.replaceSession) {
		try {
			console.error(
				`Stopping active diffing session (pid ${activeSession.pid})…`,
			);
			await stopLockOwner(activeSession);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			return 1;
		}
	}
	// Terminal workflows are latency-sensitive: enter the alternate screen as
	// soon as the compatible native binary is known. The web-only decorative
	// startup animation must never sit on the critical path for `diffing view`
	// or `diffing --tui`.
	let searchBridge: TuiSearchBridge | null = null;
	try {
		const { startTuiSearchBridge } = await import("./lib/tui-search-bridge.js");
		searchBridge = await startTuiSearchBridge();
	} catch (error: any) {
		console.error(
			`diffing: fff search unavailable in TUI: ${error?.message ?? error}`,
		);
	}
	const diffContext = buildTuiDiffContext(opts, getBranchName());
	const sessionId = randomUUID();
	return new Promise<number>((resolveP) => {
		// Place --repo BEFORE the forwarded args so the TUI's clap parser can
		// extract it before the trailing-vararg (which would otherwise swallow
		// it as part of the git-diff passthrough).
		const child = spawn(
			bin,
			["--repo", repoRoot, ...(viewOnly ? ["--view-only"] : []), ...forwarded],
			{
				stdio: "inherit",
				env: {
					...process.env,
					DIFFING_TUI_DIFF_CONTEXT: JSON.stringify(diffContext),
					DIFFING_TUI_SESSION_ID: sessionId,
					DIFFING_TUI_SESSION_SCOPE: diffScopeKey(opts),
					DIFFING_TUI_SESSION_ARGS: JSON.stringify(forwarded),
					...(searchBridge
						? {
								DIFFING_TUI_SEARCH_ENDPOINT: searchBridge.endpoint,
								DIFFING_TUI_SEARCH_CAPABILITY: searchBridge.capability,
							}
						: {}),
				},
			},
		);
		child.on("exit", (code) => {
			void finishTuiChild(searchBridge, () => resolveP(code ?? 0));
		});
		child.on("error", (err) => {
			console.error(
				`diffing-tui failed to start: ${err.message}; falling back to git diff`,
			);
			void finishTuiChild(searchBridge, () =>
				resolveP(runTerminalFallback(args)),
			);
		});
	});
}
