import { parseArgs } from "node:util";
import { readFile, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve as resolvePath } from "node:path";
import { resolveActiveServerLock } from "./lib/server-lock.js";
import { appendSessionToken, reviewSessionUrl } from "./lib/session-url.js";
import { SESSION_TOKEN_HEADER } from "./lib/server-auth.js";
import { getProjectStorageDir, getRepoRoot } from "./lib/git.js";
import { formatComments } from "./lib/comment-format.js";
import {
	CLI_AWAIT_PLAN_TIMEOUT_HINT,
	CLI_AWAIT_REVIEW_TIMEOUT_HINT,
	CLI_PLAN_SUBMIT_PARK_HINT,
	DEFAULT_AWAIT_TIMEOUT_SECONDS,
} from "./lib/handoff.js";
import { formatPlanReview } from "./lib/plan-format.js";
import { formatModeLabel, loadSettings, saveSettings } from "./lib/settings.js";
import type { ReviewComment } from "./lib/types.js";
import type { Plan } from "./lib/plan-types.js";
import type { Mockup } from "./lib/mockup-types.js";
import { formatMockupReview } from "./lib/mockup-format.js";
import { slugifyScreenId } from "./lib/mockup-types.js";
import { formatSubmitHints, type MockupStateHint } from "./lib/mockup-lint.js";

/**
 * Agent-facing `diffing` subcommands. These make the user→agent handoff
 * port-agnostic: each resolves the running server via the per-repo lockfile
 * (`server.json`) so any agent with a shell — or a human — can drive the loop
 * without being told a port.
 *
 *   diffing await-review   block until the human clicks "Send to agent"
 *   diffing reply <id>     post an agent reply to a comment
 *   diffing resolve <id>   mark a comment resolved
 *   diffing comments       dump the current comments (XML or JSON)
 */

const EXIT_OK = 0;
const EXIT_AWAIT_TIMEOUT = 2;
const EXIT_NO_SERVER = 3;
const EXIT_NOT_FOUND = 4;
const EXIT_USAGE = 5;

export function validateInspectSelectors(
	resource: string,
	file?: string,
	path?: string,
): string | null {
	const hasFile = file != null && file !== "";
	const hasPath = path != null && path !== "";
	if ((resource === "hunks" || resource === "slice") && hasFile && hasPath) {
		return `diffing inspect ${resource}: --path and --file are mutually exclusive`;
	}
	if ((resource === "hunks" || resource === "slice") && !hasFile && !hasPath) {
		return `diffing inspect ${resource}: --file or --path is required`;
	}
	return null;
}

let activeCapability: string | undefined;
let activeAuthToken: string | undefined;

/** Resolve the running server's base URL from the lockfile, or exit cleanly. */
function baseUrl(): string {
	const lock = resolveActiveServerLock();
	if (!lock) {
		console.error(
			"No diffing server running for this repo. Start one with `diffing`.",
		);
		process.exit(EXIT_NO_SERVER);
	}
	// Always connect over loopback even when the server bound 0.0.0.0, so the
	// CLI never traverses the network.
	const host =
		lock.host === "0.0.0.0" || lock.host === "::" ? "127.0.0.1" : lock.host;
	activeCapability = lock.mode === "tui" ? lock.capability : undefined;
	activeAuthToken = lock.authToken;
	return `http://${host}:${lock.port}`;
}

/** Attach session credentials while preserving ordinary web calls. */
function apiFetch(
	input: string | URL | Request,
	init: RequestInit = {},
): Promise<Response> {
	let target: URL;
	try {
		target = new URL(
			input instanceof Request
				? input.url
				: input instanceof URL
					? input.href
					: input,
		);
	} catch {
		return Promise.reject(new Error("Invalid diffing API URL"));
	}
	if (!["127.0.0.1", "localhost", "::1"].includes(target.hostname)) {
		throw new Error(`Refusing non-loopback diffing API URL: ${target.origin}`);
	}
	const headers = new Headers(init.headers);
	if (activeCapability) headers.set("X-Diffing-Capability", activeCapability);
	if (activeAuthToken) headers.set(SESSION_TOKEN_HEADER, activeAuthToken);
	return fetch(input, { ...init, headers });
}

function connectionErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/** apiFetch wrapper that logs connection failures and returns null instead of throwing. */
async function tryApiFetch(
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response | null> {
	try {
		return await apiFetch(input, init);
	} catch (err) {
		console.error(
			`Failed to reach diffing server: ${connectionErrorMessage(err)}`,
		);
		return null;
	}
}

function parseTimeoutSeconds(
	raw: string | undefined,
	flag = "--timeout",
): number | null {
	if (raw === undefined) return DEFAULT_AWAIT_TIMEOUT_SECONDS;
	const t = Number(raw);
	if (!Number.isFinite(t) || t <= 0) {
		console.error(`${flag} must be a positive number of seconds.`);
		return null;
	}
	return t;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8");
}

async function awaitReview(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			timeout: { type: "string", short: "t" },
			since: { type: "string" },
			model: { type: "string", short: "m" },
			label: { type: "string" },
			"agent-id": { type: "string" },
		},
		allowPositionals: false,
	});
	const timeoutSeconds = parseTimeoutSeconds(
		values.timeout as string | undefined,
	);
	if (timeoutSeconds === null) return EXIT_USAGE;
	const totalBudgetMs = timeoutSeconds * 1000;
	const base = baseUrl();

	// Register identity so the human UI can show multi-agent waiting chips.
	let agentId: string | undefined =
		typeof values["agent-id"] === "string" ? values["agent-id"] : undefined;
	try {
		const reg = await apiFetch(`${base}/api/agent/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId,
				model: values.model,
				label: values.label ?? values.model,
			}),
		});
		if (reg.ok) {
			const body = (await reg.json()) as { agentId?: string };
			agentId = body.agentId ?? agentId;
		}
	} catch {
		// Identity is best-effort; await still works without it.
	}

	// Seed the round cursor so we only react to sends that happen from now on.
	let sinceRound = 0;
	const statusRes = await tryApiFetch(`${base}/api/review/status`);
	if (statusRes?.ok) {
		const status = (await statusRes.json()) as { round?: number };
		sinceRound = status.round ?? 0;
	}

	const unregister = async () => {
		if (!agentId) return;
		try {
			await apiFetch(`${base}/api/agent/register/${encodeURIComponent(agentId)}`, {
				method: "DELETE",
			});
		} catch {
			/* ignore */
		}
	};

	const deadline = Date.now() + totalBudgetMs;
	while (Date.now() < deadline) {
		let res: Response;
		try {
			res = await apiFetch(
				`${base}/api/review/await?timeoutMs=25000&sinceRound=${sinceRound}`,
				{ signal: AbortSignal.timeout(30000) },
			);
		} catch (err: any) {
			if (err?.name === "TimeoutError") continue;
			console.error(
				`Failed to reach diffing server: ${connectionErrorMessage(err)}`,
			);
			await unregister();
			return EXIT_NO_SERVER;
		}
		if (!res.ok) {
			console.error(`Failed to await review: HTTP ${res.status}`);
			await unregister();
			return 1;
		}
		const result = await res.json();
		if (result.status === "released") {
			process.stdout.write(result.payload.commentXml + "\n");
			console.error(`DIFFING_REVIEW_ROUND=${result.payload.round}`);
			await unregister();
			return EXIT_OK;
		}
		sinceRound = result.round ?? sinceRound;
	}

	console.error("DIFFING_AWAIT_TIMEOUT");
	console.error(CLI_AWAIT_REVIEW_TIMEOUT_HINT);
	await unregister();
	return EXIT_AWAIT_TIMEOUT;
}

async function reply(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			body: { type: "string", short: "b" },
			model: { type: "string", short: "m" },
		},
		allowPositionals: true,
	});
	const commentId = positionals[0];
	if (!commentId) {
		console.error(
			"Usage: diffing reply <commentId> --body <text> [--model <name>]",
		);
		return EXIT_USAGE;
	}
	let body = values.body;
	if (body === undefined) {
		if (process.stdin.isTTY) {
			console.error(
				"Usage: diffing reply <commentId> --body <text> [--model <name>]",
			);
			return EXIT_USAGE;
		}
		body = (await readStdin()).trim();
	} else if (body === "-") {
		body = (await readStdin()).trim();
	}
	if (!body) {
		console.error("A reply body is required (--body <text> or pipe via stdin).");
		return EXIT_USAGE;
	}

	const res = await tryApiFetch(
		`${baseUrl()}/api/comments/${commentId}/replies`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body, role: "agent", model: values.model }),
		},
	);
	if (!res) return EXIT_NO_SERVER;
	if (res.status === 404) {
		console.error(`Comment ${commentId} not found.`);
		return EXIT_NOT_FOUND;
	}
	if (!res.ok) {
		console.error(`Failed to reply: HTTP ${res.status}`);
		return 1;
	}
	console.error(`Replied to ${commentId}.`);
	return EXIT_OK;
}

async function resolve(args: string[]): Promise<number> {
	const { positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {},
	});
	const commentId = positionals[0];
	if (!commentId) {
		console.error("Usage: diffing resolve <commentId>");
		return EXIT_USAGE;
	}
	const res = await tryApiFetch(`${baseUrl()}/api/comments/${commentId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status: "resolved" }),
	});
	if (!res) return EXIT_NO_SERVER;
	if (res.status === 404) {
		console.error(`Comment ${commentId} not found.`);
		return EXIT_NOT_FOUND;
	}
	if (!res.ok) {
		console.error(`Failed to resolve: HTTP ${res.status}`);
		return 1;
	}
	console.error(`Resolved ${commentId}.`);
	return EXIT_OK;
}

async function unresolve(args: string[]): Promise<number> {
	const { positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {},
	});
	const commentId = positionals[0];
	if (!commentId) {
		console.error("Usage: diffing unresolve <commentId>");
		return EXIT_USAGE;
	}
	const res = await tryApiFetch(`${baseUrl()}/api/comments/${commentId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status: "open" }),
	});
	if (!res) return EXIT_NO_SERVER;
	if (res.status === 404) {
		console.error(`Comment ${commentId} not found.`);
		return EXIT_NOT_FOUND;
	}
	if (!res.ok) {
		console.error(`Failed to unresolve: HTTP ${res.status}`);
		return 1;
	}
	console.error(`Re-opened ${commentId}.`);
	return EXIT_OK;
}

async function commentEdit(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { body: { type: "string", short: "b" } },
		allowPositionals: true,
	});
	const commentId = positionals[0];
	if (!commentId) {
		console.error("Usage: diffing comment edit <commentId> --body <text>");
		return EXIT_USAGE;
	}
	let body = values.body as string | undefined;
	if (body === undefined) {
		if (process.stdin.isTTY) {
			console.error("Usage: diffing comment edit <commentId> --body <text>");
			return EXIT_USAGE;
		}
		body = (await readStdin()).trim();
	} else if (body === "-") {
		body = (await readStdin()).trim();
	}
	if (!body) {
		console.error("A body is required (--body <text> or stdin).");
		return EXIT_USAGE;
	}
	const res = await tryApiFetch(`${baseUrl()}/api/comments/${commentId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ body }),
	});
	if (!res) return EXIT_NO_SERVER;
	if (res.status === 404) {
		console.error(`Comment ${commentId} not found.`);
		return EXIT_NOT_FOUND;
	}
	if (!res.ok) {
		console.error(`Failed to edit: HTTP ${res.status}`);
		return 1;
	}
	console.error(`Edited ${commentId}.`);
	return EXIT_OK;
}

async function commentDelete(args: string[]): Promise<number> {
	const { positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {},
	});
	const commentId = positionals[0];
	if (!commentId) {
		console.error("Usage: diffing comment delete <commentId>");
		return EXIT_USAGE;
	}
	const res = await tryApiFetch(`${baseUrl()}/api/comments/${commentId}`, {
		method: "DELETE",
	});
	if (!res) return EXIT_NO_SERVER;
	if (res.status === 404) {
		console.error(`Comment ${commentId} not found.`);
		return EXIT_NOT_FOUND;
	}
	if (!res.ok) {
		console.error(`Failed to delete: HTTP ${res.status}`);
		return 1;
	}
	console.error(`Deleted ${commentId}.`);
	return EXIT_OK;
}

async function commentCmd(args: string[]): Promise<number> {
	const action = args[0];
	const rest = args.slice(1);
	switch (action) {
		case "edit":
			return commentEdit(rest);
		case "delete":
			return commentDelete(rest);
		default:
			console.error("Usage: diffing comment <edit|delete> ...");
			return EXIT_USAGE;
	}
}

async function url(): Promise<number> {
	const lock = resolveActiveServerLock();
	if (!lock) {
		console.error(
			"No diffing server running for this repo. Start one with `diffing`.",
		);
		process.exit(EXIT_NO_SERVER);
	}
	const printed = reviewSessionUrl(lock) ?? baseUrl();
	process.stdout.write(`${printed}\n`);
	return EXIT_OK;
}

async function comments(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			open: { type: "boolean" },
			json: { type: "boolean" },
			format: { type: "string" },
		},
		allowPositionals: false,
	});
	const res = await tryApiFetch(`${baseUrl()}/api/comments`);
	if (!res) return EXIT_NO_SERVER;
	if (!res.ok) {
		console.error(`Failed to fetch comments: HTTP ${res.status}`);
		return 1;
	}
	const all: ReviewComment[] = await res.json();
	const selected = values.open ? all.filter((c) => c.status === "open") : all;
	const format = (values.format as string | undefined)?.toLowerCase();
	if (
		format &&
		format !== "xml" &&
		format !== "json" &&
		format !== "md" &&
		format !== "markdown"
	) {
		console.error("Unknown --format. Use xml, json, md, or markdown.");
		return EXIT_USAGE;
	}
	if (values.json || format === "json") {
		process.stdout.write(JSON.stringify(selected, null, 2) + "\n");
	} else if (format === "markdown" || format === "md") {
		const { formatCommentsMarkdown } = await import("./lib/review-export.js");
		process.stdout.write(formatCommentsMarkdown(selected) + "\n");
	} else {
		process.stdout.write(formatComments(selected) + "\n");
	}
	return EXIT_OK;
}

function mode(args: string[]): number {
	if (args.length === 0) {
		process.stdout.write(loadSettings().defaultMode + "\n");
		return EXIT_OK;
	}

	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		process.stdout.write("Usage: diffing mode <web|tui>\n");
		return EXIT_OK;
	}

	const requested = args[0];
	if (args.length !== 1 || (requested !== "web" && requested !== "tui")) {
		console.error("Usage: diffing mode <web|tui>");
		return EXIT_USAGE;
	}

	try {
		saveSettings({ defaultMode: requested });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.error(`Failed to save default mode: ${detail}`);
		return 1;
	}
	process.stdout.write(`Default mode set to ${formatModeLabel(requested)}.\n`);
	return EXIT_OK;
}

// ── Plan review subcommands ─────────────────────────────────────────────────
// `diffing plan <action>` drives the plan-review handoff: submit a markdown plan
// for review, block until the human approves/rejects/requests-changes, and
// reply/resolve the inline comments — all port-agnostic via the lockfile.

/** Derive a human title from a plan's first heading or non-empty line. */
function deriveTitle(body: string): string {
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		return (heading ? heading[1] : line).slice(0, 120);
	}
	return "Untitled plan";
}

/** Long-poll the plan-review handoff until a decision arrives or time runs out. */
async function pollPlanDecision(
	base: string,
	totalBudgetMs: number,
	seedSince?: number,
): Promise<number> {
	let sinceRound = seedSince ?? 0;
	if (seedSince === undefined) {
		const statusRes = await tryApiFetch(`${base}/api/plan-review/status`);
		if (statusRes?.ok) {
			const status = (await statusRes.json()) as { round?: number };
			sinceRound = status.round ?? 0;
		}
	}

	const deadline = Date.now() + totalBudgetMs;
	while (Date.now() < deadline) {
		let res: Response;
		try {
			res = await apiFetch(
				`${base}/api/plan-review/await?timeoutMs=25000&sinceRound=${sinceRound}`,
				{ signal: AbortSignal.timeout(30000) },
			);
		} catch (err: any) {
			if (err?.name === "TimeoutError") continue;
			console.error(
				`Failed to reach diffing server: ${connectionErrorMessage(err)}`,
			);
			return EXIT_NO_SERVER;
		}
		if (!res.ok) {
			console.error(`Failed to await plan review: HTTP ${res.status}`);
			return 1;
		}
		const result = await res.json();
		if (result.status === "released") {
			process.stdout.write(result.payload.reviewXml + "\n");
			console.error(`DIFFING_PLAN_DECISION=${result.payload.decision}`);
			console.error(`DIFFING_PLAN_ROUND=${result.payload.round}`);
			return EXIT_OK;
		}
		sinceRound = result.round ?? sinceRound;
	}

	console.error("DIFFING_PLAN_AWAIT_TIMEOUT");
	console.error(CLI_AWAIT_PLAN_TIMEOUT_HINT);
	return EXIT_AWAIT_TIMEOUT;
}

async function planSubmit(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			title: { type: "string" },
			source: { type: "string", short: "s" },
			model: { type: "string", short: "m" },
			id: { type: "string" },
			wait: { type: "boolean", short: "w" },
			timeout: { type: "string", short: "t" },
			// Kebab-case is canonical; camelCase kept so older docs/skills still work.
			"save-source": { type: "boolean", short: "S" },
			saveSource: { type: "boolean" },
		},
		allowPositionals: true,
	});

	const file = positionals[0];
	let body: string;
	if (!file || file === "-") {
		body = await readStdin();
	} else {
		try {
			body = await readFile(file, "utf-8");
		} catch (err: any) {
			console.error(`Failed to read plan file ${file}: ${err?.message ?? err}`);
			return EXIT_USAGE;
		}
	}
	body = body.replace(/\r\n/g, "\n");
	if (!body.trim()) {
		console.error(
			"A plan body is required (pass a markdown file path or pipe via stdin).",
		);
		return EXIT_USAGE;
	}

	const title = values.title || deriveTitle(body);
	const base = baseUrl();
	// Prefer an explicit --source; otherwise stamp the absolute path of the
	// input file so reviewers can copy it from the UI for agent handoff.
	let source = values.source;
	if (!source && file && file !== "-") {
		try {
			const { resolve } = await import("node:path");
			source = resolve(file);
		} catch {
			source = file;
		}
	}

	// Capture the current round so --wait only reacts to decisions after submit.
	let sinceRound = 0;
	if (values.wait) {
		const statusRes = await tryApiFetch(`${base}/api/plan-review/status`);
		if (statusRes?.ok) {
			const status = (await statusRes.json()) as { round?: number };
			sinceRound = status.round ?? 0;
		}
	}

	const submitRes = await tryApiFetch(`${base}/api/plans`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			id: values.id,
			title,
			body,
			source,
			model: values.model,
		}),
	});
	if (!submitRes) return EXIT_NO_SERVER;
	if (!submitRes.ok) {
		console.error(`Failed to submit plan: HTTP ${submitRes.status}`);
		return 1;
	}
	const plan = (await submitRes.json()) as Plan;
	console.error(
		`Submitted plan ${plan.id} (v${plan.version}) — review at ${appendSessionToken(`${base}/plan/${plan.id}`, activeAuthToken)}`,
	);
	if (plan.sourcePath) {
		console.error(`Source path: ${plan.sourcePath}`);
	}
	if (!values.wait) {
		console.error(CLI_PLAN_SUBMIT_PARK_HINT);
	}

	// Optional extra mirror under plan-sources/ (--save-source / -S / --saveSource).
	// Server always writes ~/.diffing/.../plan-sources/<id>.md as sourcePath.
	const saveSource = Boolean(values["save-source"] || values.saveSource);
	if (saveSource) {
		try {
			const sourcesDir = join(getProjectStorageDir(), "plan-sources");
			await mkdir(sourcesDir, { recursive: true });
			const sourcePath = join(sourcesDir, `${plan.id}.md`);
			await writeFile(sourcePath, body, "utf-8");
			console.error(`Saved source to ${sourcePath}`);
		} catch (err: any) {
			console.error(`Failed to save plan source: ${err?.message ?? err}`);
		}
	}

	if (!values.wait) {
		process.stdout.write(plan.id + "\n");
		return EXIT_OK;
	}
	const timeoutSeconds = parseTimeoutSeconds(
		values.timeout as string | undefined,
	);
	if (timeoutSeconds === null) return EXIT_USAGE;
	return pollPlanDecision(base, timeoutSeconds * 1000, sinceRound);
}

async function planAwait(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { timeout: { type: "string", short: "t" } },
		allowPositionals: false,
	});
	const timeoutSeconds = parseTimeoutSeconds(
		values.timeout as string | undefined,
	);
	if (timeoutSeconds === null) return EXIT_USAGE;
	return pollPlanDecision(baseUrl(), timeoutSeconds * 1000);
}

async function planList(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { json: { type: "boolean" } },
		allowPositionals: false,
	});
	const res = await tryApiFetch(`${baseUrl()}/api/plans`);
	if (!res) return EXIT_NO_SERVER;
	if (!res.ok) {
		console.error(`Failed to list plans: HTTP ${res.status}`);
		return 1;
	}
	const all: Plan[] = await res.json();
	if (values.json) {
		process.stdout.write(JSON.stringify(all, null, 2) + "\n");
		return EXIT_OK;
	}
	if (all.length === 0) {
		console.error("No plans submitted yet.");
		return EXIT_OK;
	}
	for (const p of all) {
		const open = (p.comments ?? []).filter((c) => c.status === "open").length;
		process.stdout.write(
			`${p.id}\t[${p.decision}]\tv${p.version}\t${open} open comment(s)\t${p.title}\n`,
		);
	}
	return EXIT_OK;
}

async function planShow(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { json: { type: "boolean" }, version: { type: "string" } },
		allowPositionals: true,
	});
	const base = baseUrl();
	let planId = positionals[0];
	if (!planId) {
		const listRes = await tryApiFetch(`${base}/api/plans`);
		if (!listRes) return EXIT_NO_SERVER;
		if (!listRes.ok) {
			console.error(`Failed to list plans: HTTP ${listRes.status}`);
			return 1;
		}
		const all: Plan[] = await listRes.json();
		if (all.length === 0) {
			console.error("No plans submitted yet.");
			return EXIT_NOT_FOUND;
		}
		planId = all[all.length - 1].id;
	}
	const res = await tryApiFetch(`${base}/api/plans/${planId}`);
	if (!res) return EXIT_NO_SERVER;
	if (res.status === 404) {
		console.error(`Plan ${planId} not found.`);
		return EXIT_NOT_FOUND;
	}
	if (!res.ok) {
		console.error(`Failed to load plan: HTTP ${res.status}`);
		return 1;
	}
	const plan = (await res.json()) as Plan;
	const requestedVersion =
		values.version === undefined ? undefined : Number(values.version);
	if (
		requestedVersion !== undefined &&
		(!Number.isFinite(requestedVersion) || requestedVersion < 1)
	) {
		console.error(`--version must be a positive integer.`);
		return EXIT_USAGE;
	}
	if (requestedVersion !== undefined && requestedVersion !== plan.version) {
		const ver = (plan.versions ?? []).find((v) => v.version === requestedVersion);
		if (!ver) {
			console.error(
				`Version ${requestedVersion} not found for plan ${planId} (current: v${plan.version}).`,
			);
			return EXIT_NOT_FOUND;
		}
	}
	if (values.json) {
		process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
	} else {
		process.stdout.write(
			formatPlanReview(plan, { viewingVersion: requestedVersion }) + "\n",
		);
	}
	return EXIT_OK;
}

async function planVersions(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { json: { type: "boolean" } },
		allowPositionals: true,
	});
	const base = baseUrl();
	const planId = positionals[0];
	if (!planId) {
		console.error("Usage: diffing plan versions <id> [--json]");
		return EXIT_USAGE;
	}
	const planRes = await tryApiFetch(`${base}/api/plans/${planId}`);
	if (!planRes) return EXIT_NO_SERVER;
	if (planRes.status === 404) {
		console.error(`Plan ${planId} not found.`);
		return EXIT_NOT_FOUND;
	}
	if (!planRes.ok) {
		console.error(`Failed to load plan: HTTP ${planRes.status}`);
		return 1;
	}
	const plan = (await planRes.json()) as Plan;
	const versions = plan.versions ?? [];
	if (values.json) {
		process.stdout.write(JSON.stringify(versions, null, 2) + "\n");
		return EXIT_OK;
	}
	if (versions.length === 0) {
		console.error("This plan has no recorded versions.");
		return EXIT_OK;
	}
	for (const v of versions) {
		const marker = v.version === plan.version ? "*" : " ";
		const date = new Date(v.createdAt)
			.toISOString()
			.slice(0, 16)
			.replace("T", " ");
		process.stdout.write(`${marker} v${v.version}\t${date}\t${v.title}\n`);
	}
	return EXIT_OK;
}

/** Locate which plan owns a given comment id (comment ids are globally unique). */
async function findCommentPlan(
	base: string,
	commentId: string,
): Promise<Plan | null> {
	const res = await tryApiFetch(`${base}/api/plans`);
	if (!res?.ok) return null;
	const all: Plan[] = await res.json();
	return (
		all.find((p) => (p.comments ?? []).some((c) => c.id === commentId)) ?? null
	);
}

async function planReply(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			body: { type: "string", short: "b" },
			model: { type: "string", short: "m" },
		},
		allowPositionals: true,
	});
	const commentId = positionals[0];
	if (!commentId) {
		console.error(
			"Usage: diffing plan reply <commentId> --body <text> [--model <name>]",
		);
		return EXIT_USAGE;
	}
	let body = values.body;
	if (body === undefined) {
		if (process.stdin.isTTY) {
			console.error(
				"Usage: diffing plan reply <commentId> --body <text> [--model <name>]",
			);
			return EXIT_USAGE;
		}
		body = (await readStdin()).trim();
	} else if (body === "-") {
		body = (await readStdin()).trim();
	}
	if (!body) {
		console.error("A reply body is required (--body <text> or pipe via stdin).");
		return EXIT_USAGE;
	}
	const base = baseUrl();
	const plan = await findCommentPlan(base, commentId);
	if (!plan) {
		console.error(`Plan comment ${commentId} not found.`);
		return EXIT_NOT_FOUND;
	}
	const res = await tryApiFetch(
		`${base}/api/plans/${plan.id}/comments/${commentId}/replies`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body, role: "agent", model: values.model }),
		},
	);
	if (!res) return EXIT_NO_SERVER;
	if (!res.ok) {
		console.error(`Failed to reply: HTTP ${res.status}`);
		return 1;
	}
	console.error(`Replied to plan comment ${commentId}.`);
	return EXIT_OK;
}

async function planResolve(args: string[]): Promise<number> {
	const { positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {},
	});
	const commentId = positionals[0];
	if (!commentId) {
		console.error("Usage: diffing plan resolve <commentId>");
		return EXIT_USAGE;
	}
	const base = baseUrl();
	const plan = await findCommentPlan(base, commentId);
	if (!plan) {
		console.error(`Plan comment ${commentId} not found.`);
		return EXIT_NOT_FOUND;
	}
	const res = await tryApiFetch(
		`${base}/api/plans/${plan.id}/comments/${commentId}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "resolved" }),
		},
	);
	if (!res) return EXIT_NO_SERVER;
	if (!res.ok) {
		console.error(`Failed to resolve: HTTP ${res.status}`);
		return 1;
	}
	console.error(`Resolved plan comment ${commentId}.`);
	return EXIT_OK;
}

async function plan(args: string[]): Promise<number> {
	const action = args[0];
	const rest = args.slice(1);
	switch (action) {
		case "submit":
			return planSubmit(rest);
		case "await":
			return planAwait(rest);
		case "list":
			return planList(rest);
		case "show":
			return planShow(rest);
		case "versions":
			return planVersions(rest);
		case "reply":
			return planReply(rest);
		case "resolve":
			return planResolve(rest);
		default:
			console.error(
				"Usage: diffing plan <submit|await|list|show|versions|reply|resolve> [...]",
			);
			return EXIT_USAGE;
	}
}

async function setup(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`Usage: diffing setup [skills|mcp] [options]

Interactive first-time setup: doctor, default mode, completions, agent skills, MCP.

Options:
  -y, --yes                 Non-interactive defaults (install skills; print MCP JSON)
  --check                   Preflight checks only
  --reset                   Clear setupCompletedAt marker
  --write-mcp               Merge diffing into global IDE MCP configs
  --write-project-mcp       Write .cursor/mcp.json in the current directory
  --write-completions       Print shell completion scripts
  -h, --help                Show this help

Aliases: diffing init, diffing onboard

See docs/getting-started.md for the full walkthrough.`);
		return EXIT_OK;
	}

	let yes = false;
	let check = false;
	let reset = false;
	let writeMcp = false;
	let writeProjectMcp = false;
	let writeCompletions = false;
	const positionals: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "-y" || arg === "--yes") yes = true;
		else if (arg === "--check") check = true;
		else if (arg === "--reset") reset = true;
		else if (arg === "--write-mcp") writeMcp = true;
		else if (arg === "--write-project-mcp") writeProjectMcp = true;
		else if (arg === "--write-completions") writeCompletions = true;
		else if (arg.startsWith("-")) {
			console.error(`diffing setup: unknown option ${arg}`);
			return EXIT_USAGE;
		} else {
			positionals.push(arg);
		}
	}

	const action = positionals[0];
	if (positionals.length > 1) {
		console.error("Usage: diffing setup [skills|mcp] [options]");
		return EXIT_USAGE;
	}
	if (action && action !== "skills" && action !== "mcp") {
		console.error(`Unknown setup action: ${action}`);
		return EXIT_USAGE;
	}

	const { runSetup } = await import("./lib/setup.js");
	return runSetup({
		yes,
		check,
		reset,
		writeMcp,
		writeProjectMcp,
		writeCompletions,
		skillsOnly: action === "skills",
		mcpOnly: action === "mcp",
		cliImportMetaUrl: import.meta.url,
	});
}

async function doctor(): Promise<number> {
	const { runDoctor, formatDoctorReport } = await import("./lib/doctor.js");
	const report = await runDoctor({
		cwd: process.cwd(),
		cliImportMetaUrl: import.meta.url,
	});
	process.stdout.write(formatDoctorReport(report) + "\n");
	return report.ok ? EXIT_OK : 1;
}

async function completion(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		console.error("Usage: diffing completion <bash|zsh|fish>");
		console.error("  # Install examples:");
		console.error("  #   diffing completion bash >> ~/.bashrc");
		console.error("  #   diffing completion zsh  > ~/.zfunc/_diffing");
		console.error(
			"  #   diffing completion fish > ~/.config/fish/completions/diffing.fish",
		);
		return EXIT_OK;
	}
	const shell = args[0];
	if (!shell) {
		console.error("Usage: diffing completion <bash|zsh|fish>");
		return EXIT_USAGE;
	}
	const { completionFor } = await import("./lib/completions.js");
	const script = completionFor(shell);
	if (!script) {
		console.error(`Unknown shell: ${shell}. Use bash, zsh, or fish.`);
		return EXIT_USAGE;
	}
	process.stdout.write(script);
	return EXIT_OK;
}

/**
 * CLI mirror of the AI evidence surface, so HTTP, MCP and CLI reach the same
 * bounded evidence. Every subcommand is read-only.
 */
async function evidence(args: string[]): Promise<number> {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args,
			options: {
				revision: { type: "string" },
				cursor: { type: "string" },
				limit: { type: "string" },
				key: { type: "string" },
				range: { type: "string", multiple: true },
				"max-bytes": { type: "string" },
				representation: { type: "string" },
				query: { type: "string", short: "q" },
				"ignore-case": { type: "boolean" },
				line: { type: "string" },
				character: { type: "string" },
				kind: { type: "string" },
				"include-declaration": { type: "boolean" },
				reference: { type: "string" },
				pretty: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
			allowPositionals: true,
		});
	} catch (error: any) {
		console.error(error?.message ?? error);
		return EXIT_USAGE;
	}

	const [resource, positional, ...extra] = parsed.positionals;
	const values = parsed.values;
	if (values.help || !resource || extra.length > 0) {
		console.error(`Usage: diffing evidence <list|map|read|search|symbols|verify|history|discussion> [<id>] [options]

Read the review snapshot a recent AI run captured. Read-only; no run is started.
  list
  map        <id> [--revision R] [--cursor N] [--limit N]
  read       <id> --range KEY:START:END [--range ...] [--representation original|unified-patch] [--max-bytes N]
  search     <id> <text>|--query T [--key K] [--limit N] [--ignore-case] [--cursor N]
  symbols    <id> --key K --line N --character N --kind definitions|references [--include-declaration]
  verify     <id> --revision R --reference JSON
  history    <id> --key K [--limit N] [--cursor N]
  discussion <id> [--key K] [--limit N] [--cursor N]

Listing and searching are not reading: they add nothing to returned-line coverage.
Add --pretty for indented JSON. Compact JSON is the token-efficient default.`);
		return values.help ? EXIT_OK : EXIT_USAGE;
	}

	const known = new Set([
		"list",
		"map",
		"read",
		"search",
		"symbols",
		"verify",
		"history",
		"discussion",
	]);
	if (!known.has(resource)) {
		console.error(`Unknown evidence resource: ${resource}`);
		return EXIT_USAGE;
	}
	if (resource !== "list" && !positional) {
		console.error(`diffing evidence ${resource}: a snapshot id is required`);
		return EXIT_USAGE;
	}

	const integer = (name: string): number | undefined | null => {
		const raw = values[name as keyof typeof values];
		if (typeof raw !== "string") return undefined;
		if (!/^\d+$/.test(raw)) {
			console.error(`--${name} must be a non-negative integer`);
			return null;
		}
		return Number(raw);
	};

	const params = new URLSearchParams();
	if (typeof values.revision === "string")
		params.set("revision", values.revision);

	let path: string;
	let init: RequestInit | undefined;
	const id = encodeURIComponent(positional ?? "");

	switch (resource) {
		case "list":
			path = "/api/ai/evidence";
			break;
		case "map": {
			for (const name of ["cursor", "limit"]) {
				const value = integer(name);
				if (value === null) return EXIT_USAGE;
				if (value !== undefined) params.set(name, String(value));
			}
			path = `/api/ai/evidence/${id}/map`;
			break;
		}
		case "read": {
			const ranges = (Array.isArray(values.range) ? values.range : []).filter(
				(range): range is string => typeof range === "string",
			);
			if (!ranges.length) {
				console.error("diffing evidence read: at least one --range is required");
				return EXIT_USAGE;
			}
			const requests = [];
			for (const range of ranges) {
				// KEY may contain colons, so split from the right.
				const match = /^(.*):(\d+):(\d+)$/.exec(range);
				if (!match) {
					console.error(`--range must be KEY:START:END, got ${range}`);
					return EXIT_USAGE;
				}
				requests.push({
					key: match[1],
					startLine: Number(match[2]),
					endLine: Number(match[3]),
				});
			}
			const maxBytes = integer("max-bytes");
			if (maxBytes === null) return EXIT_USAGE;
			path = `/api/ai/evidence/${id}/read`;
			init = {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests,
					maxBytes,
					representation: values.representation,
				}),
			};
			break;
		}
		case "search": {
			const query =
				typeof values.query === "string" ? values.query : parsed.positionals[2];
			if (!query) {
				console.error("diffing evidence search: provide search text or --query");
				return EXIT_USAGE;
			}
			const limit = integer("limit");
			if (limit === null) return EXIT_USAGE;
			path = `/api/ai/evidence/${id}/search`;
			init = {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					query,
					key: values.key,
					limit,
					ignoreCase: values["ignore-case"] === true,
					cursor: values.cursor,
				}),
			};
			break;
		}
		case "symbols": {
			const line = integer("line");
			const character = integer("character");
			if (line === null || character === null) return EXIT_USAGE;
			if (
				typeof values.key !== "string" ||
				line === undefined ||
				character === undefined ||
				(values.kind !== "definitions" && values.kind !== "references")
			) {
				console.error(
					"diffing evidence symbols: --key, --line, --character and --kind definitions|references are required",
				);
				return EXIT_USAGE;
			}
			path = `/api/ai/evidence/${id}/symbols`;
			init = {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key: values.key,
					line,
					character,
					kind: values.kind,
					includeDeclaration: values["include-declaration"] === true,
				}),
			};
			break;
		}
		case "verify": {
			if (
				typeof values.reference !== "string" ||
				typeof values.revision !== "string"
			) {
				console.error(
					"diffing evidence verify: --reference JSON and --revision are required",
				);
				return EXIT_USAGE;
			}
			let reference: unknown;
			try {
				reference = JSON.parse(values.reference);
			} catch {
				console.error("--reference must be JSON");
				return EXIT_USAGE;
			}
			path = `/api/ai/evidence/${id}/verify`;
			init = {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reference, revision: values.revision }),
			};
			break;
		}
		default: {
			// history and discussion share a shape.
			if (resource === "history" && typeof values.key !== "string") {
				console.error("diffing evidence history: --key is required");
				return EXIT_USAGE;
			}
			if (typeof values.key === "string") params.set("key", values.key);
			for (const name of ["cursor", "limit"]) {
				const value = integer(name);
				if (value === null) return EXIT_USAGE;
				if (value !== undefined) params.set(name, String(value));
			}
			path = `/api/ai/evidence/${id}/${resource}`;
			break;
		}
	}

	const queryString = params.toString();
	let response: Response;
	try {
		response = await apiFetch(
			`${baseUrl()}${path}${queryString ? `?${queryString}` : ""}`,
			init,
		);
	} catch (error) {
		console.error(
			`Failed to reach diffing server: ${connectionErrorMessage(error)}`,
		);
		return EXIT_NO_SERVER;
	}
	const body = await response
		.json()
		.catch(() => ({ error: response.statusText }));
	if (!response.ok) {
		console.error((body as any).error ?? response.statusText);
		return response.status === 404 ? EXIT_NOT_FOUND : 1;
	}
	process.stdout.write(
		`${JSON.stringify(body, null, values.pretty ? 2 : undefined)}\n`,
	);
	return EXIT_OK;
}

async function inspect(args: string[]): Promise<number> {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args,
			options: {
				cursor: { type: "string" },
				limit: { type: "string" },
				file: { type: "string" },
				path: { type: "string" },
				exclude: { type: "string" },
				generation: { type: "string" },
				start: { type: "string" },
				row: { type: "string" },
				query: { type: "string", short: "q" },
				"max-lines": { type: "string" },
				"max-bytes": { type: "string" },
				pretty: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
			allowPositionals: true,
		});
	} catch (error: any) {
		console.error(error?.message ?? error);
		return EXIT_USAGE;
	}

	const [resource, positionalQuery, ...extra] = parsed.positionals;
	if (parsed.values.help || !resource || extra.length > 0) {
		console.error(`Usage: diffing inspect <summary|files|hunks|slice|search> [options]

Read bounded data from a running session (web, TUI, or gh-pr) without transferring the full patch.
  summary [--exclude lockfiles]
  files   [--path GLOB] [--cursor N] [--limit N]
  hunks   (--file N | --path GLOB) [--cursor N] [--limit N] [--generation N]
  slice   (--file N | --path GLOB) [--start N] [--max-lines N] [--max-bytes N] [--generation N]
  search  <text>|--query <text> [--path GLOB] [--file N] [--row N] [--limit N] [--max-bytes N] [--generation N]

Filtered files nextCursor is an index into the filtered list, not a global file index.
Add --pretty for indented JSON. Compact JSON is the token-efficient default.`);
		return parsed.values.help ? EXIT_OK : EXIT_USAGE;
	}

	const endpoint = new Map([
		["summary", "/api/diff/summary"],
		["files", "/api/diff/files"],
		["hunks", "/api/diff/hunks"],
		["slice", "/api/diff/slice"],
		["search", "/api/diff/search"],
	]).get(resource);
	if (!endpoint) {
		console.error(`Unknown inspect resource: ${resource}`);
		return EXIT_USAGE;
	}

	const params = new URLSearchParams();
	const numberOptions: Array<[keyof typeof parsed.values, string]> = [
		["cursor", "cursor"],
		["limit", "limit"],
		["file", "file"],
		["generation", "generation"],
		["start", "start"],
		["row", "row"],
		["max-lines", "maxLines"],
		["max-bytes", "maxBytes"],
	];
	for (const [option, parameter] of numberOptions) {
		const value = parsed.values[option];
		if (typeof value !== "string") continue;
		if (!/^\d+$/.test(value)) {
			console.error(`--${option} must be a non-negative integer`);
			return EXIT_USAGE;
		}
		params.set(parameter, value);
	}
	const path = parsed.values.path;
	if (typeof path === "string") params.set("path", path);
	const exclude = parsed.values.exclude;
	if (typeof exclude === "string") params.set("exclude", exclude);
	const selectorError = validateInspectSelectors(
		resource,
		typeof parsed.values.file === "string" ? parsed.values.file : undefined,
		typeof path === "string" ? path : undefined,
	);
	if (selectorError) {
		console.error(selectorError);
		return EXIT_USAGE;
	}
	if (resource === "search") {
		const queryOption = parsed.values.query;
		const query = typeof queryOption === "string" ? queryOption : positionalQuery;
		if (!query) {
			console.error("diffing inspect search: provide search text or --query");
			return EXIT_USAGE;
		}
		params.set("q", query);
	} else if (positionalQuery) {
		console.error(
			`diffing inspect ${resource}: unexpected argument ${positionalQuery}`,
		);
		return EXIT_USAGE;
	}

	const base = baseUrl();
	const queryString = params.toString();
	let response: Response;
	try {
		response = await apiFetch(
			`${base}${endpoint}${queryString ? `?${queryString}` : ""}`,
		);
	} catch (error) {
		console.error(
			`Failed to reach diffing server: ${connectionErrorMessage(error)}`,
		);
		return EXIT_NO_SERVER;
	}
	const body = await response
		.json()
		.catch(() => ({ error: response.statusText }));
	if (!response.ok) {
		console.error((body as any).error ?? response.statusText);
		return response.status === 404 ? EXIT_NOT_FOUND : 1;
	}
	process.stdout.write(
		JSON.stringify(body, null, parsed.values.pretty ? 2 : undefined) + "\n",
	);
	return EXIT_OK;
}

async function progress(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			message: { type: "string", short: "m" },
			model: { type: "string" },
			"agent-id": { type: "string" },
			pct: { type: "string" },
			"comment-id": { type: "string" },
		},
		allowPositionals: true,
	});
	const message = (values.message as string | undefined) || positionals[0] || "";
	if (!message) {
		console.error(
			'Usage: diffing progress --message "Working on comment…" [--model M] [--pct N]',
		);
		return EXIT_USAGE;
	}
	const base = baseUrl();
	const res = await tryApiFetch(`${base}/api/agent/progress`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			message,
			model: values.model,
			agentId: values["agent-id"],
			commentId: values["comment-id"],
			pct: values.pct == null ? undefined : Number(values.pct),
		}),
	});
	if (!res) return EXIT_NO_SERVER;
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		console.error((err as any).error ?? res.statusText);
		return 1;
	}
	return EXIT_OK;
}

const CLI_MOCKUP_SUBMIT_PARK_HINT =
	"Async handoff: share the URL above. Use --wait / `diffing mockup await` only when the human is reviewing now or asked you to block.";

async function pollMockupDecision(
	base: string,
	timeoutMs: number,
	sinceRound = 0,
): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const remaining = Math.max(deadline - Date.now(), 0);
		const timeout = Math.min(remaining, 25000);
		const res = await tryApiFetch(
			`${base}/api/mockup-review/await?sinceRound=${sinceRound}&timeoutMs=${timeout}`,
		);
		if (!res) return EXIT_NO_SERVER;
		if (!res.ok) {
			console.error(`Failed to await mockup review: HTTP ${res.status}`);
			return 1;
		}
		const result = (await res.json()) as {
			status: string;
			payload?: { decision?: string; reviewXml?: string; round?: number };
			round?: number;
		};
		if (result.status === "released" && result.payload) {
			if (result.payload.reviewXml)
				process.stdout.write(result.payload.reviewXml + "\n");
			console.error(`DIFFING_MOCKUP_DECISION=${result.payload.decision}`);
			console.error(`DIFFING_MOCKUP_ROUND=${result.payload.round}`);
			return EXIT_OK;
		}
		sinceRound = result.round ?? sinceRound;
	}
	console.error("DIFFING_MOCKUP_AWAIT_TIMEOUT");
	return EXIT_AWAIT_TIMEOUT;
}

async function screensFromCli(
	file: string | undefined,
	screenFlags: string[] | undefined,
): Promise<{
	screens?: { id: string; label?: string; html: string }[];
	html?: string;
	error?: string;
	source?: string;
}> {
	if (screenFlags && screenFlags.length > 0) {
		const screens = [];
		for (const flag of screenFlags) {
			const eq = flag.indexOf("=");
			if (eq <= 0) return { error: `--screen must be id=path (got ${flag})` };
			const id = slugifyScreenId(flag.slice(0, eq));
			if (!id) return { error: `Invalid screen id in ${flag}` };
			const path = resolvePath(flag.slice(eq + 1));
			try {
				const html = (await readFile(path, "utf-8")).replace(/\r\n/g, "\n");
				screens.push({ id, html });
			} catch (err: any) {
				return { error: `Failed to read ${path}: ${err?.message ?? err}` };
			}
		}
		return { screens };
	}
	if (!file || file === "-") {
		const html = (await readStdin()).replace(/\r\n/g, "\n");
		if (!html.trim())
			return {
				error: "A mockup HTML body is required (file, dir, --screen, or stdin).",
			};
		return { html };
	}
	const abs = resolvePath(file);
	let st;
	try {
		st = await stat(abs);
	} catch (err: any) {
		return { error: `Failed to read ${file}: ${err?.message ?? err}` };
	}
	if (st.isDirectory()) {
		const names = (await readdir(abs)).filter((n) => /\.html?$/i.test(n));
		names.sort((a, b) => {
			if (a.toLowerCase() === "index.html") return -1;
			if (b.toLowerCase() === "index.html") return 1;
			return a.localeCompare(b);
		});
		if (names.length === 0) return { error: `No HTML files in ${abs}` };
		const screens = [];
		for (const name of names) {
			const id = slugifyScreenId(name);
			if (!id) continue;
			const html = (await readFile(join(abs, name), "utf-8")).replace(
				/\r\n/g,
				"\n",
			);
			screens.push({ id, html });
		}
		if (screens.length === 0) return { error: `No valid screen ids in ${abs}` };
		return { screens, source: abs };
	}
	const html = (await readFile(abs, "utf-8")).replace(/\r\n/g, "\n");
	if (!html.trim()) return { error: `Empty HTML file ${file}` };
	return { html, source: abs };
}

function warnMockupPathsInRepo(paths: string[]): void {
	let root: string;
	try {
		root = getRepoRoot();
	} catch {
		return;
	}
	const storage = getProjectStorageDir();
	const rootPrefix = root.endsWith("/") ? root : `${root}/`;
	const storagePrefix = storage.endsWith("/") ? storage : `${storage}/`;
	for (const raw of paths) {
		const abs = resolvePath(raw);
		if (abs === storage || abs.startsWith(storagePrefix)) continue;
		if (abs === root || abs.startsWith(rootPrefix)) {
			console.error(
				`Warning: ${abs} is inside the consumer repo. Never write diffing mockups into the working tree. Submit HTML via stdin or MCP submit_mockup({ html }), or stage files under ${storage}/mockup-sources/.`,
			);
		}
	}
}

function printMockupHints(payload: unknown): void {
	if (!payload || typeof payload !== "object") return;
	const hints = (payload as { hints?: MockupStateHint[] }).hints;
	if (!hints?.length) return;
	const text = formatSubmitHints(hints).trim();
	if (text) console.error(text);
}

async function mockupSubmit(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			title: { type: "string" },
			source: { type: "string", short: "s" },
			model: { type: "string", short: "m" },
			id: { type: "string" },
			wait: { type: "boolean", short: "w" },
			timeout: { type: "string", short: "t" },
			screen: { type: "string", multiple: true },
			mode: { type: "string" },
			system: { type: "string" },
			"plan-id": { type: "string" },
		},
		allowPositionals: true,
	});
	const localPaths = [
		...(positionals[0] && positionals[0] !== "-" ? [positionals[0]] : []),
		...(values.screen ?? [])
			.map((flag) => {
				const eq = flag.indexOf("=");
				return eq > 0 ? flag.slice(eq + 1) : "";
			})
			.filter(Boolean),
	];
	warnMockupPathsInRepo(localPaths);
	const parsed = await screensFromCli(positionals[0], values.screen);
	if (parsed.error) {
		console.error(parsed.error);
		return EXIT_USAGE;
	}
	const title =
		values.title ||
		(positionals[0] && positionals[0] !== "-"
			? basename(positionals[0]).replace(/\.html?$/i, "")
			: "Untitled mockup");
	const base = baseUrl();
	let sinceRound = 0;
	if (values.wait) {
		const statusRes = await tryApiFetch(`${base}/api/mockup-review/status`);
		if (statusRes?.ok) {
			const status = (await statusRes.json()) as { round?: number };
			sinceRound = status.round ?? 0;
		}
	}
	const submitRes = await tryApiFetch(`${base}/api/mockups`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			id: values.id,
			title,
			html: parsed.html,
			screens: parsed.screens,
			source: values.source || parsed.source,
			model: values.model,
			mode: values.mode,
			designSystemId: values.system,
			planId: values["plan-id"],
		}),
	});
	if (!submitRes) return EXIT_NO_SERVER;
	if (!submitRes.ok) {
		const err = (await submitRes
			.json()
			.catch(() => ({ error: `HTTP ${submitRes.status}` }))) as {
			error?: string;
		};
		console.error(
			`Failed to submit mockup: ${err.error ?? `HTTP ${submitRes.status}`}`,
		);
		return 1;
	}
	const mockup = (await submitRes.json()) as Mockup;
	console.error(
		`Submitted mockup ${mockup.id} (v${mockup.version}) — review at ${appendSessionToken(`${base}/mockup/${mockup.id}`, activeAuthToken)}`,
	);
	if (mockup.sourcePath) console.error(`Source path: ${mockup.sourcePath}`);
	printMockupHints(mockup);
	if (!values.wait) {
		console.error(CLI_MOCKUP_SUBMIT_PARK_HINT);
		process.stdout.write(mockup.id + "\n");
		return EXIT_OK;
	}
	const timeoutSeconds = parseTimeoutSeconds(
		values.timeout as string | undefined,
	);
	if (timeoutSeconds === null) return EXIT_USAGE;
	return pollMockupDecision(base, timeoutSeconds * 1000, sinceRound);
}

async function mockupAwait(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { timeout: { type: "string", short: "t" } },
		allowPositionals: false,
	});
	const timeoutSeconds = parseTimeoutSeconds(
		values.timeout as string | undefined,
	);
	if (timeoutSeconds === null) return EXIT_USAGE;
	return pollMockupDecision(baseUrl(), timeoutSeconds * 1000);
}

async function mockupList(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { json: { type: "boolean" } },
		allowPositionals: false,
	});
	const res = await tryApiFetch(`${baseUrl()}/api/mockups`);
	if (!res) return EXIT_NO_SERVER;
	if (!res.ok) {
		console.error(`Failed to list mockups: HTTP ${res.status}`);
		return 1;
	}
	const all: Mockup[] = await res.json();
	if (values.json) {
		process.stdout.write(JSON.stringify(all, null, 2) + "\n");
		return EXIT_OK;
	}
	if (all.length === 0) {
		console.error("No mockups submitted yet.");
		return EXIT_OK;
	}
	for (const m of all) {
		const open = (m.comments ?? []).filter((c) => c.status === "open").length;
		process.stdout.write(
			`${m.id}\t[${m.decision}]\tv${m.version}\t${m.screens.length} screen(s)\t${open} open\t${m.title}\n`,
		);
	}
	return EXIT_OK;
}

async function mockupShow(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { json: { type: "boolean" }, version: { type: "string" } },
		allowPositionals: true,
	});
	const base = baseUrl();
	let mockupId = positionals[0];
	if (!mockupId) {
		const listRes = await tryApiFetch(`${base}/api/mockups`);
		if (!listRes) return EXIT_NO_SERVER;
		const all: Mockup[] = listRes.ok ? await listRes.json() : [];
		if (all.length === 0) {
			console.error("No mockups submitted yet.");
			return EXIT_NOT_FOUND;
		}
		mockupId = all[all.length - 1].id;
	}
	const res = await tryApiFetch(`${base}/api/mockups/${mockupId}`);
	if (!res) return EXIT_NO_SERVER;
	if (res.status === 404) {
		console.error(`Mockup ${mockupId} not found.`);
		return EXIT_NOT_FOUND;
	}
	if (!res.ok) {
		console.error(`Failed to load mockup: HTTP ${res.status}`);
		return 1;
	}
	const mockup = (await res.json()) as Mockup;
	const requestedVersion =
		values.version === undefined ? undefined : Number(values.version);
	if (
		requestedVersion !== undefined &&
		(!Number.isFinite(requestedVersion) || requestedVersion < 1)
	) {
		console.error(`--version must be a positive integer.`);
		return EXIT_USAGE;
	}
	if (values.json) {
		process.stdout.write(JSON.stringify(mockup, null, 2) + "\n");
	} else {
		process.stdout.write(
			formatMockupReview(mockup, { viewingVersion: requestedVersion }) + "\n",
		);
	}
	return EXIT_OK;
}

async function mockupVersions(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { json: { type: "boolean" } },
		allowPositionals: true,
	});
	const id = positionals[0];
	if (!id) {
		console.error("Usage: diffing mockup versions <id>");
		return EXIT_USAGE;
	}
	const res = await tryApiFetch(`${baseUrl()}/api/mockups/${id}/versions`);
	if (!res) return EXIT_NO_SERVER;
	if (res.status === 404) {
		console.error(`Mockup ${id} not found.`);
		return EXIT_NOT_FOUND;
	}
	if (!res.ok) {
		console.error(`Failed to list versions: HTTP ${res.status}`);
		return 1;
	}
	const versions = await res.json();
	if (values.json) {
		process.stdout.write(JSON.stringify(versions, null, 2) + "\n");
		return EXIT_OK;
	}
	for (const v of versions as { version: number; title: string }[]) {
		process.stdout.write(`v${v.version}\t${v.title}\n`);
	}
	return EXIT_OK;
}

async function mockupReply(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			body: { type: "string", short: "b" },
			model: { type: "string", short: "m" },
		},
		allowPositionals: true,
	});
	const commentId = positionals[0];
	if (!commentId) {
		console.error('Usage: diffing mockup reply <comment-id> --body "..."');
		return EXIT_USAGE;
	}
	let body = values.body;
	if (!body) body = await readStdin();
	if (!body?.trim()) {
		console.error("A reply body is required (--body or stdin).");
		return EXIT_USAGE;
	}
	const listRes = await tryApiFetch(`${baseUrl()}/api/mockups?include=comments`);
	if (!listRes) return EXIT_NO_SERVER;
	const all: Mockup[] = listRes.ok ? await listRes.json() : [];
	const mockup = all.find((m) =>
		(m.comments ?? []).some((c) => c.id === commentId),
	);
	if (!mockup) {
		console.error(`Comment ${commentId} not found.`);
		return EXIT_NOT_FOUND;
	}
	const res = await tryApiFetch(
		`${baseUrl()}/api/mockups/${mockup.id}/comments/${commentId}/replies`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body, model: values.model, role: "agent" }),
		},
	);
	if (!res) return EXIT_NO_SERVER;
	if (!res.ok) {
		console.error(`Failed to reply: HTTP ${res.status}`);
		return 1;
	}
	return EXIT_OK;
}

async function mockupResolve(args: string[]): Promise<number> {
	const { positionals } = parseArgs({ args, allowPositionals: true });
	const commentId = positionals[0];
	if (!commentId) {
		console.error("Usage: diffing mockup resolve <comment-id>");
		return EXIT_USAGE;
	}
	const listRes = await tryApiFetch(`${baseUrl()}/api/mockups?include=comments`);
	if (!listRes) return EXIT_NO_SERVER;
	const all: Mockup[] = listRes.ok ? await listRes.json() : [];
	const mockup = all.find((m) =>
		(m.comments ?? []).some((c) => c.id === commentId),
	);
	if (!mockup) {
		console.error(`Comment ${commentId} not found.`);
		return EXIT_NOT_FOUND;
	}
	const res = await tryApiFetch(
		`${baseUrl()}/api/mockups/${mockup.id}/comments/${commentId}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "resolved" }),
		},
	);
	if (!res) return EXIT_NO_SERVER;
	if (!res.ok) {
		console.error(`Failed to resolve: HTTP ${res.status}`);
		return 1;
	}
	return EXIT_OK;
}

async function findMockupForCommentId(
	commentId: string,
): Promise<{ mockup: Mockup } | { exit: number }> {
	const listRes = await tryApiFetch(`${baseUrl()}/api/mockups?include=comments`);
	if (!listRes) return { exit: EXIT_NO_SERVER };
	const all: Mockup[] = listRes.ok ? await listRes.json() : [];
	const mockup = all.find((m) =>
		(m.comments ?? []).some((c) => c.id === commentId),
	);
	if (!mockup) {
		console.error(`Comment ${commentId} not found.`);
		return { exit: EXIT_NOT_FOUND };
	}
	return { mockup };
}

async function mockupUnresolve(args: string[]): Promise<number> {
	const { positionals } = parseArgs({ args, allowPositionals: true });
	const commentId = positionals[0];
	if (!commentId) {
		console.error("Usage: diffing mockup unresolve <comment-id>");
		return EXIT_USAGE;
	}
	const found = await findMockupForCommentId(commentId);
	if ("exit" in found) return found.exit;
	const res = await tryApiFetch(
		`${baseUrl()}/api/mockups/${found.mockup.id}/comments/${commentId}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "open" }),
		},
	);
	if (!res) return EXIT_NO_SERVER;
	if (!res.ok) {
		console.error(`Failed to unresolve: HTTP ${res.status}`);
		return 1;
	}
	return EXIT_OK;
}

async function mockupApplySuggestion(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { "expected-version": { type: "string" } },
		allowPositionals: true,
	});
	const commentId = positionals[0];
	if (!commentId) {
		console.error(
			"Usage: diffing mockup apply-suggestion <comment-id> [--expected-version N]",
		);
		return EXIT_USAGE;
	}
	const found = await findMockupForCommentId(commentId);
	if ("exit" in found) return found.exit;
	const expectedVersion =
		values["expected-version"] === undefined
			? undefined
			: Number(values["expected-version"]);
	if (expectedVersion !== undefined && !Number.isFinite(expectedVersion)) {
		console.error("--expected-version must be a number");
		return EXIT_USAGE;
	}
	const res = await tryApiFetch(
		`${baseUrl()}/api/mockups/${found.mockup.id}/comments/${commentId}/apply-suggestion`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				expectedVersion === undefined ? {} : { expectedVersion },
			),
		},
	);
	if (!res) return EXIT_NO_SERVER;
	if (!res.ok) {
		console.error(await mockupOpErrorMessage(res));
		return res.status === 409 ? 1 : EXIT_USAGE;
	}
	return EXIT_OK;
}

async function latestMockupId(base: string): Promise<string | null> {
	const listRes = await tryApiFetch(`${base}/api/mockups`);
	if (!listRes || !listRes.ok) return null;
	const all: Mockup[] = await listRes.json();
	if (all.length === 0) return null;
	return all[all.length - 1].id;
}

async function mockupOpErrorMessage(res: Response): Promise<string> {
	const body = (await res.json().catch(() => ({}))) as {
		error?: string;
		code?: string;
		currentVersion?: number;
		expectedVersion?: number;
	};
	if (body.code === "version-mismatch") {
		return `Mockup version mismatch: current v${body.currentVersion}, expected v${body.expectedVersion}. Retry with --expected-version ${body.currentVersion}.`;
	}
	return body.error ?? `HTTP ${res.status}`;
}

async function mockupInspect(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			status: { type: "string" },
			screen: { type: "string" },
			viewport: { type: "string" },
			version: { type: "string" },
			id: { type: "string" },
			cursor: { type: "string" },
			limit: { type: "string" },
			context: { type: "string" },
			pretty: { type: "boolean" },
		},
		allowPositionals: true,
	});
	const [view, mockupArg, ...extra] = positionals;
	if (
		!view ||
		!["summary", "comments", "comment", "screen", "preview"].includes(view) ||
		extra.length > 0
	) {
		console.error(`Usage: diffing mockup inspect <summary|comments|comment|screen|preview> [mockup-id] [options]

Read bounded mockup data as compact JSON (add --pretty for indented output).
  summary  [mockup-id]                          — headline stats + screen list
  comments [mockup-id] [--status open|resolved] [--screen S] [--viewport desktop|tablet|mobile] [--version N] [--cursor N] [--limit N] [--context none|anchor|source]
  comment  [mockup-id] --id <comment-id> [--context none|anchor|source]
  screen   [mockup-id] [--cursor N] [--limit N]

context: none = metadata only; anchor = + locator fields (default); source = + contextHtml.`);
		return EXIT_USAGE;
	}
	const base = baseUrl();
	let mockupId = mockupArg;
	if (!mockupId) {
		mockupId = (await latestMockupId(base)) ?? "";
		if (!mockupId) {
			console.error("No mockups submitted yet.");
			return EXIT_NOT_FOUND;
		}
	}
	const params = new URLSearchParams();
	params.set("view", view);
	const numeric = (flag: keyof typeof values, name: string): boolean => {
		const value = values[flag];
		if (typeof value !== "string") return true;
		if (!/^\d+$/.test(value)) {
			console.error(`--${name} must be a non-negative integer`);
			return false;
		}
		params.set(name, value);
		return true;
	};
	if (!numeric("cursor", "cursor")) return EXIT_USAGE;
	if (!numeric("limit", "limit")) return EXIT_USAGE;
	if (!numeric("version", "version")) return EXIT_USAGE;
	const str = (flag: keyof typeof values, name: string) => {
		const value = values[flag];
		if (typeof value === "string") params.set(name, value);
	};
	str("status", "status");
	str("screen", "screen");
	str("viewport", "viewport");
	str("id", "id");
	str("context", "context");
	const res = await tryApiFetch(
		`${base}/api/mockups/${encodeURIComponent(mockupId)}/inspect?${params.toString()}`,
	);
	if (!res) return EXIT_NO_SERVER;
	if (res.status === 404) {
		console.error(`Mockup ${mockupId} not found.`);
		return EXIT_NOT_FOUND;
	}
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { error?: string };
		console.error(err.error ?? `HTTP ${res.status}`);
		return 1;
	}
	const data = await res.json();
	process.stdout.write(
		JSON.stringify(data, null, values.pretty ? 2 : undefined) + "\n",
	);
	return EXIT_OK;
}

async function mockupScreenCmd(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			file: { type: "string" },
			text: { type: "string" },
			replacement: { type: "string" },
			region: { type: "string" },
			label: { type: "string" },
			"expected-version": { type: "string" },
		},
		allowPositionals: true,
	});
	const [action, mockupId, screenId, ...extra] = positionals;
	if (
		!action ||
		!["upsert", "remove", "patch", "replace-region"].includes(action) ||
		!mockupId ||
		!screenId ||
		extra.length > 0
	) {
		console.error(`Usage: diffing mockup screen <upsert|remove|patch|replace-region> <mockup-id> <screen-id> [options]

One-screen revision. Version bumps on success; an --expected-version guard aborts with
409 (no change) when the mockup moved on.
  upsert         <id> <screen-id> --file <path> [--label L] [--expected-version N]   # --file - = stdin
  remove         <id> <screen-id> [--expected-version N]
  patch          <id> <screen-id> --text <exact-text> --replacement <new-text> [--expected-version N]
  replace-region <id> <screen-id> --region <data-diffing> --replacement <inner-html> [--expected-version N]`);
		return EXIT_USAGE;
	}
	let expectedVersion: number | undefined;
	if (values["expected-version"] !== undefined) {
		if (!/^\d+$/.test(values["expected-version"])) {
			console.error("--expected-version must be a positive integer");
			return EXIT_USAGE;
		}
		expectedVersion = Number(values["expected-version"]);
	}
	const base = baseUrl();

	if (action === "upsert") {
		let html: string;
		const file = values.file;
		if (!file || file === "-") {
			html = (await readStdin()).replace(/\r\n/g, "\n");
		} else {
			try {
				html = (await readFile(resolvePath(file), "utf-8")).replace(/\r\n/g, "\n");
			} catch (err: any) {
				console.error(`Failed to read ${file}: ${err?.message ?? err}`);
				return EXIT_USAGE;
			}
		}
		if (!html.trim()) {
			console.error("Screen html is required (--file <path> or stdin).");
			return EXIT_USAGE;
		}
		const res = await tryApiFetch(
			`${base}/api/mockups/${encodeURIComponent(mockupId)}/screens/${encodeURIComponent(screenId)}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					html,
					label: values.label,
					expectedVersion,
				}),
			},
		);
		if (!res) return EXIT_NO_SERVER;
		if (!res.ok) {
			console.error(await mockupOpErrorMessage(res));
			return res.status === 404 ? EXIT_NOT_FOUND : 1;
		}
		const mockup = (await res.json()) as Mockup;
		console.error(
			`Upserted screen ${screenId} on ${mockupId} → v${mockup.version} (${mockup.screens.length} screens).`,
		);
		printMockupHints(mockup);
		return EXIT_OK;
	}

	if (action === "remove") {
		const qs =
			expectedVersion === undefined ? "" : `?expectedVersion=${expectedVersion}`;
		const res = await tryApiFetch(
			`${base}/api/mockups/${encodeURIComponent(mockupId)}/screens/${encodeURIComponent(screenId)}${qs}`,
			{ method: "DELETE" },
		);
		if (!res) return EXIT_NO_SERVER;
		if (!res.ok) {
			console.error(await mockupOpErrorMessage(res));
			return res.status === 404 ? EXIT_NOT_FOUND : 1;
		}
		const mockup = (await res.json()) as Mockup;
		console.error(
			`Removed screen ${screenId} from ${mockupId} → v${mockup.version}.`,
		);
		return EXIT_OK;
	}

	if (action === "replace-region") {
		const region = values.region?.trim();
		const replacement = values.replacement;
		if (!region || replacement === undefined) {
			console.error(
				"replace-region requires --region <data-diffing> and --replacement <inner-html>",
			);
			return EXIT_USAGE;
		}
		const res = await tryApiFetch(
			`${base}/api/mockups/${encodeURIComponent(mockupId)}/screens/${encodeURIComponent(screenId)}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					region,
					replacement,
					expectedVersion,
				}),
			},
		);
		if (!res) return EXIT_NO_SERVER;
		if (!res.ok) {
			console.error(await mockupOpErrorMessage(res));
			return res.status === 404 ? EXIT_NOT_FOUND : 1;
		}
		const data = (await res.json()) as { mockup: Mockup; occurrences: number };
		console.error(
			`Replaced region "${region}" on ${screenId} (${data.occurrences} match(es)) → v${data.mockup.version}.`,
		);
		printMockupHints(data.mockup);
		return EXIT_OK;
	}

	// patch
	const text = values.text;
	const replacement = values.replacement;
	if (!text || replacement === undefined) {
		console.error(
			"patch requires --text <exact-text> and --replacement <new-text>",
		);
		return EXIT_USAGE;
	}
	const res = await tryApiFetch(
		`${base}/api/mockups/${encodeURIComponent(mockupId)}/screens/${encodeURIComponent(screenId)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				expectedText: text,
				replacement,
				expectedVersion,
			}),
		},
	);
	if (!res) return EXIT_NO_SERVER;
	if (!res.ok) {
		console.error(await mockupOpErrorMessage(res));
		return res.status === 404 ? EXIT_NOT_FOUND : 1;
	}
	const data = (await res.json()) as { mockup: Mockup; occurrences: number };
	console.error(
		`Patched ${screenId} on ${mockupId} (${data.occurrences} exact match(es)) → v${data.mockup.version}.`,
	);
	printMockupHints(data.mockup);
	return EXIT_OK;
}

async function mockupThreadsCmd(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			body: { type: "string", short: "b" },
			model: { type: "string", short: "m" },
			id: { type: "string" },
		},
		allowPositionals: true,
	});
	const [action, commentId, replyId, ...extra] = positionals;
	const valid =
		typeof action === "string" &&
		["reply", "edit", "delete", "resolve", "unresolve"].includes(action);
	if (!valid || !commentId || extra.length > 0) {
		console.error(`Usage: diffing mockup threads <reply|edit|delete|resolve|unresolve> ...

Atomic thread ops — each call is validated before apply through the batch endpoint.
  reply <comment-id> --body "..." [--model M] [--id mockup-id]
  edit <comment-id> [<reply-id>] --body "..."   # with reply-id: edit the reply; without: edit the comment body
  delete <comment-id> [<reply-id>]    # with reply-id: delete the reply; without: delete the comment
  resolve <comment-id>
  unresolve <comment-id>`);
		return EXIT_USAGE;
	}
	let body = values.body;
	if (action === "reply" || action === "edit") {
		if (body === undefined) {
			if (process.stdin.isTTY) {
				console.error(
					`threads ${action}: a body is required (--body <text> or stdin)`,
				);
				return EXIT_USAGE;
			}
			body = (await readStdin()).trim();
		} else if (body === "-") {
			body = (await readStdin()).trim();
		}
		if (!body?.trim()) {
			console.error(
				`threads ${action}: a body is required (--body <text> or stdin)`,
			);
			return EXIT_USAGE;
		}
	}
	const base = baseUrl();
	let mockupId = values.id as string | undefined;
	if (!mockupId) {
		const listRes = await tryApiFetch(`${base}/api/mockups?include=comments`);
		if (!listRes) return EXIT_NO_SERVER;
		const all: Mockup[] = listRes.ok ? await listRes.json() : [];
		const found = all.find((m) =>
			(m.comments ?? []).some((c) => c.id === commentId),
		);
		if (!found) {
			console.error(`Comment ${commentId} not found.`);
			return EXIT_NOT_FOUND;
		}
		mockupId = found.id;
	}
	const operations: Record<string, string | undefined>[] = [];
	if (action === "reply") {
		operations.push({
			op: action,
			commentId,
			body,
			role: "agent",
			model: values.model,
		});
	} else if (action === "edit") {
		operations.push(
			replyId
				? { op: action, commentId, replyId, body }
				: { op: action, commentId, body },
		);
	} else if (action === "delete") {
		operations.push(
			replyId ? { op: action, commentId, replyId } : { op: action, commentId },
		);
	} else {
		operations.push({ op: action, commentId });
	}
	const res = await tryApiFetch(
		`${base}/api/mockups/${encodeURIComponent(mockupId)}/threads/batch`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ operations }),
		},
	);
	if (!res) return EXIT_NO_SERVER;
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { error?: string };
		console.error(err.error ?? `HTTP ${res.status}`);
		return res.status === 404 ? EXIT_NOT_FOUND : 1;
	}
	const data = (await res.json()) as {
		results: { replyId?: string }[];
	};
	const newReplyId = data.results[0]?.replyId;
	if (action === "reply") {
		console.error(
			`Replied to ${commentId}${newReplyId ? ` (${newReplyId})` : ""}.`,
		);
	} else if (action === "edit") {
		console.error(
			replyId ? `Edited reply ${replyId}.` : `Edited comment ${commentId}.`,
		);
	} else if (action === "delete") {
		console.error(
			replyId ? `Deleted reply ${replyId}.` : `Deleted comment ${commentId}.`,
		);
	} else if (action === "resolve") {
		console.error(`Resolved ${commentId}.`);
	} else {
		console.error(`Re-opened ${commentId}.`);
	}
	return EXIT_OK;
}

async function mockupHandoff(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { json: { type: "boolean" } },
		allowPositionals: true,
	});
	const base = baseUrl();
	let id = positionals[0];
	if (!id) {
		id = (await latestMockupId(base)) ?? "";
		if (!id) {
			console.error("No mockups submitted yet.");
			return EXIT_NOT_FOUND;
		}
	}
	const res = await tryApiFetch(
		`${base}/api/mockups/${encodeURIComponent(id)}/handoff`,
	);
	if (!res) return EXIT_NO_SERVER;
	if (res.status === 404) {
		console.error(`Mockup ${id} not found.`);
		return EXIT_NOT_FOUND;
	}
	const data = await res.json();
	if (values.json) {
		process.stdout.write(JSON.stringify(data, null, 2) + "\n");
		return EXIT_OK;
	}
	process.stdout.write((data.xml ?? JSON.stringify(data, null, 2)) + "\n");
	return EXIT_OK;
}

async function mockupCommand(args: string[]): Promise<number> {
	const action = args[0];
	const rest = args.slice(1);
	if (args.includes("--help") || args.includes("-h") || !action) {
		console.log(`Usage: diffing mockup <submit|await|list|show|versions|reply|resolve|unresolve|apply-suggestion|inspect|screen|threads|handoff> [options]

Submit HTML mockups for visual review. Same loop as plan review.
Never write mockup HTML into the consumer git tree. Prefer stdin or MCP inline html.
Staging files, if needed, go under ~/.diffing/<repo>-<hash>/mockup-sources/ only.
Ask AI in the mockup UI is opt-in (rail closed). --model on submit/reply is provenance only.
One state per screen: never tabs/accordions/toggles/modals/JS content-swapping — each variant is a separate screen.

  submit [-] [--title T] [--screen id=path]... [--id ID] [--model M] [--wait]
         [--mode fragment|document] [--system ID] [--plan-id ID]
         # or a path already under ~/.diffing/.../mockup-sources/
  await [--timeout N]
  list [--json]
  show [<id>] [--json] [--version N]
  versions <id> [--json]
  reply <comment-id> --body "..." [--model M]
  resolve <comment-id>
  unresolve <comment-id>
  apply-suggestion <comment-id> [--expected-version N]
  inspect <summary|comments|comment|screen|preview> [<id>] [--status S] [--screen S] [--viewport V] [--version N] [--id C] [--cursor N] [--limit N] [--context none|anchor|source] [--pretty]
  handoff [<id>] [--json]
  screen <upsert|remove|patch|replace-region> <id> <screen-id> [--file P] [--text T] [--region R] [--replacement R] [--expected-version N]
  threads <reply|edit|delete|resolve|unresolve> <comment-id> [<reply-id>] [--body "..."] [--model M] [--id mockup-id]
`);
		return EXIT_OK;
	}
	switch (action) {
		case "submit":
			return mockupSubmit(rest);
		case "await":
			return mockupAwait(rest);
		case "list":
			return mockupList(rest);
		case "show":
			return mockupShow(rest);
		case "versions":
			return mockupVersions(rest);
		case "reply":
			return mockupReply(rest);
		case "resolve":
			return mockupResolve(rest);
		case "unresolve":
			return mockupUnresolve(rest);
		case "apply-suggestion":
			return mockupApplySuggestion(rest);
		case "inspect":
			return mockupInspect(rest);
		case "screen":
			return mockupScreenCmd(rest);
		case "threads":
			return mockupThreadsCmd(rest);
		case "handoff":
			return mockupHandoff(rest);
		default:
			console.error(`Unknown mockup action: ${action}`);
			return EXIT_USAGE;
	}
}

async function designCommand(args: string[]): Promise<number> {
	const action = args[0];
	const rest = args.slice(1);
	if (!action || args.includes("--help") || args.includes("-h")) {
		console.log(`Usage: diffing design <show|list|extract|propose|publish> [id] [options]

Per-repo design system stored under ~/.diffing/<repo>-<hash>/. Agents read this before
authoring mockups. Extract is a draft; publish is a human action.

  show [id] [--json]
  list [--json]
  extract [id] [--from css|text] [--title T]
  propose [id] --guidelines "…" [--title T]
  publish [id]
`);
		return EXIT_OK;
	}
	const { values, positionals } = parseArgs({
		args: rest,
		options: {
			json: { type: "boolean" },
			from: { type: "string" },
			title: { type: "string" },
			guidelines: { type: "string" },
		},
		allowPositionals: true,
	});
	const id = positionals[0] || "default";
	const base = baseUrl();
	if (action === "list") {
		const res = await tryApiFetch(`${base}/api/design-systems`);
		if (!res) return EXIT_NO_SERVER;
		const all = await res.json();
		if (values.json) {
			process.stdout.write(JSON.stringify(all, null, 2) + "\n");
			return EXIT_OK;
		}
		if (!Array.isArray(all) || all.length === 0) {
			console.error("No design system yet. Run: diffing design extract");
			return EXIT_OK;
		}
		for (const s of all) {
			console.log(
				`${s.id}  ${s.title}  v${s.revision}  ${s.status}  ${s.components?.length ?? 0} components`,
			);
		}
		return EXIT_OK;
	}
	if (action === "show") {
		const res = await tryApiFetch(
			`${base}/api/design-systems/${encodeURIComponent(id)}`,
		);
		if (!res) return EXIT_NO_SERVER;
		if (res.status === 404) {
			console.error(`Design system ${id} not found.`);
			return EXIT_NOT_FOUND;
		}
		const system = await res.json();
		process.stdout.write(
			JSON.stringify(system, null, values.json ? 2 : 2) + "\n",
		);
		return EXIT_OK;
	}
	if (action === "extract") {
		const res = await tryApiFetch(
			`${base}/api/design-systems/${encodeURIComponent(id)}/extract`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					from: values.from ?? "css",
					title: values.title,
				}),
			},
		);
		if (!res) return EXIT_NO_SERVER;
		if (!res.ok) {
			console.error(`Extract failed: HTTP ${res.status}`);
			return 1;
		}
		const data = await res.json();
		console.error(
			`Draft design system ${data.system.id} from ${data.extract?.files?.length ?? 0} file(s). Publish with: diffing design publish ${id}`,
		);
		if (values.json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
		return EXIT_OK;
	}
	if (action === "propose") {
		const res = await tryApiFetch(
			`${base}/api/design-systems/${encodeURIComponent(id)}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: values.title,
					guidelines: values.guidelines,
				}),
			},
		);
		if (!res) return EXIT_NO_SERVER;
		if (res.status === 404) {
			console.error(`Design system ${id} not found.`);
			return EXIT_NOT_FOUND;
		}
		console.error(
			`Proposed draft on ${id}. Publish with: diffing design publish ${id}`,
		);
		return EXIT_OK;
	}
	if (action === "publish") {
		const res = await tryApiFetch(
			`${base}/api/design-systems/${encodeURIComponent(id)}/publish`,
			{ method: "POST" },
		);
		if (!res) return EXIT_NO_SERVER;
		if (res.status === 404) {
			console.error(`Design system ${id} not found.`);
			return EXIT_NOT_FOUND;
		}
		const system = await res.json();
		console.error(`Published ${system.id} revision ${system.revision}.`);
		return EXIT_OK;
	}
	console.error(`Unknown design action: ${action}`);
	return EXIT_USAGE;
}

export async function runSubcommand(
	name: string,
	args: string[],
): Promise<number> {
	switch (name) {
		case "await-review":
			return awaitReview(args);
		case "reply":
			return reply(args);
		case "resolve":
			return resolve(args);
		case "unresolve":
			return unresolve(args);
		case "comment":
			return commentCmd(args);
		case "comments":
			return comments(args);
		case "url":
			return url();
		case "plan":
			return plan(args);
		case "mockup":
			return mockupCommand(args);
		case "design":
			return designCommand(args);
		case "update": {
			const { runUpdateCommand } = await import("./lib/update-check.js");
			return runUpdateCommand();
		}
		case "gh": {
			const { runGhSubcommand } = await import("./cli-gh.js");
			return runGhSubcommand(args);
		}
		case "doctor":
			return doctor();
		case "setup":
			return setup(args);
		case "completion":
			return completion(args);
		case "progress":
			return progress(args);
		case "inspect":
			return inspect(args);
		case "evidence":
			return evidence(args);
		case "mode":
			return mode(args);
		case "sessions": {
			const { runSessionsCommand } = await import("./lib/session-manager.js");
			return runSessionsCommand(args);
		}
		default:
			console.error(`Unknown subcommand: ${name}`);
			return EXIT_USAGE;
	}
}
