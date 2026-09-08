import { readFile, mkdir, readdir, stat, rm } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { watch, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { NativeFsError, getNativeRepositoryFs } from "./lib/native-fs.js";
import {
	saveFileSchema,
	editSaveSchema,
	MAX_FILE_REQUEST_BYTES,
} from "./lib/file-schema.js";
import { serve } from "@hono/node-server";
import {
	getFileContent,
	getRepoRoot,
	getProjectStorageDir,
	getMergeStatus,
	gitAddFile,
	listRepoFiles,
	revertHunk,
	getHunkHistory,
} from "./lib/git.js";
import {
	searchFiles,
	searchContent,
	searchSymbols,
	searchAll,
	getSearchStatus,
	trackSelection,
} from "./lib/search.js";
import { loadSettings, saveSettings } from "./lib/settings.js";
import { FileCommentStore } from "./lib/comments.js";
import type { CommentStore } from "./lib/comments.js";
import {
	createReviewCommentSchema,
	updateReviewCommentSchema,
	createCommentReplySchema,
	editCommentReplySchema,
	commentValidationError,
	MAX_COMMENT_REQUEST_BYTES,
} from "./lib/comment-schema.js";
import { isReviewCommentSide } from "./lib/types.js";
import type { ReviewComment, ReviewDecision, ReviewMode } from "./lib/types.js";
import { FilePlanStore } from "./lib/plans.js";
import type { PlanStore } from "./lib/plans.js";
import { FileMockupStore, screensFromSubmitBody } from "./lib/mockups.js";
import {
	normalizeThreadOperations,
	type MockupScreenOpResult,
} from "./lib/mockups.js";
import type { MockupStore } from "./lib/mockups.js";
import { MockupReviewSession } from "./lib/mockup-review-session.js";
import { formatMockupReview } from "./lib/mockup-format.js";
import { injectMockupProbe } from "./lib/mockup-document.js";
import { lintMockupScreens } from "./lib/mockup-lint.js";
import {
	FileDesignSystemStore,
	type DesignSystemStore,
} from "./lib/design-system.js";
import {
	DEFAULT_DESIGN_SYSTEM_ID,
	type DesignSystem,
} from "./lib/design-system-types.js";
import {
	extractFromRepo,
	extractTokensFromText,
} from "./lib/design-system-extract.js";
import { renderMockupHtml, resolveRenderMode } from "./lib/mockup-shell.js";
import { renderMockupPreview } from "./lib/mockup-preview.js";
import {
	buildMockupHandoff,
	formatMockupHandoffXml,
} from "./lib/mockup-handoff.js";
import { extractSuggestion } from "./lib/mockup-suggestion.js";
import {
	normalizeMockupViewport,
	isMockupViewport,
	commentViewport,
	MOCKUP_SCREEN_ID_RE,
	MOCKUP_MAX_SCREEN_BYTES,
	type MockupDecision,
	type MockupMode,
	type MockupAnchorKind,
	type MockupComment,
	type MockupViewport,
	type Mockup,
	type MockupSummary,
	type MockupRenderMode,
	type MockupTheme,
} from "./lib/mockup-types.js";
import { FileUiStateStore } from "./lib/state.js";
import {
	isSafePath,
	toSafeRelativePath,
	toSafeLiteralRelativePath,
} from "./lib/path.js";
import {
	resolveEditorCommand,
	type EditorChoice,
} from "./lib/editor-launcher.js";
import { ReviewSession } from "./lib/review-session.js";
import { PlanReviewSession } from "./lib/plan-review-session.js";
import { formatComments } from "./lib/comment-format.js";
import { scanReviewForSecrets } from "./lib/secrets-scan.js";
import {
	formatPlanReview,
	sectionTitleForLine,
	extractPlanLines,
} from "./lib/plan-format.js";
import type { PlanDecision, PlanMode } from "./lib/plan-types.js";
import { executeDiffWithMeta } from "./lib/diff-engine.js";
import type { DiffOptions } from "./lib/diff-options.js";
import { DEFAULTS } from "./lib/diff-options.js";
import {
	buildSessionTokenSetCookieValue,
	createServerAuthMiddleware,
	injectSessionTokenIntoHtml,
	type ServerAuthConfig,
} from "./lib/server-auth.js";
import {
	FilePrSessionStore,
	findPendingReview,
	samePrIdentity,
} from "./lib/pr-session.js";
import type {
	PrSessionStore,
	PrDecision,
	PrExistingReview,
	PrSession,
	PrExistingComment,
	PrExistingReply,
} from "./lib/pr-session.js";
import { buildPrOverview } from "./lib/diff-overview.js";
import {
	AgentDiffIndexCache,
	indexSummary,
	indexFiles,
	indexHunks,
	indexSlice,
	indexSearch,
	resolveInspectFile,
} from "./lib/agent-diff-index.js";
import {
	formatPrReviewThreads,
	formatPrReviews,
	paginatePrThreads,
	paginatePrReviews,
	buildPrOverviewPayload,
} from "./lib/pr-agent-format.js";
import { paginatePrTimeline, mergeBlockedReason } from "./lib/pr-timeline.js";
import {
	FileViewedStore,
	fingerprintsForPatch,
	viewedScopeKey,
} from "./lib/viewed-files.js";
import {
	addCommentsToPendingReviewViaGh,
	applyPrSuggestionViaGh,
	fetchPrConversationViaGh,
	mergePullRequestViaGh,
	setPrOpenStateViaGh,
	updatePrMetadataViaGh,
} from "./lib/github-pr-actions.js";
import {
	buildPrSession,
	refreshPrSession,
	resolvedFromSession,
	submitReview as githubSubmitReview,
	fetchExistingCommentsViaGh,
	fetchExistingReviewsViaGh,
	submitPendingReviewViaGh,
	deletePendingReviewViaGh,
	updatePrReviewComment,
	deletePrReviewComment,
	setPrReviewThreadResolved,
	fetchPrFileContentViaGh,
	parsePrRef,
	detectCwdRepo,
	expandMultiLineComments,
	classifyPrComments,
	buildReviewPayload,
} from "./lib/github.js";
import { AiService, type AiPreparedRun } from "./lib/ai/service.js";
import { AiRunError } from "./lib/ai/lifecycle.js";
import { AiRequestError, readAiRunRequest } from "./lib/ai/request.js";
import { streamAiRun } from "./lib/ai/run-stream.js";
import { AiSnapshotError } from "./lib/ai/snapshots.js";
import { SnapshotStore } from "./lib/ai/snapshot-store.js";
import { LanguageServers } from "./lib/ai/language-servers.js";
import { lookupSymbols, type SymbolKind } from "./lib/ai/symbols.js";
import {
	diffRead,
	reviewMap,
	sourceRead,
	sourceSearch,
	type ReadRequest,
} from "./lib/ai/tools.js";
import { resolvePlanSnapshot } from "./lib/ai/plan-snapshot.js";
import { capturePrReview } from "./lib/ai/pr-snapshot.js";
import { captureLocalReview } from "./lib/ai/local-snapshot.js";
import { resolveDiffSnapshot } from "./lib/ai/diff-snapshot.js";
import { ByteLruCache } from "./lib/ai/cache.js";
import {
	FileAiConversationStore,
	type AiConversationStore,
	type AiConversationCreateInput,
	type AiConversationUpdateInput,
} from "./lib/ai/conversations.js";
import type {
	AiAttachment,
	AiCredentialRoute,
	AiImageAttachmentReference,
	AiResolvedImageAttachment,
	AiRunRequest,
	AiSourceId,
	AiSurface,
} from "./lib/ai/types.js";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".avif": "image/avif",
};

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_AI_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AI_IMAGE_COUNT = 4;
const AI_IMAGE_MIME_TO_EXTENSION = new Map([
	["image/png", ".png"],
	["image/jpeg", ".jpg"],
	["image/webp", ".webp"],
	["image/gif", ".gif"],
]);

function hasImageSignature(content: Uint8Array, mimeType: string): boolean {
	if (mimeType === "image/png")
		return (
			content.length >= 8 &&
			[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
				(byte, index) => content[index] === byte,
			)
		);
	if (mimeType === "image/jpeg")
		return (
			content.length >= 3 &&
			content[0] === 0xff &&
			content[1] === 0xd8 &&
			content[2] === 0xff
		);
	if (mimeType === "image/gif")
		return (
			content.length >= 6 &&
			["GIF87a", "GIF89a"].includes(
				Buffer.from(content.subarray(0, 6)).toString("ascii"),
			)
		);
	if (mimeType === "image/webp")
		return (
			content.length >= 12 &&
			Buffer.from(content.subarray(0, 4)).toString("ascii") === "RIFF" &&
			Buffer.from(content.subarray(8, 12)).toString("ascii") === "WEBP"
		);
	return false;
}

function collectPrAvatarUrls(session: PrSession): Set<string> {
	const urls = new Set<string>();
	const add = (avatarUrl?: string) => {
		if (avatarUrl) urls.add(avatarUrl);
	};
	add(session.author?.avatarUrl);
	for (const review of session.existingReviews ?? [])
		add(review.author?.avatarUrl);
	for (const comment of session.existingComments) {
		add(comment.author?.avatarUrl);
		for (const reply of comment.replies) add(reply.author?.avatarUrl);
	}
	return urls;
}

function isCustomMode(opts: DiffOptions): boolean {
	return opts.revisions.length > 0 || opts.pathspecs.length > 0 || opts.showMode;
}

/**
 * Compact comment serializer for bounded inspect views. `context` controls how
 * much anchor data is included: none → metadata only; anchor → locator fields
 * (target/selector/fingerprint/coords/html/snapshot); source → + contextHtml.
 */
function serializeMockupCommentSummary(
	comment: MockupComment,
	context: "none" | "anchor" | "source",
	opts: { truncateBody?: number } = {},
): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: comment.id,
		screenId: comment.screenId,
		viewport: commentViewport(comment),
		kind: comment.kind,
		status: comment.status,
		createdAt: comment.createdAt,
		createdAtMockupVersion: comment.createdAtMockupVersion,
	};
	const body =
		opts.truncateBody && comment.body.length > opts.truncateBody
			? comment.body.slice(0, opts.truncateBody) + "\u2026"
			: comment.body;
	out.body = body;
	if (comment.severity && comment.severity !== "none") {
		out.severity = comment.severity;
	}
	if (comment.threadKind) out.threadKind = comment.threadKind;
	if (context === "none") return out;
	if (comment.target) out.target = comment.target;
	if (comment.selector) out.selector = comment.selector;
	if (comment.fingerprint) out.fingerprint = comment.fingerprint;
	if (comment.x !== undefined) out.x = comment.x;
	if (comment.y !== undefined) out.y = comment.y;
	if (comment.sectionX !== undefined) out.sectionX = comment.sectionX;
	if (comment.sectionY !== undefined) out.sectionY = comment.sectionY;
	if (comment.html) out.html = comment.html;
	if (comment.snapshot) out.snapshot = comment.snapshot;
	out.replies = (comment.replies ?? []).map((r) => ({
		id: r.id,
		body: r.body,
		createdAt: r.createdAt,
		role: r.role,
		model: r.model,
	}));
	if (context === "anchor") return out;
	if (comment.contextHtml) out.contextHtml = comment.contextHtml;
	return out;
}

async function readCommentJson(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		// Stream/body-limit failures must reach their middleware, not become
		// ordinary malformed-payload responses.
		throw error;
	}
}

export function createApp(
	clientDir: string,
	diffOptsInput: DiffOptions = DEFAULTS,
	commentStore?: CommentStore,
	planStore?: PlanStore,
	prSessionStore?: PrSessionStore,
	prMode = false,
	security: ServerAuthConfig = {
		bindHost: "127.0.0.1",
		authToken: null,
		insecureNoAuth: true,
	},
	mockupStore?: MockupStore,
	designSystemStore?: DesignSystemStore,
	aiService?: AiService,
	aiConversationStore?: AiConversationStore,
) {
	const app = new Hono();
	app.onError((error, c) => {
		if (error instanceof NativeFsError) {
			return c.json(
				{
					error: error.message,
					code: error.code,
					outcomeUnknown: error.outcomeUnknown,
					...(error.code === "conflict" ? { conflict: true } : {}),
				},
				error.status,
			);
		}
		if (error instanceof HTTPException) return error.getResponse();
		// Error messages from parsers/subprocesses can contain input data.
		console.error("diffing request failed");
		return c.text("Internal Server Error", 500);
	});
	app.use("*", createServerAuthMiddleware(security));
	const limitCommentBody = bodyLimit({
		maxSize: MAX_COMMENT_REQUEST_BYTES,
		onError: (c) => c.json({ error: "Comment request is too large" }, 413),
	});
	app.use("*", (c, next) => {
		if (
			c.req.path === "/api/comments" ||
			c.req.path.startsWith("/api/comments/")
		) {
			return limitCommentBody(c, next);
		}
		return next();
	});
	const limitFileBody = bodyLimit({
		maxSize: MAX_FILE_REQUEST_BYTES,
		onError: (c) => c.json({ error: "File request is too large" }, 413),
	});
	app.use("/api/save-file", limitFileBody);
	app.use("/api/edit-save", limitFileBody);
	app.use(
		"/api/attachments",
		bodyLimit({
			maxSize: MAX_AI_IMAGE_BYTES + 1024 * 1024,
			onError: (c) => c.json({ error: "Image upload request is too large" }, 413),
		}),
	);
	// Mutable so the UI can live-toggle whitespace (and future) options without
	// restarting the server. Seeded from startup CLI flags / defaults.
	let diffOpts: DiffOptions = { ...diffOptsInput };
	const customMode = isCustomMode(diffOpts);
	const store = commentStore ?? new FileCommentStore();
	const plans = planStore ?? new FilePlanStore();
	const mockups = mockupStore ?? new FileMockupStore();
	const designSystems = designSystemStore ?? new FileDesignSystemStore();
	const prStore = prSessionStore ?? new FilePrSessionStore();
	let submitInFlight: Promise<{
		ok: boolean;
		reviewId?: number;
		reviewUrl?: string;
		failedComments: number;
		authSource: string;
		error?: string;
		dryRun: boolean;
	}> | null = null;
	const agentDiffCache = new AgentDiffIndexCache();
	const uiStateStore = new FileUiStateStore();
	const viewedStore = new FileViewedStore();
	const viewedFiles = new Set<string>();

	const currentViewedScope = async () => {
		const session = prMode ? await prStore.get() : null;
		const key = viewedScopeKey(session, prMode);
		const fingerprints = session
			? fingerprintsForPatch(session.diff ?? "")
			: null;
		return { key, fingerprints, headSha: session?.headSha, session };
	};
	/** Agent-reported progress events for the human UI (SSE `agent-progress`). */
	let lastAgentProgress: {
		at: number;
		message: string;
		model?: string;
		agentId?: string;
		commentId?: string;
		pct?: number;
	} | null = null;
	/** Waiters registered with optional identity for multi-agent display. */
	const agentWaiters = new Map<
		string,
		{ model?: string; label?: string; connectedAt: number }
	>();

	const activeClients = new Set<(event: string, data: string) => void>();

	const broadcast = (event: string, data: string) => {
		for (const send of activeClients) {
			try {
				send(event, data);
			} catch {
				// Client will be cleaned up on next interval or abort
			}
		}
	};

	const agentsSnapshot = () =>
		[...agentWaiters.entries()].map(([id, a]) => ({ id, ...a }));

	// Tracks the "agent waits, human releases" handoff. Whenever the set of
	// blocked agents or the round changes, push an `agent-status` event so the
	// UI's "Send to agent" button can show whether an agent is connected.
	const reviewSession = new ReviewSession((snapshot) =>
		broadcast(
			"agent-status",
			JSON.stringify({ ...snapshot, agents: agentsSnapshot() }),
		),
	);

	// The plan-review twin of reviewSession: tracks agents blocked waiting for a
	// plan verdict so the UI can show whether one is connected.
	const planReviewSession = new PlanReviewSession((snapshot) =>
		broadcast("plan-review-status", JSON.stringify(snapshot)),
	);

	const mockupReviewSession = new MockupReviewSession((snapshot) =>
		broadcast("mockup-review-status", JSON.stringify(snapshot)),
	);

	// Per-document nonces issued when a mockup screen document is served. The
	// probe echoes the nonce in every posted event, and the host UI can read it
	// from the X-Diffing-Mockup-Nonce response header to match events to the
	// exact document (screen + version + viewport). Comment POSTs optionally
	// carry the nonce back; when they do, the server validates it against this
	// registry (source-window validation) before accepting the comment.
	const NONCE_TTL_MS = 60 * 60 * 1000;
	const mockupNonces = new Map<
		string,
		{
			mockupId: string;
			screenId: string;
			version: number;
			viewport: MockupViewport;
			expiresAt: number;
		}
	>();
	const registerMockupNonce = (
		nonce: string,
		entry: {
			mockupId: string;
			screenId: string;
			version: number;
			viewport: MockupViewport;
		},
	): void => {
		const now = Date.now();
		if (mockupNonces.size > 500) {
			for (const [key, value] of mockupNonces) {
				if (value.expiresAt < now) mockupNonces.delete(key);
			}
		}
		mockupNonces.set(nonce, { ...entry, expiresAt: now + NONCE_TTL_MS });
	};
	const validateMockupNonce = (
		nonce: string,
		mockupId: string,
		screenId: string,
	): string | null => {
		const entry = mockupNonces.get(nonce);
		if (!entry || entry.expiresAt < Date.now()) {
			return "Stale mockup document (nonce expired or unknown) — reload the screen and retry.";
		}
		if (entry.mockupId !== mockupId || entry.screenId !== screenId) {
			return "Mockup nonce does not match this mockup/screen — reload the screen and retry.";
		}
		return null;
	};

	let repoRoot: string;
	try {
		repoRoot = getRepoRoot();
	} catch {
		repoRoot = process.cwd();
	}
	const ai = aiService ?? new AiService();
	// Retains each run's capture so external callers can navigate the same evidence.
	const snapshotStore = new SnapshotStore();
	// No language server is presumed; symbol lookup stays unavailable until one
	// is configured in settings.
	const languageServers = new LanguageServers(
		loadSettings().aiLanguageServers ?? {},
		getRepoRoot(),
	);
	const aiConversations = aiConversationStore ?? new FileAiConversationStore();

	// Watch the project storage dir so any write — whether from this server's own
	// API handlers or from an external agent editing comments.json / plans.json
	// / mockups.json directly — pushes the matching event to every connected
	// client in real time. This is the bidirectional user<->agent channel: one
	// file, one broadcast trigger. Skipped when stores are injected (e.g. the
	// in-memory stores in tests) since there is no backing file to watch.
	if (!commentStore && !planStore && !mockupStore) {
		try {
			const storageDir = getProjectStorageDir();
			mkdirSync(storageDir, { recursive: true });
			let commentsDebounce: NodeJS.Timeout | null = null;
			let plansDebounce: NodeJS.Timeout | null = null;
			let mockupsDebounce: NodeJS.Timeout | null = null;
			let designSystemDebounce: NodeJS.Timeout | null = null;
			let prSessionDebounce: NodeJS.Timeout | null = null;
			const storageWatcher = watch(storageDir, (_eventType, filename) => {
				if (!filename) return;
				if (filename.startsWith("comments.json")) {
					if (commentsDebounce) clearTimeout(commentsDebounce);
					commentsDebounce = setTimeout(
						() => broadcast("comments", Date.now().toString()),
						120,
					);
				} else if (filename.startsWith("plans.json")) {
					if (plansDebounce) clearTimeout(plansDebounce);
					plansDebounce = setTimeout(
						() => broadcast("plans", Date.now().toString()),
						120,
					);
				} else if (filename.startsWith("mockups.json")) {
					if (mockupsDebounce) clearTimeout(mockupsDebounce);
					mockupsDebounce = setTimeout(
						() => broadcast("mockups", Date.now().toString()),
						120,
					);
				} else if (filename.startsWith("design-system.json")) {
					if (designSystemDebounce) clearTimeout(designSystemDebounce);
					designSystemDebounce = setTimeout(
						() => broadcast("design-system", Date.now().toString()),
						120,
					);
				} else if (filename.startsWith("pr-session.json")) {
					if (prSessionDebounce) clearTimeout(prSessionDebounce);
					prSessionDebounce = setTimeout(
						() => broadcast("pr-session", Date.now().toString()),
						120,
					);
				}
			});
			storageWatcher.unref();
		} catch (err) {
			console.warn("Failed to initialize storage watcher:", err);
		}
	}

	let debounceTimeout: NodeJS.Timeout | null = null;

	try {
		const watcher = watch(
			repoRoot,
			{ recursive: true },
			(_eventType, filename) => {
				if (!filename) return;
				const parts = filename.split(/[/\\]/);
				const isGit = parts.includes(".git");
				const isNodeModules = parts.includes("node_modules");
				const isDist = parts.includes("dist");
				const isChangeset = parts.includes(".changeset");

				let shouldTrigger = false;
				if (isGit) {
					const isIndex = filename.endsWith("index");
					const isHead = filename.endsWith("HEAD");
					const isRefs = filename.includes("refs/") || filename.includes("refs\\");
					if (isIndex || isHead || isRefs) {
						shouldTrigger = true;
					}
				} else if (!isNodeModules && !isDist && !isChangeset) {
					shouldTrigger = true;
				}

				if (shouldTrigger) {
					if (debounceTimeout) clearTimeout(debounceTimeout);
					debounceTimeout = setTimeout(
						() => broadcast("change", Date.now().toString()),
						200,
					);
				}
			},
		);
		watcher.unref();
	} catch (err) {
		console.warn("Failed to initialize repository watcher:", err);
	}

	app.get("/api/live", async (c) => {
		return streamSSE(c, async (stream) => {
			const sendUpdate = (event: string, data: string) => {
				stream.writeSSE({ event, data });
			};
			activeClients.add(sendUpdate);

			// Confirm the connection so the client's EventSource fires `open`
			// immediately instead of waiting for the first real event.
			await stream.writeSSE({
				event: "heartbeat",
				data: Date.now().toString(),
			});

			const heartbeatInterval = setInterval(() => {
				stream
					.writeSSE({ event: "heartbeat", data: Date.now().toString() })
					.catch(() => {});
			}, 15000);

			// Keep the SSE callback pending until the client disconnects. Without
			// this await the callback resolves instantly and hono closes the stream,
			// so no events would ever reach connected clients.
			await new Promise<void>((resolve) => {
				stream.onAbort(() => {
					clearInterval(heartbeatInterval);
					activeClients.delete(sendUpdate);
					resolve();
				});
			});
		});
	});

	app.get("/api/diff", async (c) => {
		const stagedQuery = c.req.query("staged");
		const untrackedQuery = c.req.query("untracked");
		// MCP and other non-UI callers omit these query parameters. In that case
		// preserve the scope selected when the server started. Explicit UI values
		// still override the startup defaults, including explicit false.
		const staged =
			stagedQuery === undefined ? diffOpts.staged : stagedQuery === "true";
		const untracked =
			untrackedQuery === undefined
				? diffOpts.includeUntracked
				: untrackedQuery === "true";

		// PR mode: short-circuit and return the cached PR patch. The session
		// lookup is cheap (a JSON read on startup) and avoids a wasteful
		// `git diff` call. Guard with the server's PR mode flag so a stale
		// `pr-session.json` left over from a previous `diffing "gh pr N"` run
		// does not hijack a plain `diffing` invocation.
		if (prMode) {
			const prSession = await prStore.get();
			if (prSession) {
				const binaryFiles: {
					path: string;
					type: "added" | "deleted" | "changed" | "untracked";
				}[] = [];
				// Best-effort tab size from the project's editorconfig.
				const filePaths: string[] = [];
				for (const line of prSession.diff.split("\n")) {
					const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
					if (m) filePaths.push(m[1]);
				}
				// PR overview is built entirely from fields already in pr-session.json.
				// No extra git or `gh` calls — keeps the hot path cheap.
				const prOverview = buildPrOverview({
					prNumber: prSession.pullNumber,
					prTitle: prSession.title,
					prAuthor: prSession.author?.login ?? null,
					additions: prSession.additions,
					deletions: prSession.deletions,
				});
				return c.json({
					patch: prSession.diff,
					repoName: prSession.repo,
					branch: `#${prSession.pullNumber}`,
					customMode: true,
					binaryFiles,
					tabSizeMap: {},
					untrackedFiles: [],
					prMode: true,
					prRef: prSession.ref,
					prOwner: prSession.owner,
					prRepo: prSession.repo,
					prPullNumber: prSession.pullNumber,
					prUrl: prSession.url,
					prTitle: prSession.title,
					prAuthor: prSession.author,
					prHeadSha: prSession.headSha,
					prBaseSha: prSession.baseSha,
					overview: prOverview,
					diffCompleteness: prSession.diffCompleteness,
				});
			}
		}

		const optsForDiff = customMode
			? diffOpts
			: { ...diffOpts, staged, includeUntracked: untracked };

		const result = await executeDiffWithMeta(optsForDiff);

		return c.json({
			patch: result.patch,
			repoName: result.repoName,
			branch: result.branch,
			customMode,
			binaryFiles: result.binaryFiles,
			tabSizeMap: result.tabSizeMap,
			untrackedFiles: result.untrackedFiles,
			complete: result.complete,
			...(result.omittedPaths ? { omittedPaths: result.omittedPaths } : {}),
			// Show mode signals the UI to render commit metadata banners. Both
			// fields are absent in the normal flow so existing clients see the
			// same payload they always did.
			showMode: optsForDiff.showMode || undefined,
			commits: result.commits,
			truncated: result.truncated,
			// `overview` is optional and absent whenever the diff engine couldn't
			// build one (e.g. older test fixtures). The new field is a strict
			// superset of the old payload — every existing field keeps its type
			// and presence.
			overview: result.overview,
		});
	});

	// ── Bounded agent inspect (web + gh-pr; same contract as TUI Agent API) ──
	async function resolveAgentPatch(): Promise<{
		patch: string;
		complete: boolean;
		omittedPaths?: string[];
	}> {
		if (prMode) {
			const prSession = await prStore.get();
			const omitted = prSession?.diffCompleteness?.omittedPatches ?? 0;
			return {
				patch: prSession?.diff ?? "",
				complete: omitted === 0,
			};
		}
		const optsForDiff = customMode
			? diffOpts
			: {
					...diffOpts,
					staged: diffOpts.staged,
					includeUntracked: diffOpts.includeUntracked,
				};
		const result = await executeDiffWithMeta(optsForDiff);
		return {
			patch: result.patch ?? "",
			complete: result.complete,
			...(result.omittedPaths ? { omittedPaths: result.omittedPaths } : {}),
		};
	}

	async function getAgentIndex() {
		const { patch, complete, omittedPaths } = await resolveAgentPatch();
		return agentDiffCache.getOrBuild(patch, complete, omittedPaths);
	}

	function parseUInt(value: string | undefined, fallback: number): number {
		if (value == null || value === "") return fallback;
		const n = Number(value);
		return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
	}

	function optionalUInt(value: string | undefined): number | undefined {
		if (value == null || value === "") return undefined;
		const n = Number(value);
		return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
	}

	function inspectError(
		c: any,
		result: { error: string; status: number; path?: string; matches?: unknown },
	) {
		const body: Record<string, unknown> = { error: result.error };
		if (result.path != null) body.path = result.path;
		if (result.matches != null) body.matches = result.matches;
		return c.json(body, result.status as 400 | 404 | 409);
	}

	app.get("/api/diff/summary", async (c) => {
		const index = await getAgentIndex();
		const summary = indexSummary(index, c.req.query("exclude"));
		if ("status" in summary) return inspectError(c, summary);
		if (!prMode) return c.json(summary);
		const session = await prStore.get();
		if (!session) return c.json(summary);
		return c.json({
			...summary,
			prMode: true,
			owner: session.owner,
			repo: session.repo,
			pullNumber: session.pullNumber,
			title: session.title,
			url: session.url,
			baseSha: session.baseSha,
			headSha: session.headSha,
		});
	});

	app.get("/api/diff/files", async (c) => {
		const index = await getAgentIndex();
		const cursor = parseUInt(c.req.query("cursor"), 0);
		const limit = parseUInt(c.req.query("limit"), 100);
		const result = indexFiles(index, cursor, limit, c.req.query("path"));
		if ("status" in result) return inspectError(c, result);
		return c.json(result);
	});

	app.get("/api/diff/hunks", async (c) => {
		const index = await getAgentIndex();
		const resolved = resolveInspectFile(
			index,
			optionalUInt(c.req.query("file")),
			c.req.query("path"),
		);
		if ("status" in resolved) return inspectError(c, resolved);
		const cursor = parseUInt(c.req.query("cursor"), 0);
		const limit = parseUInt(c.req.query("limit"), 100);
		const generationRaw = c.req.query("generation");
		const result = indexHunks(
			index,
			resolved.fileIndex,
			cursor,
			limit,
			generationRaw != null && generationRaw !== ""
				? parseUInt(generationRaw, 0)
				: undefined,
		);
		if ("status" in result) return inspectError(c, result);
		return c.json(result);
	});

	app.get("/api/diff/slice", async (c) => {
		const index = await getAgentIndex();
		const resolved = resolveInspectFile(
			index,
			optionalUInt(c.req.query("file")),
			c.req.query("path"),
		);
		if ("status" in resolved) return inspectError(c, resolved);
		const start = parseUInt(c.req.query("start"), 0);
		const maxLines = parseUInt(c.req.query("maxLines"), 120);
		const maxBytes = parseUInt(c.req.query("maxBytes"), 256 * 1024);
		const generationRaw = c.req.query("generation");
		const result = indexSlice(
			index,
			resolved.fileIndex,
			start,
			maxLines,
			maxBytes,
			generationRaw != null && generationRaw !== ""
				? parseUInt(generationRaw, 0)
				: undefined,
		);
		if ("status" in result) return inspectError(c, result);
		return c.json(result);
	});

	app.get("/api/diff/search", async (c) => {
		const index = await getAgentIndex();
		const q = c.req.query("q") ?? "";
		const file = parseUInt(c.req.query("file"), 0);
		const row = parseUInt(c.req.query("row"), 0);
		const limit = parseUInt(c.req.query("limit"), 100);
		const maxBytes = parseUInt(c.req.query("maxBytes"), 256 * 1024);
		const generationRaw = c.req.query("generation");
		const result = indexSearch(
			index,
			q,
			file,
			row,
			limit,
			maxBytes,
			generationRaw != null && generationRaw !== ""
				? parseUInt(generationRaw, 0)
				: undefined,
			c.req.query("path"),
		);
		if ("status" in result) return inspectError(c, result);
		return c.json(result);
	});

	const resolveFileVersion = async (path: string, version: "old" | "new") => {
		if (version !== "old" && version !== "new")
			throw new NativeFsError("invalid-request");
		const safePath = toSafeLiteralRelativePath(path, repoRoot);
		if (!safePath) throw new NativeFsError("invalid-path");
		if (!prMode)
			return getFileContent(safePath, version, {
				staged: diffOpts.staged,
				revisions: diffOpts.revisions,
				showMode: diffOpts.showMode,
				showRevspecs: diffOpts.showRevspecs,
			});
		const session = await prStore.get();
		if (!session) return null;
		const sha =
			version === "old"
				? session.mergeBaseSha || session.baseSha
				: session.headSha;
		return fetchPrFileContentViaGh(resolvedFromSession(session), safePath, sha);
	};
	const aiAttachmentCache = new ByteLruCache<Buffer>(4 * 1024 * 1024, 64);
	const resolveAiAttachment = async (
		path: string,
		session: PrSession | null,
	): Promise<Buffer | null> => {
		// Admission runs before cache lookup; one captured session owns key and fetch.
		const safePath = toSafeLiteralRelativePath(path, repoRoot);
		if (!safePath) throw new NativeFsError("invalid-path");
		if (!prMode) return resolveFileVersion(safePath, "new");
		if (!session) return null;
		const cacheKey = JSON.stringify([
			session.host ?? "github.com",
			session.owner,
			session.repo,
			session.headSha,
			safePath,
		]);
		const cached = aiAttachmentCache.get(cacheKey);
		if (cached) return cached;
		const buffer = await fetchPrFileContentViaGh(
			resolvedFromSession(session),
			safePath,
			session.headSha,
		);
		if (buffer) aiAttachmentCache.set(cacheKey, buffer);
		return buffer;
	};
	const readStoredImage = async (filename: string) => {
		if (
			filename.length > 256 ||
			!/^[^/\\\0]+\.(?:png|jpe?g|webp|gif)$/i.test(filename)
		)
			return null;
		const mimeType = MIME_TYPES[extname(filename).toLowerCase()];
		if (!mimeType || !AI_IMAGE_MIME_TO_EXTENSION.has(mimeType)) return null;
		try {
			const { bytes } = await getNativeRepositoryFs(getProjectStorageDir()).read(
				`attachments/${filename}`,
			);
			if (
				bytes.length === 0 ||
				bytes.length > MAX_AI_IMAGE_BYTES ||
				!hasImageSignature(bytes, mimeType)
			)
				return null;
			return { bytes, mimeType };
		} catch (error) {
			if (error instanceof NativeFsError && error.code === "not-found")
				return null;
			throw error;
		}
	};
	const resolveAiImageAttachment = async (
		reference: AiImageAttachmentReference,
	): Promise<AiResolvedImageAttachment | null> => {
		const prefix = "/api/attachments/";
		if (!reference.url.startsWith(prefix)) return null;
		const filename = reference.url.slice(prefix.length);
		if (!/^pasted_image_[0-9a-f-]+\.(?:png|jpe?g|webp|gif)$/i.test(filename))
			return null;
		const image = await readStoredImage(filename);
		if (!image) return null;
		return {
			url: `${prefix}${filename}`,
			name: reference.name?.slice(0, 160) || filename,
			mimeType: image.mimeType,
			size: image.bytes.length,
			absolutePath: join(getProjectStorageDir(), "attachments", filename),
			dataUrl: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
		};
	};

	app.get("/api/file-content", async (c) => {
		const path = c.req.query("path");
		const version = c.req.query("version") as "old" | "new";
		if (!path || !version) {
			return c.json({ error: "Missing path or version" }, 400);
		}
		const content = await resolveFileVersion(path, version);
		if (!content) {
			return c.json({ error: "File not found" }, 404);
		}
		const ext = extname(path);
		const contentType = MIME_TYPES[ext] || "application/octet-stream";
		return new Response(new Uint8Array(content), {
			headers: {
				"Content-Type": contentType,
				"Content-Security-Policy":
					"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
			},
		});
	});

	// Text-friendly file-content endpoint used by the hunk-expansion feature
	// (Phase B). Returns JSON { content, missing } where `missing` indicates the
	// version didn't exist (new file → old missing, deleted → new missing).
	// Also returns `hash` (sha256 of the exact on-disk bytes) so edit sessions
	// can detect external changes at save time (conflict check).
	app.get("/api/file-text", async (c) => {
		const path = c.req.query("path");
		const version = c.req.query("version") as "old" | "new";
		if (!path || !version) {
			return c.json({ error: "Missing path or version" }, 400);
		}
		const buffer = await resolveFileVersion(path, version);
		if (!buffer) {
			return c.json({ content: "", missing: true });
		}
		// Detect binary by null byte in the first 8KB
		const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
		for (let i = 0; i < sample.length; i++) {
			if (sample[i] === 0) {
				return c.json({ error: "Binary file" }, 415);
			}
		}
		const hash = createHash("sha256").update(buffer).digest("hex");
		return c.json({ content: buffer.toString("utf-8"), missing: false, hash });
	});

	app.post("/api/open-file", async (c) => {
		const { filePath, editor } = await c.req.json<{
			filePath: string;
			editor?: string;
		}>();
		if (!filePath) {
			return c.json({ error: "filePath is required" }, 400);
		}

		try {
			const root = getRepoRoot();
			let absolutePath: string | null = null;

			// Repo-relative paths (diff review).
			const relPath = toSafeRelativePath(filePath, root);
			if (relPath) {
				absolutePath = resolve(root, relPath);
			} else {
				// Absolute paths under ~/.diffing/ only (plan source mirrors live there).
				const resolved = resolve(filePath);
				const diffingHome = resolve(homedir(), ".diffing");
				const underDiffing =
					resolved === diffingHome ||
					resolved.startsWith(diffingHome + "/") ||
					resolved.startsWith(diffingHome + "\\");
				if (underDiffing && existsSync(resolved)) {
					absolutePath = resolved;
				}
			}
			if (!absolutePath) {
				return c.json({ error: "Forbidden file path" }, 403);
			}

			if (editor && editor !== "default") {
				const command = resolveEditorCommand(editor as EditorChoice, absolutePath);
				if (command) {
					const { execFile } = await import("node:child_process");
					execFile(command.cmd, command.args, (err) => {
						if (err) {
							console.error(
								`Failed to launch ${editor} for ${absolutePath}: ${err.message}`,
							);
						}
					});
					return c.json({ ok: true });
				}
			}

			const openModule = await import("open");
			await openModule.default(absolutePath);
			return c.json({ ok: true });
		} catch (err: any) {
			return c.json({ error: `Failed to open file: ${err.message}` }, 500);
		}
	});

	app.get("/api/repo-files", (c) => {
		try {
			return c.json({ files: listRepoFiles() });
		} catch (err: any) {
			return c.json({ error: err.message }, 500);
		}
	});

	// Unified, fff-powered code search. POST (not GET) so large diffs can pass
	// their changed-path set in the body without hitting URL length limits.
	app.post("/api/search", async (c) => {
		const body = await c.req
			.json<{
				scope?: "all" | "files" | "text" | "symbols";
				query?: string;
				limit?: number;
				regex?: boolean;
				changedPaths?: string[];
			}>()
			.catch(() => ({}) as Record<string, never>);

		const scope = body.scope ?? "files";
		const query = typeof body.query === "string" ? body.query : "";
		const limit = typeof body.limit === "number" ? body.limit : undefined;
		// A non-null `changedPaths` array engages "Changed only" mode: results are
		// restricted to exactly these (current-diff) paths.
		const paths = Array.isArray(body.changedPaths)
			? body.changedPaths
			: undefined;

		try {
			if (scope === "all") {
				return c.json(
					await searchAll(query, { limit, regex: !!body.regex, paths }),
				);
			}
			if (scope === "text") {
				return c.json(
					await searchContent(query, { limit, regex: !!body.regex, paths }),
				);
			}
			if (scope === "symbols") {
				return c.json(await searchSymbols(query, { limit, paths }));
			}
			return c.json(await searchFiles(query, { limit, paths }));
		} catch (err: any) {
			return c.json(
				{
					scope,
					items: [],
					total: 0,
					indexing: false,
					error: err?.message ?? "Search failed",
				},
				500,
			);
		}
	});

	app.get("/api/search/status", async (c) => {
		return c.json(await getSearchStatus());
	});

	// Fire-and-forget: feeds fff's frecency ranking so frequently/recently opened
	// files float to the top of future searches.
	app.post("/api/search/track", async (c) => {
		const { query, path } = await c.req
			.json<{ query?: string; path?: string }>()
			.catch(() => ({}) as Record<string, never>);
		if (path) await trackSelection(query ?? "", path);
		return c.json({ ok: true });
	});

	app.get("/api/merge-status", (c) => {
		try {
			const status = getMergeStatus();
			return c.json(status);
		} catch (err: any) {
			return c.json({ error: err.message }, 500);
		}
	});

	app.post("/api/revert-hunk", async (c) => {
		const { filePath, hunkIndex } = await c.req.json<{
			filePath: string;
			hunkIndex: number;
		}>();
		if (!filePath || typeof hunkIndex !== "number") {
			return c.json({ error: "Missing filePath or hunkIndex" }, 400);
		}
		try {
			const root = getRepoRoot();
			const relPath = toSafeRelativePath(filePath, root);
			if (!relPath) {
				return c.json({ error: "Forbidden file path" }, 403);
			}
			await revertHunk(relPath, hunkIndex);
			return c.json({ ok: true });
		} catch (err: any) {
			const stderr =
				typeof err?.stderr === "string"
					? err.stderr
					: err?.stderr instanceof Buffer
						? err.stderr.toString("utf-8")
						: "";
			return c.json(
				{ error: stderr || err?.message || "Failed to revert hunk" },
				500,
			);
		}
	});

	/**
	 * Pick a single tree-ish suitable for `git blame` from a list of revisions
	 * or show-revspecs. `git blame` does not accept range notation, so for
	 * `A..B` or `A...B` we use the right endpoint (the side being compared
	 * against), which matches the diff's "destination" side.
	 */
	function extractBlameRevision(
		revisions: string[],
		showRevspecs: string[],
		showMode: boolean,
	): string {
		const list = showMode ? showRevspecs : revisions;
		if (list.length === 0) return "HEAD";
		const last = list[list.length - 1];
		// Check `...` first so that `A...B` is not misread as `A` / `..` / `B`.
		const threeDot = last.lastIndexOf("...");
		if (threeDot >= 0) {
			const target = last.slice(threeDot + 3);
			if (target) return target;
		}
		const twoDot = last.lastIndexOf("..");
		if (twoDot >= 0) {
			const target = last.slice(twoDot + 2);
			if (target) return target;
		}
		return last;
	}

	app.get("/api/hunk-history", async (c) => {
		const filePath = c.req.query("filePath");
		const deletionStart = Number(c.req.query("deletionStart"));
		const deletionCount = Number(c.req.query("deletionCount"));

		if (!filePath || Number.isNaN(deletionStart) || Number.isNaN(deletionCount)) {
			return c.json({ error: "Missing or invalid parameters" }, 400);
		}

		try {
			const root = getRepoRoot();
			const relPath = toSafeRelativePath(filePath, root);
			if (!relPath) {
				return c.json({ error: "Forbidden file path" }, 403);
			}
			const revision = extractBlameRevision(
				diffOpts.revisions,
				diffOpts.showRevspecs,
				diffOpts.showMode,
			);
			const history = getHunkHistory(
				relPath,
				deletionStart,
				deletionCount,
				revision,
			);
			return c.json(history);
		} catch (err: any) {
			return c.json({ error: err.message || "Failed to fetch hunk history" }, 500);
		}
	});

	app.post("/api/save-file", async (c) => {
		const parsed = saveFileSchema.safeParse(await readCommentJson(c));
		if (!parsed.success)
			return c.json({ error: "Invalid file-save request" }, 400);
		if (prMode || customMode) {
			return c.json(
				{ error: "Editing is not available in this review scope" },
				403,
			);
		}
		const { filePath, content, gitAdd } = parsed.data;
		const relPath = toSafeLiteralRelativePath(filePath, repoRoot);
		if (!relPath) throw new NativeFsError("invalid-path");
		await getNativeRepositoryFs(repoRoot).write(
			relPath,
			Buffer.from(content, "utf8"),
		);
		if (gitAdd) {
			try {
				gitAddFile(relPath);
			} catch {
				return c.json({ ok: true, gitAddError: "File saved, but staging failed" });
			}
		}
		return c.json({ ok: true });
	});

	/**
	 * Save an in-place edit session's document.
	 *
	 * - Whole-file atomic write (temp file + rename) — never a partial patch.
	 * - Optional `baseHash` is checked before writing; a mismatch returns 409.
	 *   This optimistic check is not a cross-process compare-and-swap.
	 * - Optional `anchorUpdates` persist remapped coordinates after the write.
	 *   File bytes and comment metadata are not one atomic transaction.
	 *
	 * The file watcher broadcasts the `change` SSE event automatically, which
	 * refreshes the diff in every connected review surface.
	 */
	app.post("/api/edit-save", async (c) => {
		const parsed = editSaveSchema.safeParse(await readCommentJson(c));
		if (!parsed.success)
			return c.json({ error: "Invalid edit-save request" }, 400);
		const body = parsed.data;
		// In-place editing mutates the working tree; PR sessions and revision
		// comparisons have no writable working-tree diff backing their view.
		if (prMode || customMode) {
			return c.json(
				{ error: "Editing is not available in this review scope" },
				403,
			);
		}
		const saved = await getNativeRepositoryFs(repoRoot).write(
			body.filePath,
			Buffer.from(body.content, "utf8"),
			{ expectedSha256: body.baseHash },
		);
		try {
			for (const anchor of body.anchorUpdates ?? []) {
				const updated = await store.update(anchor.id, {
					side: anchor.side ?? "additions",
					lineNumber: anchor.lineNumber,
					startLineNumber: anchor.startLineNumber,
				});
				if (!updated) throw new Error("Comment no longer exists");
			}
		} catch {
			return c.json(
				{
					error: "File saved, but comment anchors could not all be updated",
					fileSaved: true,
					hash: saved.sha256,
				},
				500,
			);
		}
		return c.json({ ok: true, hash: saved.sha256 });
	});

	app.get("/api/settings", (c) => {
		return c.json(loadSettings());
	});

	app.get("/api/ai/connections", async (c) => {
		return c.json({ connections: await ai.connections() });
	});

	app.get("/api/ai/models", async (c) => {
		return c.json({ models: await ai.models() });
	});

	/**
	 * Read-only evidence navigation over a retained capture. These routes serve
	 * exactly what a run could read and nothing more: no shell, no network, no
	 * filesystem, and no way to widen a capture after the fact.
	 */
	const evidenceError = (c: Context, error: unknown) => {
		if (error instanceof AiSnapshotError)
			return c.json({ error: error.message, code: error.code }, error.status);
		throw error;
	};
	const readRequests = (value: unknown): ReadRequest[] => {
		if (!Array.isArray(value)) throw new AiSnapshotError("invalid");
		return value.map((entry) => {
			const item = entry as Partial<ReadRequest>;
			if (
				typeof item?.key !== "string" ||
				!Number.isSafeInteger(item.startLine) ||
				!Number.isSafeInteger(item.endLine)
			)
				throw new AiSnapshotError("invalid");
			return {
				key: item.key,
				startLine: item.startLine as number,
				endLine: item.endLine as number,
			};
		});
	};
	const retained = (c: Context) => {
		const id = c.req.param("id");
		if (!id) throw new AiSnapshotError("invalid");
		return snapshotStore.get(id, c.req.query("revision") ?? undefined);
	};
	const optionalInt = (value: string | undefined): number | undefined =>
		value === undefined ? undefined : Number(value);

	app.get("/api/ai/evidence", (c) =>
		c.json({ snapshots: snapshotStore.list() }),
	);

	app.get("/api/ai/evidence/:id/map", (c) => {
		try {
			return c.json(
				reviewMap(retained(c), {
					cursor: c.req.query("cursor") ?? undefined,
					limit: optionalInt(c.req.query("limit")),
				}),
			);
		} catch (error) {
			return evidenceError(c, error);
		}
	});

	app.post("/api/ai/evidence/:id/read", async (c) => {
		try {
			const body = (await c.req.json().catch(() => {
				throw new AiSnapshotError("invalid");
			})) as { requests?: unknown; maxBytes?: unknown; representation?: unknown };
			const snapshot = retained(c);
			const requests = readRequests(body.requests);
			const maxBytes =
				body.maxBytes === undefined ? undefined : Number(body.maxBytes);
			const read = body.representation === "unified-patch" ? diffRead : sourceRead;
			return c.json(read(snapshot, requests, maxBytes));
		} catch (error) {
			return evidenceError(c, error);
		}
	});

	app.post("/api/ai/evidence/:id/symbols", async (c) => {
		try {
			const body = (await c.req.json().catch(() => {
				throw new AiSnapshotError("invalid");
			})) as {
				key?: unknown;
				line?: unknown;
				character?: unknown;
				kind?: unknown;
				includeDeclaration?: unknown;
			};
			const snapshot = retained(c);
			return c.json(
				await lookupSymbols(snapshot, languageServers, getRepoRoot(), {
					key: typeof body.key === "string" ? body.key : "",
					line: Number(body.line),
					character: Number(body.character),
					kind: body.kind as SymbolKind,
					includeDeclaration: body.includeDeclaration === true,
				}),
			);
		} catch (error) {
			return evidenceError(c, error);
		}
	});

	app.post("/api/ai/evidence/:id/search", async (c) => {
		try {
			const body = (await c.req.json().catch(() => {
				throw new AiSnapshotError("invalid");
			})) as {
				query?: unknown;
				key?: unknown;
				limit?: unknown;
				ignoreCase?: unknown;
				cursor?: unknown;
			};
			if (typeof body.query !== "string") throw new AiSnapshotError("invalid");
			return c.json(
				sourceSearch(retained(c), body.query, {
					key: typeof body.key === "string" ? body.key : undefined,
					limit: body.limit === undefined ? undefined : Number(body.limit),
					ignoreCase: body.ignoreCase === true,
					cursor: typeof body.cursor === "string" ? body.cursor : undefined,
				}),
			);
		} catch (error) {
			return evidenceError(c, error);
		}
	});

	app.post("/api/ai/connections/:source/key", async (c) => {
		try {
			const source = c.req.param("source") as AiSourceId;
			const body = (await c.req.json()) as {
				apiKey?: unknown;
				remember?: unknown;
			};
			if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
				return c.json({ error: "apiKey is required" }, 400);
			}
			if (body.apiKey.length > 16 * 1024) {
				return c.json({ error: "apiKey is too large" }, 413);
			}
			await ai.connectKey(source, body.apiKey, body.remember === true);
			return c.json({ ok: true });
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : String(error) },
				400,
			);
		}
	});

	app.post("/api/ai/connections/:source/login", async (c) => {
		try {
			const source = c.req.param("source") as AiSourceId;
			const body = (await c.req.json().catch(() => ({}))) as {
				route?: AiCredentialRoute;
				providerId?: string;
			};
			const route = body.route ?? "subscription";
			return c.json({ command: ai.setupCommand(source, route, body.providerId) });
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : String(error) },
				400,
			);
		}
	});

	app.post("/api/ai/connections/:source/configure-runtime-key", async (c) => {
		try {
			const source = c.req.param("source") as AiSourceId;
			const body = (await c.req.json().catch(() => ({}))) as {
				providerId?: string;
			};
			return c.json({
				command: ai.setupCommand(source, "runtime-key", body.providerId),
			});
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : String(error) },
				400,
			);
		}
	});

	app.delete("/api/ai/connections/:source", async (c) => {
		try {
			await ai.disconnect(c.req.param("source") as AiSourceId);
			return c.json({ ok: true });
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : String(error) },
				400,
			);
		}
	});

	const aiSurfaces = new Set(["diff", "pr-diff", "plan", "mockup"]);
	const conversationHeaders = { "Cache-Control": "no-store" };
	app.get("/api/ai/conversations", async (c) => {
		const surface = c.req.query("surface");
		const scopeKey = c.req.query("scopeKey");
		if (surface && !aiSurfaces.has(surface))
			return c.json({ error: "Invalid AI conversation surface." }, 400);
		return c.json(
			{
				conversations: await aiConversations.list({
					surface: surface as AiSurface | undefined,
					scopeKey: scopeKey || undefined,
				}),
			},
			200,
			conversationHeaders,
		);
	});

	app.post("/api/ai/conversations", async (c) => {
		const body = (await c.req
			.json()
			.catch(() => ({}))) as Partial<AiConversationCreateInput>;
		if (
			!aiSurfaces.has(body.surface ?? "") ||
			typeof body.scopeKey !== "string" ||
			!body.scopeKey.trim()
		) {
			return c.json({ error: "surface and scopeKey are required." }, 400);
		}
		const conversation = await aiConversations.create({
			surface: body.surface as AiSurface,
			scopeKey: body.scopeKey,
			title: body.title,
			modelId: body.modelId,
		});
		return c.json({ conversation }, 201, conversationHeaders);
	});

	app.get("/api/ai/conversations/:id", async (c) => {
		const conversation = await aiConversations.get(c.req.param("id"));
		if (!conversation)
			return c.json({ error: "AI conversation not found." }, 404);
		return c.json({ conversation }, 200, conversationHeaders);
	});

	app.put("/api/ai/conversations/:id", async (c) => {
		const body = (await c.req
			.json()
			.catch(() => ({}))) as AiConversationUpdateInput;
		const conversation = await aiConversations.update(c.req.param("id"), {
			title: typeof body.title === "string" ? body.title : undefined,
			draft: typeof body.draft === "string" ? body.draft : undefined,
			modelId: typeof body.modelId === "string" ? body.modelId : undefined,
			turns: Array.isArray(body.turns) ? body.turns : undefined,
		});
		if (!conversation)
			return c.json({ error: "AI conversation not found." }, 404);
		return c.json({ conversation }, 200, conversationHeaders);
	});

	app.delete("/api/ai/conversations/:id", async (c) => {
		const removed = await aiConversations.remove(c.req.param("id"));
		if (!removed) return c.json({ error: "AI conversation not found." }, 404);
		return c.json({ ok: true }, 200, conversationHeaders);
	});

	app.post("/api/ai/run", async (c) => {
		let body: AiRunRequest;
		try {
			body = await readAiRunRequest(c.req.raw);
		} catch (error) {
			const failure =
				error instanceof AiRequestError ? error : new AiRequestError(400);
			return c.json({ error: failure.message }, failure.status);
		}
		if (!body.modelId || !body.action || !body.surface || !body.context) {
			return c.json(
				{ error: "modelId, action, surface, and context are required" },
				400,
			);
		}
		if (!aiSurfaces.has(body.surface)) {
			return c.json({ error: "Invalid AI conversation surface." }, 400);
		}
		if ("patch" in body.context && body.context.patch !== undefined) {
			const patch = body.context.patch;
			const rendererMetadataText =
				typeof patch === "string" &&
				/^(?:\[object Object\](?:,\[object Object\])*)(?:\n(?:\[object Object\](?:,\[object Object\])*))*$/.test(
					patch.trim(),
				);
			if (typeof patch !== "string" || rendererMetadataText) {
				return c.json(
					{
						error:
							"The selected diff context could not be serialized. Refresh the review and try again.",
					},
					400,
				);
			}
		}
		if ("selections" in body.context && body.context.selections !== undefined) {
			if (
				!Array.isArray(body.context.selections) ||
				body.context.selections.length > 8
			) {
				return c.json(
					{ error: "At most 8 diff ranges can be attached to one AI request." },
					400,
				);
			}
			let selectionBytes = 0;
			for (const selection of body.context.selections) {
				if (
					!selection ||
					typeof selection.filePath !== "string" ||
					!isReviewCommentSide(selection.side) ||
					!Number.isInteger(selection.startLine) ||
					!Number.isInteger(selection.endLine) ||
					selection.startLine < 1 ||
					selection.endLine < selection.startLine ||
					typeof selection.selectedText !== "string"
				) {
					return c.json({ error: "An attached diff range is invalid." }, 400);
				}
				selectionBytes += Buffer.byteLength(selection.selectedText, "utf8");
			}
			if (selectionBytes > 64 * 1024)
				return c.json(
					{ error: "Attached diff ranges exceed the 64 KB context limit." },
					413,
				);
		}
		let prepared: AiPreparedRun;
		try {
			prepared = await ai.prepareRun(
				body,
				async (signal) => {
					signal.throwIfAborted();
					let capturedPr: PrSession | null = null;
					let prCapture: ReturnType<typeof capturePrReview> | undefined;
					let planCapture:
						| Awaited<ReturnType<typeof resolvePlanSnapshot>>
						| undefined;
					let localCapture:
						| Awaited<ReturnType<typeof captureLocalReview>>
						| undefined;
					const capturedOptions = JSON.stringify(diffOpts);
					if (prMode) {
						const current = await prStore.get();
						signal.throwIfAborted();
						capturedPr = current ? { ...current } : null;
						prCapture = capturePrReview(capturedPr);
					}
					if (body.surface === "pr-diff" && !prCapture)
						throw new AiSnapshotError("invalid");
					if ("planId" in body.context) {
						if (body.surface !== "plan") throw new AiSnapshotError("invalid");
						planCapture = await resolvePlanSnapshot(body.context, plans);
						signal.throwIfAborted();
						body.context = planCapture.context;
						body.snapshot = planCapture.snapshot.manifest;
						body.snapshotReader = planCapture.snapshot;
						snapshotStore.put(planCapture.snapshot);
					} else if (body.surface === "plan") throw new AiSnapshotError("invalid");
					else if (!("mockupId" in body.context)) {
						if (body.surface !== (prMode ? "pr-diff" : "diff"))
							throw new AiSnapshotError("invalid");
						if (!prCapture)
							localCapture = await captureLocalReview(
								getRepoRoot(),
								diffOpts,
								executeDiffWithMeta,
							);
						signal.throwIfAborted();
						const captured = resolveDiffSnapshot(
							body.context,
							prCapture ?? localCapture!,
							getRepoRoot(),
						);
						body.context = captured.context;
						body.snapshot = captured.snapshot.manifest;
						body.snapshotReader = captured.snapshot;
						snapshotStore.put(captured.snapshot);
					}
					const requestedImages = Array.isArray(body.context.imageAttachments)
						? body.context.imageAttachments
						: [];
					if (requestedImages.length > MAX_AI_IMAGE_COUNT)
						throw new AiRequestError(400, "Too many image attachments.");
					const resolvedImages: AiResolvedImageAttachment[] = [];
					for (const reference of requestedImages) {
						if (
							!reference ||
							typeof reference.url !== "string" ||
							typeof reference.name !== "string" ||
							typeof reference.mimeType !== "string"
						) {
							throw new AiRequestError(
								400,
								"An image attachment reference is invalid.",
							);
						}
						signal.throwIfAborted();
						const resolvedImage = await resolveAiImageAttachment(reference);
						signal.throwIfAborted();
						if (!resolvedImage)
							throw new AiRequestError(
								404,
								"An image attachment is unavailable or invalid.",
							);
						resolvedImages.push(resolvedImage);
					}
					const requestedPaths = [
						...new Set(
							(body.context.attachmentPaths ?? []).filter(
								(path): path is string =>
									typeof path === "string" && path.trim().length > 0,
							),
						),
					];
					if (requestedPaths.length > 8)
						throw new AiRequestError(
							400,
							"At most 8 files can be attached to one AI request.",
						);
					const attachments: AiAttachment[] = [];
					let remainingAttachmentBytes = 64 * 1024;
					for (const path of requestedPaths) {
						signal.throwIfAborted();
						const buffer = await resolveAiAttachment(path, capturedPr);
						signal.throwIfAborted();
						if (!buffer)
							throw new AiRequestError(404, "An attached file is unavailable.");
						const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
						if (sample.includes(0))
							throw new AiRequestError(415, "Binary files cannot be attached.");
						if (remainingAttachmentBytes <= 0) break;
						const take = Math.min(buffer.length, 32 * 1024, remainingAttachmentBytes);
						attachments.push({
							path,
							content: buffer.subarray(0, take).toString("utf8"),
							truncated: take < buffer.length,
						});
						remainingAttachmentBytes -= take;
					}
					body.context = {
						...body.context,
						attachmentPaths: requestedPaths,
						attachments,
						imageAttachments: resolvedImages.map(({ url, name, mimeType, size }) => ({
							url,
							name,
							mimeType,
							size,
						})),
					};
					body.resolvedImages = resolvedImages;
					signal.throwIfAborted();
					await planCapture?.assertFresh();
					signal.throwIfAborted();
					await localCapture?.assertFresh();
					signal.throwIfAborted();
					if (localCapture && capturedOptions !== JSON.stringify(diffOpts))
						throw new AiSnapshotError("stale");
					if (prCapture) prCapture.assertFresh(await prStore.get());
					signal.throwIfAborted();
					return body;
				},
				c.req.raw.signal,
			);
		} catch (error) {
			if (error instanceof AiSnapshotError || error instanceof AiRequestError)
				return c.json({ error: error.message }, error.status);
			if (error instanceof AiRunError)
				return c.json(
					{ error: error.message, code: error.code },
					error.code === "capacity"
						? 503
						: error.code.endsWith("timeout")
							? 408
							: error.code === "cancelled"
								? 409
								: error.code === "preparation_failed"
									? 500
									: 400,
				);
			throw error;
		}
		try {
			return streamSSE(c, (stream) =>
				streamAiRun(ai, body, stream, c.req.raw.signal, prepared),
			);
		} catch (error) {
			ai.cancel(prepared.runId);
			throw error;
		}
	});

	app.post("/api/ai/runs/:id/cancel", (c) => {
		const requested = ai.cancel(c.req.param("id"));
		return c.json({
			canceled: requested, // Legacy acceptance flag, not a termination confirmation.
			cancellationRequested: requested,
			cancellationConfirmed: false,
			status: requested ? "cancel-requested" : "not-active",
		});
	});

	app.put("/api/settings", async (c) => {
		const body = await c.req.json();
		const settings = saveSettings(body);
		// Live-apply whitespace flags into the running diff options so the next
		// /api/diff (and SSE change) reflects them without a process restart.
		let whitespaceChanged = false;
		if (
			typeof body.ignoreSpaceChange === "boolean" &&
			body.ignoreSpaceChange !== diffOpts.ignoreSpaceChange
		) {
			diffOpts = { ...diffOpts, ignoreSpaceChange: body.ignoreSpaceChange };
			whitespaceChanged = true;
		}
		if (
			typeof body.ignoreAllSpace === "boolean" &&
			body.ignoreAllSpace !== diffOpts.ignoreAllSpace
		) {
			diffOpts = { ...diffOpts, ignoreAllSpace: body.ignoreAllSpace };
			whitespaceChanged = true;
		}
		if (whitespaceChanged) {
			broadcast("change", Date.now().toString());
		}
		return c.json(settings);
	});

	/** Patch live diff options (subset). Broadcasts `change` so clients refetch. */
	app.put("/api/diff-options", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		const next = { ...diffOpts };
		if (typeof body.ignoreSpaceChange === "boolean")
			next.ignoreSpaceChange = body.ignoreSpaceChange;
		if (typeof body.ignoreAllSpace === "boolean")
			next.ignoreAllSpace = body.ignoreAllSpace;
		if (typeof body.ignoreBlankLines === "boolean")
			next.ignoreBlankLines = body.ignoreBlankLines;
		diffOpts = next;
		// Mirror into persisted settings when whitespace keys are present.
		const settingsPatch: Record<string, boolean> = {};
		if (typeof body.ignoreSpaceChange === "boolean")
			settingsPatch.ignoreSpaceChange = body.ignoreSpaceChange;
		if (typeof body.ignoreAllSpace === "boolean")
			settingsPatch.ignoreAllSpace = body.ignoreAllSpace;
		if (Object.keys(settingsPatch).length) saveSettings(settingsPatch);
		broadcast("change", Date.now().toString());
		return c.json({
			ignoreSpaceChange: diffOpts.ignoreSpaceChange,
			ignoreAllSpace: diffOpts.ignoreAllSpace,
			ignoreBlankLines: diffOpts.ignoreBlankLines,
		});
	});

	app.get("/api/diff-options", (c) => {
		return c.json({
			ignoreSpaceChange: diffOpts.ignoreSpaceChange,
			ignoreAllSpace: diffOpts.ignoreAllSpace,
			ignoreBlankLines: diffOpts.ignoreBlankLines,
		});
	});

	// ── Agent progress / multi-agent identity ──────────────────────────────
	app.post("/api/agent/progress", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		const message = typeof body.message === "string" ? body.message.trim() : "";
		if (!message) return c.json({ error: "message is required" }, 400);
		const payload = {
			at: Date.now(),
			message,
			model: typeof body.model === "string" ? body.model : undefined,
			agentId: typeof body.agentId === "string" ? body.agentId : undefined,
			commentId: typeof body.commentId === "string" ? body.commentId : undefined,
			pct:
				typeof body.pct === "number" && body.pct >= 0 && body.pct <= 100
					? body.pct
					: undefined,
		};
		lastAgentProgress = payload;
		broadcast("agent-progress", JSON.stringify(payload));
		return c.json({ ok: true, ...payload });
	});

	app.get("/api/agent/progress", (c) => {
		return c.json({ progress: lastAgentProgress });
	});

	app.post("/api/agent/register", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		const agentId =
			(typeof body.agentId === "string" && body.agentId) || crypto.randomUUID();
		const model = typeof body.model === "string" ? body.model : undefined;
		const label = typeof body.label === "string" ? body.label : undefined;
		agentWaiters.set(agentId, { model, label, connectedAt: Date.now() });
		broadcast(
			"agent-status",
			JSON.stringify({
				...reviewSession.snapshot(),
				agents: [...agentWaiters.entries()].map(([id, a]) => ({ id, ...a })),
			}),
		);
		return c.json({ ok: true, agentId });
	});

	app.delete("/api/agent/register/:id", async (c) => {
		const id = c.req.param("id");
		agentWaiters.delete(id);
		broadcast(
			"agent-status",
			JSON.stringify({
				...reviewSession.snapshot(),
				agents: [...agentWaiters.entries()].map(([aid, a]) => ({
					id: aid,
					...a,
				})),
			}),
		);
		return c.json({ ok: true });
	});

	app.get("/api/ui-state", async (c) => {
		return c.json(await uiStateStore.getAll());
	});

	app.put("/api/ui-state", async (c) => {
		const body = await c.req.json();
		const current = await uiStateStore.getAll();
		const merged = { ...current, ...body };
		for (const key of Object.keys(body)) {
			if (body[key] === null || body[key] === undefined) {
				delete merged[key];
			}
		}
		await uiStateStore.setAll(merged);
		return c.json(merged);
	});

	app.get("/api/viewed", async (c) => {
		const scope = await currentViewedScope();
		if (!prMode) {
			return c.json([...viewedFiles]);
		}
		const paths = await viewedStore.list(scope.key, scope.fingerprints);
		return c.json(paths);
	});

	app.put("/api/viewed", async (c) => {
		const { filePath, viewed } = await c.req.json<{
			filePath: string;
			viewed: boolean;
		}>();
		if (!prMode) {
			if (viewed) viewedFiles.add(filePath);
			else viewedFiles.delete(filePath);
			const list = [...viewedFiles];
			await viewedStore.toggle("local", filePath, viewed);
			broadcast("viewed", JSON.stringify(list));
			return c.json({ ok: true });
		}
		const scope = await currentViewedScope();
		const fingerprint = scope.fingerprints?.[filePath];
		const paths = await viewedStore.toggle(
			scope.key,
			filePath,
			viewed,
			fingerprint,
			scope.headSha,
			scope.fingerprints,
		);
		broadcast("viewed", JSON.stringify(paths));
		return c.json({ ok: true });
	});

	app.get("/api/comments", async (c) => {
		const comments = await store.getAll();
		return c.json(comments);
	});

	app.post("/api/comments/resolve-all", async (c) => {
		const resolved = await store.resolveAllOpen();
		return c.json({ ok: true, resolved });
	});

	app.post("/api/comments", async (c) => {
		const parsed = createReviewCommentSchema.safeParse(await readCommentJson(c));
		if (!parsed.success) return c.json(commentValidationError(parsed.error), 400);
		const body = parsed.data;
		const severity = body.severity === "none" ? undefined : body.severity;
		const comment = {
			id: crypto.randomUUID(),
			filePath: body.filePath,
			side: body.side,
			lineNumber: body.lineNumber,
			startLineNumber: body.startLineNumber,
			lineContent: body.lineContent,
			body: body.body,
			status: "open" as const,
			createdAt: Date.now(),
			replies: [],
			...(severity ? { severity } : {}),
		};
		const created = await store.add(comment);
		return c.json(created, 201);
	});

	app.put("/api/comments/:id", async (c) => {
		const id = c.req.param("id");
		const parsed = updateReviewCommentSchema.safeParse(await readCommentJson(c));
		if (!parsed.success) return c.json(commentValidationError(parsed.error), 400);
		const updated = await store.update(id, parsed.data);
		if (!updated) return c.json({ error: "Comment not found" }, 404);
		return c.json(updated);
	});

	app.post("/api/comments/:id/replies", async (c) => {
		const commentId = c.req.param("id");
		const parsed = createCommentReplySchema.safeParse(await readCommentJson(c));
		if (!parsed.success) return c.json(commentValidationError(parsed.error), 400);
		const { body, role, model } = parsed.data;
		const reply = {
			id: crypto.randomUUID(),
			body,
			createdAt: Date.now(),
			// Agents identify themselves by sending a `model`. Honour an explicit
			// role, otherwise infer agent-vs-user from the presence of a model so
			// replies posted via the documented `{ body, model }` payload are
			// attributed correctly.
			role: role || (model ? "agent" : "user"),
			model: model || undefined,
		};
		const updated = await store.addReply(commentId, reply);
		if (!updated) return c.json({ error: "Comment not found" }, 404);
		return c.json(updated);
	});

	app.delete("/api/comments/:id/replies/:replyId", async (c) => {
		const commentId = c.req.param("id");
		const replyId = c.req.param("replyId");
		const updated = await store.removeReply(commentId, replyId);
		if (!updated) return c.json({ error: "Comment or reply not found" }, 404);
		return c.json(updated);
	});

	app.put("/api/comments/:id/replies/:replyId", async (c) => {
		const commentId = c.req.param("id");
		const replyId = c.req.param("replyId");
		const parsed = editCommentReplySchema.safeParse(await readCommentJson(c));
		if (!parsed.success) return c.json(commentValidationError(parsed.error), 400);
		const updated = await store.updateReply(commentId, replyId, parsed.data.body);
		if (!updated) return c.json({ error: "Comment or reply not found" }, 404);
		return c.json(updated);
	});

	app.post("/api/comments/:id/apply-suggestion", async (c) => {
		if (prMode || customMode) {
			return c.json(
				{ error: "Editing is not available in this review scope" },
				403,
			);
		}
		const id = c.req.param("id");
		const comment = (await store.getAll()).find((c) => c.id === id);
		if (!comment) {
			return c.json({ error: "Comment not found" }, 404);
		}

		const files = getNativeRepositoryFs(repoRoot);
		const current = await files.read(comment.filePath);
		const { applySuggestionToContent } = await import(
			"./lib/apply-suggestion.js"
		);
		const result = applySuggestionToContent({
			content: current.bytes.toString("utf8"),
			lineNumber: comment.lineNumber,
			startLineNumber: comment.startLineNumber,
			body: comment.body,
			side: comment.side,
		});
		if (!result.ok) return c.json({ error: result.error }, 400);
		await files.write(comment.filePath, Buffer.from(result.content, "utf8"), {
			expectedSha256: current.sha256,
		});
		try {
			const updated = await store.update(id, { status: "resolved" });
			if (!updated) throw new Error("Comment no longer exists");
		} catch {
			return c.json(
				{
					error: "File saved, but the comment could not be resolved",
					fileSaved: true,
				},
				500,
			);
		}
		return c.json({ ok: true, replacedLines: result.replacedLines });
	});

	app.delete("/api/comments/:id", async (c) => {
		const id = c.req.param("id");
		const removed = await store.remove(id);
		if (!removed) return c.json({ error: "Comment not found" }, 404);
		return c.json({ ok: true });
	});

	// ── PR review session ─────────────────────────────────────────────────────
	// All `/api/gh/*` routes are active only when the server was started in PR
	// mode (`diffing "gh pr N"`). A stale `pr-session.json` on disk must not
	// leak PR data into a plain `diffing` invocation. The UI fetches
	// `/api/gh/session` on mount to detect PR mode and switch to <PrReviewApp>.

	/** Shared helper: 404 with a stable shape so the client knows "not in PR mode". */
	const notInPrMode = (c: any) =>
		c.json({ error: "Not in PR review mode", prMode: false }, 404);

	app.get("/api/gh/session", async (c) => {
		// Soft probe for Root.tsx / SPA boot: return 200 + prMode:false instead of
		// 404 so local review mode doesn't spam the browser console with red XHR.
		// Mutating /api/gh/* routes still 404 when not in PR mode.
		if (!prMode) return c.json({ prMode: false });
		const session = await prStore.get();
		if (!session) return c.json({ prMode: false });
		return c.json({
			prMode: true,
			ref: session.ref,
			owner: session.owner,
			repo: session.repo,
			pullNumber: session.pullNumber,
			baseSha: session.baseSha,
			headSha: session.headSha,
			baseRefName: session.baseRefName,
			headRefName: session.headRefName,
			mergeBaseSha: session.mergeBaseSha,
			title: session.title,
			url: session.url,
			author: session.author,
			additions: session.additions,
			deletions: session.deletions,
			changedFiles: session.changedFiles,
			existingComments: session.existingComments,
			existingReviews: session.existingReviews ?? [],
			submittedAt: session.submittedAt,
			submittedReviewId: session.submittedReviewId,
			submittedReviewUrl: session.submittedReviewUrl,
			authSource: session.authSource,
			diffCompleteness: session.diffCompleteness,
			reviewBody: session.reviewBody,
			reviewDecision: session.reviewDecision,
			publication: session.publication,
			body: session.body,
			state: session.state,
			isDraft: session.isDraft,
			createdAt: session.createdAt,
			mergeable: session.mergeable,
			mergeStateStatus: session.mergeStateStatus,
			maintainerCanModify: session.maintainerCanModify,
			issueComments: session.issueComments ?? [],
			timelineEvents: session.timelineEvents ?? [],
			syncedAt: session.syncedAt,
			mergeBlockedReason: mergeBlockedReason(session),
		});
	});

	app.put("/api/gh/pr-session/review-draft", async (c) => {
		if (!prMode) return notInPrMode(c);
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		const reviewBody = typeof body.body === "string" ? body.body : undefined;
		const decision = body.decision;
		const reviewDecision =
			decision === "approve" ||
			decision === "comment" ||
			decision === "request-changes" ||
			decision === "draft"
				? decision
				: undefined;
		const session = await prStore.apply((latest) => {
			if (!latest) return null;
			return {
				...latest,
				...(reviewBody === undefined ? {} : { reviewBody }),
				...(reviewDecision === undefined ? {} : { reviewDecision }),
			};
		});
		if (!session) return notInPrMode(c);
		return c.json({
			ok: true,
			reviewBody: session.reviewBody ?? "",
			reviewDecision: session.reviewDecision ?? null,
		});
	});

	/**
	 * Serve GitHub avatars from this origin. Privacy extensions commonly block
	 * embedded githubusercontent.com requests even though the same URL works as
	 * a top-level navigation. Only URLs already supplied by the active GitHub
	 * session are accepted, which keeps this endpoint from becoming an SSRF
	 * proxy.
	 */
	app.get("/api/gh/avatar", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const url = c.req.query("url");
		if (!url || !collectPrAvatarUrls(session).has(url)) {
			return c.json({ error: "Avatar URL is not part of this PR session" }, 403);
		}
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return c.json({ error: "Invalid avatar URL" }, 400);
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			return c.json({ error: "Invalid avatar URL protocol" }, 400);
		}
		try {
			const response = await fetch(parsed, { redirect: "error" });
			if (!response.ok)
				return c.json(
					{ error: `Avatar request failed with HTTP ${response.status}` },
					502,
				);
			const contentType =
				response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
			if (!contentType.startsWith("image/")) {
				return c.json({ error: "Avatar response was not an image" }, 502);
			}
			const declaredLength = Number(response.headers.get("content-length") ?? "0");
			if (declaredLength > MAX_AVATAR_BYTES)
				return c.json({ error: "Avatar is too large" }, 413);
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength > MAX_AVATAR_BYTES)
				return c.json({ error: "Avatar is too large" }, 413);
			return new Response(bytes, {
				headers: {
					"Content-Type": contentType,
					"Cache-Control": "private, max-age=3600",
					"X-Content-Type-Options": "nosniff",
				},
			});
		} catch (error: any) {
			return c.json({ error: error?.message ?? "Failed to load avatar" }, 502);
		}
	});

	/** Slim PR metadata for agents — no threads, reviews, or patch. */
	app.get("/api/gh/overview", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		return c.json(buildPrOverviewPayload(session));
	});

	/**
	 * Paged published review threads. Prefer this over /api/gh/session for agents.
	 * Query: unresolvedOnly, path, author, cursor, limit, bodyMaxChars, fullBody, format=xml|json
	 */
	app.get("/api/gh/threads", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const page = paginatePrThreads(session, {
			unresolvedOnly:
				c.req.query("unresolvedOnly") === "true" ||
				c.req.query("unresolved") === "1",
			path: c.req.query("path") ?? undefined,
			author: c.req.query("author") ?? undefined,
			cursor: parseUInt(c.req.query("cursor"), 0),
			limit: parseUInt(c.req.query("limit"), 50),
			bodyMaxChars: parseUInt(c.req.query("bodyMaxChars"), 500),
			fullBody:
				c.req.query("fullBody") === "true" || c.req.query("fullBody") === "1",
			replyCursor: parseUInt(c.req.query("replyCursor"), 0),
			replyLimit: parseUInt(c.req.query("replyLimit"), 20),
		});
		const format = (c.req.query("format") ?? "json").toLowerCase();
		if (format === "xml") {
			c.header("Content-Type", "application/xml; charset=utf-8");
			return c.body(formatPrReviewThreads(session, page.threads, undefined, page));
		}
		return c.json(page);
	});

	/** Paged submitted review verdicts / overall comments. */
	app.get("/api/gh/reviews", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const page = paginatePrReviews(session, {
			cursor: parseUInt(c.req.query("cursor"), 0),
			limit: parseUInt(c.req.query("limit"), 50),
			bodyMaxChars: parseUInt(c.req.query("bodyMaxChars"), 500),
			fullBody:
				c.req.query("fullBody") === "true" || c.req.query("fullBody") === "1",
			state: c.req.query("state") ?? undefined,
		});
		const format = (c.req.query("format") ?? "json").toLowerCase();
		if (format === "xml") {
			c.header("Content-Type", "application/xml; charset=utf-8");
			return c.body(formatPrReviews(session, page.reviews, page));
		}
		return c.json(page);
	});

	app.get("/api/gh/timeline", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const page = paginatePrTimeline(session, {
			cursor: parseUInt(c.req.query("cursor"), 0),
			limit: parseUInt(c.req.query("limit"), 30),
		});
		return c.json({
			...page,
			headSha: session.headSha,
			syncedAt: session.syncedAt ?? null,
			body: session.body ?? "",
			state: session.state ?? null,
		});
	});

	app.post("/api/gh/reviews/:id/submit", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const reviewId = Number(c.req.param("id"));
		if (!Number.isFinite(reviewId))
			return c.json({ error: "Invalid review id" }, 400);
		const pending = (session.existingReviews ?? []).find(
			(review) => review.id === reviewId && review.state === "PENDING",
		);
		if (!pending) return c.json({ error: "No pending review with that id" }, 404);
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		const event =
			body.event === "APPROVE" ||
			body.event === "REQUEST_CHANGES" ||
			body.event === "COMMENT"
				? body.event
				: null;
		if (!event) {
			return c.json(
				{ error: "event must be APPROVE, REQUEST_CHANGES, or COMMENT" },
				400,
			);
		}
		const note = typeof body.body === "string" ? body.body : undefined;
		const attachDrafts = body.attachDrafts !== false;
		const resolved = resolvedFromSession(session);
		const classified = classifyPrComments(session.comments ?? []);
		if (attachDrafts) {
			const inline = expandMultiLineComments(session.comments ?? []);
			if (inline.length > 0) {
				const attached = await addCommentsToPendingReviewViaGh(
					resolved,
					reviewId,
					inline,
				);
				if (!attached.ok) {
					return c.json(
						{ error: attached.error ?? "Failed to attach draft comments" },
						502,
					);
				}
			}
		}
		const payload = buildReviewPayload({
			decision:
				event === "APPROVE"
					? "approve"
					: event === "REQUEST_CHANGES"
						? "request-changes"
						: "comment",
			body: note ?? "",
			comments: attachDrafts ? classified.fileLevel : [],
		});
		const result = await submitPendingReviewViaGh(
			resolved,
			reviewId,
			event,
			payload.body,
		);
		if (!result.ok)
			return c.json({ error: result.error ?? "Submit failed" }, 502);
		const existingReviews = (session.existingReviews ?? []).map((review) =>
			review.id === reviewId
				? {
						...review,
						state:
							event === "APPROVE"
								? ("APPROVED" as const)
								: event === "REQUEST_CHANGES"
									? ("CHANGES_REQUESTED" as const)
									: ("COMMENTED" as const),
						body: note ?? review.body,
						submittedAt: new Date().toISOString(),
						htmlUrl: result.htmlUrl ?? review.htmlUrl,
					}
				: review,
		);
		const submittedIds = new Set(
			attachDrafts
				? [...classified.inline, ...classified.fileLevel].map(
						(comment) => comment.id,
					)
				: [],
		);
		await prStore.apply((latest) =>
			latest
				? {
						...latest,
						existingReviews,
						comments: attachDrafts
							? (latest.comments ?? []).filter(
									(comment) => !submittedIds.has(comment.id),
								)
							: latest.comments,
					}
				: null,
		);
		return c.json({ ok: true, reviewId, htmlUrl: result.htmlUrl });
	});

	app.delete("/api/gh/reviews/:id", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const reviewId = Number(c.req.param("id"));
		if (!Number.isFinite(reviewId))
			return c.json({ error: "Invalid review id" }, 400);
		const pending = (session.existingReviews ?? []).find(
			(review) => review.id === reviewId && review.state === "PENDING",
		);
		if (!pending) return c.json({ error: "No pending review with that id" }, 404);
		const result = await deletePendingReviewViaGh(
			resolvedFromSession(session),
			reviewId,
		);
		if (!result.ok)
			return c.json({ error: result.error ?? "Discard failed" }, 502);
		await prStore.apply((latest) => {
			if (!latest) return null;
			return {
				...latest,
				existingReviews: (latest.existingReviews ?? []).filter(
					(review) => review.id !== reviewId,
				),
			};
		});
		return c.json({ ok: true, reviewId });
	});

	/** Attach local draft comments onto an existing PENDING GitHub review. */
	app.post("/api/gh/reviews/:id/comments", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const reviewId = Number(c.req.param("id"));
		if (!Number.isFinite(reviewId))
			return c.json({ error: "Invalid review id" }, 400);
		const pending = findPendingReview(session.existingReviews, reviewId);
		if (!pending) return c.json({ error: "No pending review with that id" }, 404);
		const inline = expandMultiLineComments(session.comments ?? []);
		if (inline.length === 0) {
			return c.json({ ok: true, reviewId, attached: 0, failed: 0 });
		}
		const result = await addCommentsToPendingReviewViaGh(
			resolvedFromSession(session),
			reviewId,
			inline,
		);
		if (!result.ok)
			return c.json({ error: result.error ?? "Resume failed" }, 502);
		const attachedIds = new Set(
			(session.comments ?? [])
				.filter((comment) => comment.status === "open" && comment.lineNumber !== 0)
				.map((comment) => comment.id),
		);
		await prStore.apply((latest) =>
			latest
				? {
						...latest,
						comments: (latest.comments ?? []).filter(
							(comment) => !attachedIds.has(comment.id),
						),
					}
				: null,
		);
		return c.json({
			ok: true,
			reviewId,
			attached: result.attached,
			failed: result.failed,
		});
	});

	/**
	 * Merge the GitHub-fetched existing comments into the *current* session's
	 * optimistic state. The reply endpoint optimistically appends a new reply to
	 * a thread before GitHub has propagated it through the REST comments API
	 * (a noticeable window during the periodic 30s / window-focus sync). A naive
	 * overwrite would make that reply flash out of the UI until the next sync
	 * catches up — which is what users reported as "comments disappear after
	 * submitting a reply" (especially visible on file-level threads because
	 * those bubbles live in their own section and a missing one is striking).
	 *
	 * Strategy: take fresh-from-GitHub replies as authoritative for ids GitHub
	 * already knows about, then re-append any optimistic local replies that
	 * haven't yet appeared on GitHub (tracked via {@link PrSession.pendingOptimisticReplyIds}).
	 * Replies GitHub no longer returns AND that aren't optimistic are dropped
	 * (a real delete). Optimistic ids that do show up are confirmed and pruned
	 * from the pending list.
	 */
	const mergeFreshWithLocalOptimistic = (
		fresh: PrExistingComment[],
		current: PrExistingComment[] | undefined,
		pendingIds: number[],
	): { existingComments: PrExistingComment[]; remainingPending: number[] } => {
		const pending = new Set(pendingIds);
		const localById = new Map<number, PrExistingComment>();
		for (const c of current ?? []) localById.set(c.id, c);
		const remainingPending: number[] = [];
		const existingComments = fresh.map((freshTop) => {
			const local = localById.get(freshTop.id);
			if (!local) return freshTop;
			const freshReplyIds = new Set(freshTop.replies.map((r) => r.id));
			// GitHub confirms replies that matched by id — drop them from the pending list.
			for (const id of freshReplyIds) pending.delete(id);
			const preserved: PrExistingReply[] = [];
			if (pending.size > 0) {
				for (const r of local.replies) {
					if (freshReplyIds.has(r.id)) continue;
					if (pending.has(r.id)) {
						// Local optimistic copy — GitHub hasn't returned it yet. Keep it so
						// the UI doesn't see the reply disappear between syncs.
						preserved.push(r);
						// Keep tracking it until a fresh fetch confirms it.
						remainingPending.push(r.id);
					}
					// Otherwise this is a reply GitHub has dropped (real delete). Let it go.
				}
			}
			if (preserved.length === 0) return freshTop;
			// Reply ordering: GitHub's listing is already chronological; preserve that
			// and append optimistic replies (their createdAt is recent) at the end.
			const replies = [...freshTop.replies, ...preserved];
			return { ...freshTop, replies };
		});
		return { existingComments, remainingPending };
	};

	const syncExistingPrReviewData = async (
		session: NonNullable<Awaited<ReturnType<PrSessionStore["get"]>>>,
	) => {
		const resolved = resolvedFromSession(session);
		let existingReviews = await fetchExistingReviewsViaGh(resolved);
		const optimisticReview =
			session.submittedReviewId == null
				? undefined
				: session.existingReviews?.find(
						(review) => review.id === session.submittedReviewId,
					);
		if (
			optimisticReview &&
			!existingReviews.some((review) => review.id === optimisticReview.id) &&
			session.submittedAt != null &&
			Date.now() - session.submittedAt < 120_000
		) {
			existingReviews = [optimisticReview, ...existingReviews];
		}
		const freshExistingComments = await fetchExistingCommentsViaGh(
			resolved,
			existingReviews,
		);
		// Re-read the session right before writing. Optimistic merges from the
		// reply endpoint (or draft writes) that landed during the slow GitHub
		// fetch above must not be silently overwritten. The draft `comments`
		// filter and any optimistic reviews come from this current snapshot.
		const current = (await prStore.get()) ?? session;
		const { existingComments, remainingPending } = mergeFreshWithLocalOptimistic(
			freshExistingComments,
			current.existingComments,
			current.pendingOptimisticReplyIds ?? [],
		);
		const comments = current.submittedAt
			? (current.comments ?? []).filter(
					(comment) => comment.createdAt > current.submittedAt!,
				)
			: current.comments;
		let issueComments = current.issueComments ?? [];
		let timelineEvents = current.timelineEvents ?? [];
		try {
			const convo = await fetchPrConversationViaGh(resolved);
			issueComments = convo.issueComments;
			timelineEvents = convo.timelineEvents;
		} catch {
			// Keep last-known conversation on a timeline fetch outage.
		}
		const next = {
			...current,
			comments,
			existingComments,
			existingReviews,
			issueComments,
			timelineEvents,
			syncedAt: Date.now(),
		};
		if (remainingPending.length > 0)
			next.pendingOptimisticReplyIds = remainingPending;
		else delete next.pendingOptimisticReplyIds;
		await prStore.set(next);
		return next;
	};

	/** Lightweight bidirectional comment sync (without re-fetching the whole diff). */
	app.post("/api/gh/comments/sync", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		try {
			const next = await syncExistingPrReviewData(session);
			return c.json({ ok: true, count: next.existingComments.length });
		} catch (error: any) {
			return c.json(
				{ error: error?.message ?? "Failed to sync GitHub comments" },
				502,
			);
		}
	});

	/** Re-fetch PR metadata (head SHA, diff, existing comments) and persist. */
	app.post("/api/gh/pr/refresh", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		try {
			const refreshed = await refreshPrSession(session);
			const next = await prStore.apply((current) => {
				const drafts = current?.comments ?? refreshed.comments;
				const comments = refreshed.submittedAt
					? drafts.filter((comment) => comment.createdAt > refreshed.submittedAt!)
					: drafts;
				return { ...refreshed, comments };
			});
			const persisted = next ?? refreshed;
			const viewed = await viewedStore.reconcile(
				viewedScopeKey(persisted, true),
				persisted.headSha,
				fingerprintsForPatch(persisted.diff ?? ""),
			);
			broadcast("viewed", JSON.stringify(viewed));
			return c.json({ ok: true, headSha: persisted.headSha });
		} catch (err: any) {
			return c.json({ error: err?.message ?? "Refresh failed" }, 500);
		}
	});

	/** CI / check-runs status for the PR head. */
	app.get("/api/gh/checks", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		try {
			const { fetchPrChecks } = await import("./lib/github.js");
			const checks = await fetchPrChecks(
				resolvedFromSession(session),
				session.headSha,
			);
			const summary = {
				total: checks.length,
				success: checks.filter((x) => x.state === "success").length,
				failure: checks.filter((x) => x.state === "failure" || x.state === "error")
					.length,
				pending: checks.filter((x) => x.state === "pending").length,
			};
			return c.json({ checks, summary, headSha: session.headSha });
		} catch (err: any) {
			return c.json(
				{
					error: err?.message ?? "Failed to fetch checks",
					checks: [],
					summary: null,
				},
				500,
			);
		}
	});

	/** Reply to an existing GitHub review comment thread. */
	app.post("/api/gh/existing-comments/:id/replies", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const id = Number(c.req.param("id"));
		if (!Number.isFinite(id)) return c.json({ error: "Invalid comment id" }, 400);
		const body = (await c.req.json().catch(() => ({}))) as { body?: string };
		const text = typeof body.body === "string" ? body.body.trim() : "";
		if (!text) return c.json({ error: "body is required" }, 400);
		try {
			const { replyToPrComment } = await import("./lib/github.js");
			const result = await replyToPrComment({
				resolved: resolvedFromSession(session),
				inReplyTo: id,
				body: text,
			});
			if (!result.ok)
				return c.json({ error: result.error ?? "Reply failed" }, 500);
			// GitHub returns the created reply. Merge it into the cached thread
			// immediately instead of doing a second, slower metadata round-trip.
			// The client can now re-fetch the session and render the reply at once.
			//
			// The URL `:id` is normally the top-level comment id (the UI passes
			// `comment.id` from the bubble). GitHub's REST `in_reply_to` semantics
			// accept any id in the thread, so the same `:id` is forwarded verbatim.
			// We additionally accept an id that points at any existing reply in the
			// thread — the merge attaches to whichever thread owns that id, so the
			// optimistic update lands even if callers ever use a reply id.
			const reply = result.reply;
			if (reply) {
				const existingComments = session.existingComments.map((comment) =>
					comment.id === id || comment.replies.some((r) => r.id === id)
						? { ...comment, replies: [...comment.replies, reply] }
						: comment,
				);
				// Track the new reply id so the next `syncExistingPrReviewData`
				// preserves it across the GitHub propagation window (otherwise the
				// fresh GitHub fetch wouldn't yet include it and would clobber the
				// optimistic copy — making the reply "disappear" in the UI).
				const pendingOptimisticReplyIds = [
					...(session.pendingOptimisticReplyIds ?? []),
					...(typeof result.id === "number" ? [result.id] : []),
				];
				await prStore.set({
					...session,
					existingComments,
					pendingOptimisticReplyIds,
				});
			}
			return c.json({ ok: true, id: result.id, reply });
		} catch (err: any) {
			return c.json({ error: err?.message ?? "Reply failed" }, 500);
		}
	});

	/** Edit any published review comment or reply. */
	app.patch("/api/gh/existing-comments/:id", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const id = Number(c.req.param("id"));
		if (!Number.isFinite(id)) return c.json({ error: "Invalid comment id" }, 400);
		const request = (await c.req.json().catch(() => ({}))) as { body?: string };
		const text = typeof request.body === "string" ? request.body.trim() : "";
		if (!text) return c.json({ error: "body is required" }, 400);
		const result = await updatePrReviewComment({
			resolved: resolvedFromSession(session),
			commentId: id,
			body: text,
		});
		if (!result.ok) return c.json({ error: result.error ?? "Edit failed" }, 502);
		const next = await syncExistingPrReviewData(session);
		return c.json({ ok: true, existingComments: next.existingComments });
	});

	/** Delete any published review comment or reply. */
	app.delete("/api/gh/existing-comments/:id", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const id = Number(c.req.param("id"));
		if (!Number.isFinite(id)) return c.json({ error: "Invalid comment id" }, 400);
		const result = await deletePrReviewComment({
			resolved: resolvedFromSession(session),
			commentId: id,
		});
		if (!result.ok)
			return c.json({ error: result.error ?? "Delete failed" }, 502);
		const next = await syncExistingPrReviewData(session);
		return c.json({ ok: true, existingComments: next.existingComments });
	});

	app.post("/api/gh/existing-comments/:id/apply-suggestion", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const commentId = Number(c.req.param("id"));
		const comment = (session.existingComments ?? []).find(
			(item) => item.id === commentId,
		);
		if (!comment) return c.json({ error: "Comment not found" }, 404);
		const body = (await c.req.json().catch(() => ({}))) as {
			expectedHeadSha?: string;
			dryRun?: boolean;
		};
		const expectedHeadSha = body.expectedHeadSha || session.headSha;
		if (expectedHeadSha !== session.headSha) {
			return c.json(
				{
					error: "expectedHeadSha does not match the reviewed head",
					headSha: session.headSha,
				},
				409,
			);
		}
		if (!session.headRefName) {
			return c.json({ error: "PR head branch is unknown" }, 400);
		}
		const forkHead =
			(session.headOwner != null && session.headOwner !== session.owner) ||
			(session.headRepo != null && session.headRepo !== session.repo);
		if (forkHead && session.maintainerCanModify === false) {
			return c.json({ error: "Maintainer cannot push to the head branch" }, 403);
		}
		if (body.dryRun === true) {
			return c.json({
				ok: true,
				dryRun: true,
				path: comment.path,
				expectedHeadSha,
			});
		}
		const result = await applyPrSuggestionViaGh({
			resolved: resolvedFromSession(session),
			path: comment.path,
			body: comment.body,
			line: comment.line ?? 0,
			startLine: comment.startLine,
			side: comment.side,
			expectedHeadSha,
			headRefName: session.headRefName,
			headOwner: session.headOwner,
			headRepo: session.headRepo,
		});
		if (!result.ok) {
			const status = /moved|mismatch|409/i.test(result.error ?? "") ? 409 : 502;
			return c.json({ error: result.error ?? "Apply failed" }, status);
		}
		return c.json({ ok: true, sha: result.sha, path: comment.path });
	});

	/** Resolve or reopen a published GitHub review thread. */
	app.put("/api/gh/review-threads/:threadId", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const threadId = c.req.param("threadId");
		const request = (await c.req.json().catch(() => ({}))) as {
			resolved?: boolean;
		};
		if (typeof request.resolved !== "boolean")
			return c.json({ error: "resolved must be a boolean" }, 400);
		const result = await setPrReviewThreadResolved({
			threadId,
			resolved: request.resolved,
			host: session.host,
		});
		if (!result.ok)
			return c.json({ error: result.error ?? "Thread update failed" }, 502);
		const next = await syncExistingPrReviewData(session);
		return c.json({ ok: true, existingComments: next.existingComments });
	});

	/** Initialize a PR session from a ref like `1234`, `o/r#42`, or a GitHub URL. */
	app.post("/api/gh/pr/init", async (c) => {
		if (!prMode) return notInPrMode(c);
		const body = await c.req.json().catch(() => ({}));
		const ref = typeof body?.ref === "string" ? body.ref : "";
		if (!ref.trim()) {
			return c.json({ error: "ref is required" }, 400);
		}
		try {
			// Build via gh.
			const session = await buildPrSession(ref);
			await prStore.set(session);
			// Re-resolve in case the user wanted the current cwd's owner for a bare number
			// (already done inside buildPrSession).
			return c.json({
				ok: true,
				ref: session.ref,
				owner: session.owner,
				repo: session.repo,
				pullNumber: session.pullNumber,
				url: session.url,
			});
		} catch (err: any) {
			return c.json(
				{ error: err?.message ?? "Failed to initialise PR session" },
				500,
			);
		}
	});

	app.patch("/api/gh/pr", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const body = (await c.req.json().catch(() => ({}))) as {
			title?: string;
			body?: string;
			dryRun?: boolean;
		};
		if (body.dryRun === true) {
			return c.json({
				ok: true,
				dryRun: true,
				title: body.title ?? session.title,
				body: body.body ?? session.body ?? "",
			});
		}
		const result = await updatePrMetadataViaGh(resolvedFromSession(session), {
			title: body.title,
			body: body.body,
		});
		if (!result.ok)
			return c.json({ error: result.error ?? "Update failed" }, 502);
		const next = await prStore.apply((latest) =>
			latest
				? {
						...latest,
						...(typeof body.title === "string" ? { title: body.title } : {}),
						...(typeof body.body === "string" ? { body: body.body } : {}),
					}
				: null,
		);
		return c.json({
			ok: true,
			title: next?.title ?? session.title,
			body: next?.body ?? session.body ?? "",
		});
	});

	const setPrOpenState = async (
		c: any,
		state: "open" | "closed",
		dryRun: boolean,
	) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		if (dryRun) return c.json({ ok: true, dryRun: true, state });
		const result = await setPrOpenStateViaGh(resolvedFromSession(session), state);
		if (!result.ok)
			return c.json({ error: result.error ?? "Update failed" }, 502);
		await prStore.apply((latest) =>
			latest ? { ...latest, state: state === "closed" ? "closed" : "open" } : null,
		);
		return c.json({ ok: true, state });
	};

	app.post("/api/gh/pr/close", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { dryRun?: boolean };
		return setPrOpenState(c, "closed", body.dryRun === true);
	});

	app.post("/api/gh/pr/reopen", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { dryRun?: boolean };
		return setPrOpenState(c, "open", body.dryRun === true);
	});

	app.post("/api/gh/pr/merge", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const body = (await c.req.json().catch(() => ({}))) as {
			method?: string;
			expectedHeadSha?: string;
			dryRun?: boolean;
			commitTitle?: string;
			commitMessage?: string;
		};
		const method =
			body.method === "squash" ||
			body.method === "rebase" ||
			body.method === "merge"
				? body.method
				: "merge";
		const expectedHeadSha = body.expectedHeadSha || session.headSha;
		if (expectedHeadSha !== session.headSha) {
			return c.json(
				{
					error: "expectedHeadSha does not match the reviewed head",
					headSha: session.headSha,
				},
				409,
			);
		}
		const blocked = mergeBlockedReason(session);
		if (blocked) return c.json({ error: blocked }, 409);
		if (body.dryRun === true) {
			return c.json({
				ok: true,
				dryRun: true,
				method,
				expectedHeadSha,
			});
		}
		const result = await mergePullRequestViaGh(resolvedFromSession(session), {
			method,
			expectedHeadSha,
			commitTitle: body.commitTitle,
			commitMessage: body.commitMessage,
		});
		if (!result.ok) return c.json({ error: result.error ?? "Merge failed" }, 502);
		await prStore.apply((latest) =>
			latest ? { ...latest, state: "merged" } : null,
		);
		return c.json({ ok: true, sha: result.sha, method });
	});

	// PR-mode comments live inside `pr-session.json`. The UI calls these instead
	// of the `/api/comments` family when `prMode === true`.
	app.get("/api/gh/pr-session/comments", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		return c.json(session.comments ?? []);
	});

	app.post("/api/gh/pr-session/comments", async (c) => {
		if (!prMode) return notInPrMode(c);
		const body = await c.req.json();
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const severityRaw = body.severity as string | undefined;
		const severity =
			severityRaw === "blocking" ||
			severityRaw === "nit" ||
			severityRaw === "question" ||
			severityRaw === "praise" ||
			severityRaw === "none"
				? severityRaw === "none"
					? undefined
					: severityRaw
				: undefined;
		const comment: ReviewComment = {
			id: crypto.randomUUID(),
			filePath: body.filePath,
			side: body.side,
			lineNumber: body.lineNumber,
			startLineNumber: body.startLineNumber,
			lineContent: body.lineContent,
			body: body.body,
			status: "open",
			createdAt: Date.now(),
			replies: [],
			...(severity ? { severity } : {}),
		};
		const next = await prStore.apply((current) => {
			if (!current) return null;
			return {
				...current,
				comments: [...(current.comments ?? []), comment],
			};
		});
		if (!next) return notInPrMode(c);
		return c.json(comment, 201);
	});

	app.put("/api/gh/pr-session/comments/:id", async (c) => {
		if (!prMode) return notInPrMode(c);
		const id = c.req.param("id");
		const { body, status } = await c.req.json();
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const comments = (session.comments ?? []).map((cm) =>
			cm.id === id
				? { ...cm, body: body ?? cm.body, status: status ?? cm.status }
				: cm,
		);
		await prStore.set({ ...session, comments });
		const updated = comments.find((cm) => cm.id === id) ?? null;
		if (!updated) return c.json({ error: "Comment not found" }, 404);
		return c.json(updated);
	});

	app.delete("/api/gh/pr-session/comments/:id", async (c) => {
		if (!prMode) return notInPrMode(c);
		const id = c.req.param("id");
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const comments = (session.comments ?? []).filter((cm) => cm.id !== id);
		await prStore.set({ ...session, comments });
		return c.json({ ok: true });
	});

	app.post("/api/gh/pr-session/comments/:id/replies", async (c) => {
		if (!prMode) return notInPrMode(c);
		const id = c.req.param("id");
		const { body, role, model } = await c.req.json();
		const text = typeof body === "string" ? body.trim() : "";
		if (!text) return c.json({ error: "body is required" }, 400);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		if (!(session.comments ?? []).some((cm) => cm.id === id)) {
			return c.json({ error: "Comment not found" }, 404);
		}
		const comments = (session.comments ?? []).map((cm) => {
			if (cm.id !== id) return cm;
			const reply = {
				id: crypto.randomUUID(),
				body: text,
				createdAt: Date.now(),
				role: role || (model ? "agent" : "user"),
				model: model || undefined,
			};
			return { ...cm, replies: [...(cm.replies ?? []), reply] };
		});
		await prStore.set({ ...session, comments });
		return c.json(comments.find((cm) => cm.id === id));
	});

	/** Submit the current PR session's review (new comments + verdict + body) to GitHub. */
	app.post("/api/gh/submit", async (c) => {
		if (!prMode) return notInPrMode(c);
		const session = await prStore.get();
		if (!session) return notInPrMode(c);
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		const decision = body.decision;
		if (
			decision !== "approve" &&
			decision !== "comment" &&
			decision !== "request-changes" &&
			decision !== "draft"
		) {
			return c.json(
				{
					error: "decision must be one of: approve, comment, request-changes, draft",
				},
				400,
			);
		}
		const generalBody = typeof body.body === "string" ? body.body : "";
		const dryRun = body.dryRun === true;

		// Dry-run validates and returns the payload shape without POSTing to GitHub.
		// Local attachment URLs are rewritten to placeholder raw URLs so the preview
		// matches what a real submit would publish (without uploading blobs).
		if (dryRun) {
			const { buildReviewPayload, resolvedFromSession } = await import(
				"./lib/github.js"
			);
			const { rewriteLocalAttachmentsInBodies } = await import(
				"./lib/github-attachments.js"
			);
			const resolved = resolvedFromSession(session);
			const comments = session.comments ?? [];
			const bodies = [generalBody, ...comments.map((c) => c.body ?? "")];
			const rewritten = await rewriteLocalAttachmentsInBodies(resolved, bodies, {
				dryRun: true,
			});
			if (rewritten.error) {
				return c.json({ ok: false, dryRun: true, error: rewritten.error }, 400);
			}
			const [body, ...commentBodies] = rewritten.bodies;
			const payload = buildReviewPayload({
				decision: decision as PrDecision,
				body: body ?? generalBody,
				comments: comments.map((c, i) => ({
					...c,
					body: commentBodies[i] ?? c.body,
				})),
				commitId: session.headSha,
			});
			return c.json({
				ok: true,
				dryRun: true,
				authSource: session.authSource ?? "none",
				failedComments: 0,
				payload,
				attachmentRewrites: rewritten.urlMap,
			});
		}

		if (!submitInFlight) {
			submitInFlight = (async () => {
				const current = (await prStore.get()) ?? session;
				const pendingReviewIdRaw = body.pendingReviewId;
				const pendingReviewId =
					typeof pendingReviewIdRaw === "number"
						? pendingReviewIdRaw
						: findPendingReview(current.existingReviews)?.id;
				const submittedIds = new Set(
					(current.comments ?? []).map((comment) => comment.id),
				);
				const publicationDecision = decision as PrDecision;
				await prStore.apply((latest) => {
					if (!latest) return null;
					return {
						...latest,
						reviewBody: generalBody,
						reviewDecision: publicationDecision,
						publication: {
							state: "sending",
							decision: publicationDecision,
							body: generalBody,
							updatedAt: Date.now(),
							headSha: latest.headSha,
						},
					};
				});
				const result = await githubSubmitReview({
					resolved: resolvedFromSession(current),
					decision: publicationDecision,
					body: generalBody,
					comments: current.comments ?? [],
					commitId: current.headSha,
					pendingReviewId,
				});

				if (result.ok) {
					let existingComments = current.existingComments;
					let existingReviews = current.existingReviews ?? [];
					try {
						const resolved = resolvedFromSession(current);
						existingReviews = await fetchExistingReviewsViaGh(resolved);
						existingComments = await fetchExistingCommentsViaGh(
							resolved,
							existingReviews,
						);
					} catch {
						// Submission succeeded; a later refresh/background sync can hydrate it.
					}
					if (
						result.reviewId != null &&
						!existingReviews.some((review) => review.id === result.reviewId)
					) {
						const stateByDecision: Record<PrDecision, PrExistingReview["state"]> = {
							approve: "APPROVED",
							"request-changes": "CHANGES_REQUESTED",
							comment: "COMMENTED",
							draft: "PENDING",
						};
						existingReviews = [
							{
								id: result.reviewId,
								author: null,
								body: generalBody,
								state: stateByDecision[decision as PrDecision],
								submittedAt: new Date().toISOString(),
								htmlUrl: result.reviewUrl,
								commitId: current.headSha,
							},
							...existingReviews,
						];
					}
					await prStore.apply((latest) => {
						if (!latest) return null;
						return {
							...latest,
							comments: (latest.comments ?? []).filter(
								(comment) => !submittedIds.has(comment.id),
							),
							existingComments,
							existingReviews,
							submittedAt: Date.now(),
							submittedReviewId: result.reviewId,
							submittedReviewUrl: result.reviewUrl,
							authSource: result.authSource === "none" ? undefined : result.authSource,
							publication: {
								state: result.reviewId == null ? "unknown" : "confirmed",
								decision: publicationDecision,
								body: generalBody,
								updatedAt: Date.now(),
								reviewId: result.reviewId,
								reviewUrl: result.reviewUrl,
								headSha: latest.headSha,
							},
						};
					});
				} else {
					await prStore.apply((latest) => {
						if (!latest) return null;
						return {
							...latest,
							publication: {
								state: "failed",
								decision: publicationDecision,
								body: generalBody,
								updatedAt: Date.now(),
								error: result.error,
								headSha: latest.headSha,
							},
						};
					});
				}

				return {
					ok: result.ok,
					reviewId: result.reviewId,
					reviewUrl: result.reviewUrl,
					failedComments: result.failedComments ?? 0,
					authSource: result.authSource,
					error: result.error,
					dryRun: false as const,
				};
			})().finally(() => {
				submitInFlight = null;
			});
		}
		const responseBody = await submitInFlight;
		return responseBody.ok ? c.json(responseBody) : c.json(responseBody, 502);
	});

	// ── Agent handoff: "agent waits, human releases" ──────────────────────────
	// The UI's "Send to agent" button POSTs here. We snapshot the current
	// comments, format them, and release every agent blocked on /api/review/await.
	app.post("/api/review/send", async (c) => {
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		const generalComment =
			typeof body?.generalComment === "string" ? body.generalComment : undefined;
		const decision =
			body?.decision === "approved" ||
			body?.decision === "changes-requested" ||
			body?.decision === "rejected" ||
			body?.decision === "comment-only"
				? (body.decision as ReviewDecision)
				: undefined;
		const mode =
			body?.mode === "comment-only" || body?.mode === "standard"
				? (body.mode as ReviewMode)
				: "standard";
		const force = body?.force === true;
		const all = await store.getAll();

		// Safety rail: block accidental secret leaks unless the human confirms.
		const findings = scanReviewForSecrets({ generalComment, comments: all });
		if (findings.length > 0 && !force) {
			return c.json({ ok: false, error: "secrets-detected", findings }, 400);
		}

		const openCount = all.filter((x) => x.status === "open").length;

		// Snapshot live-diff fingerprints so the next review can show
		// "files changed since last send" even after the agent rewrites the tree.
		let diffFingerprints: Record<string, string> | undefined;
		try {
			const { fingerprintDiffFiles } = await import("./lib/diff-fingerprint.js");
			if (prMode) {
				const prSession = await prStore.get();
				if (prSession?.diff) {
					diffFingerprints = fingerprintDiffFiles(prSession.diff);
				}
			} else {
				const live = await executeDiffWithMeta(diffOpts);
				if (live.patch) {
					diffFingerprints = fingerprintDiffFiles(live.patch);
				}
			}
		} catch {
			// Best-effort — handoff still succeeds without a baseline.
		}

		const payload = reviewSession.send({
			sentAt: Date.now(),
			commentXml: formatComments(all, generalComment, decision, mode),
			openCount,
			comments: all,
			decision,
			mode,
			diffFingerprints,
		});
		return c.json({
			ok: true,
			round: payload.round,
			openCount: payload.openCount,
			decision: payload.decision,
			mode: payload.mode,
			waiters: reviewSession.snapshot().waiters,
			secretsBypassed: findings.length > 0 && force,
			hasSinceLastBaseline: Boolean(
				diffFingerprints && Object.keys(diffFingerprints).length > 0,
			),
		});
	});

	// Long-poll the waiting agent blocks on. Each request stays short (≤50s) so
	// it survives proxy/keep-alive limits; the client owns the total wait budget
	// by re-polling with the `sinceRound` cursor it last saw.
	app.get("/api/review/await", async (c) => {
		const sinceRaw = c.req.query("sinceRound");
		const sinceRound =
			sinceRaw !== undefined && sinceRaw !== "" ? Number(sinceRaw) : undefined;
		const requested = Number(c.req.query("timeoutMs")) || 25000;
		const timeoutMs = Math.min(Math.max(requested, 1000), 50000);
		const result = await reviewSession.await({
			sinceRound: Number.isNaN(sinceRound as number) ? undefined : sinceRound,
			timeoutMs,
			signal: c.req.raw.signal,
		});
		return c.json(result);
	});

	app.get("/api/review/status", (c) => {
		return c.json(reviewSession.snapshot());
	});

	app.get("/api/review/history", (c) => {
		return c.json({ rounds: reviewSession.getHistory() });
	});

	/**
	 * Files that differ from the last handoff baseline (content changed or new
	 * in the live diff). Used by the "Since last" file-tree chip.
	 */
	app.get("/api/review/since-last", async (c) => {
		const previous = reviewSession.getLastDiffFingerprints();
		if (!previous) {
			return c.json({
				hasBaseline: false,
				round: reviewSession.snapshot().round,
				changed: [] as string[],
				added: [] as string[],
				removed: [] as string[],
				reviewFiles: [] as string[],
			});
		}

		let currentPatch = "";
		try {
			if (prMode) {
				const prSession = await prStore.get();
				currentPatch = prSession?.diff ?? "";
			} else {
				const live = await executeDiffWithMeta(diffOpts);
				currentPatch = live.patch ?? "";
			}
		} catch (err: any) {
			return c.json(
				{ error: err?.message ?? "Failed to compute current diff" },
				500,
			);
		}

		const { fingerprintDiffFiles, diffSinceLast, filesToReviewSinceLast } =
			await import("./lib/diff-fingerprint.js");
		const current = fingerprintDiffFiles(currentPatch);
		const delta = diffSinceLast(previous, current);
		return c.json({
			hasBaseline: true,
			round: reviewSession.snapshot().round,
			...delta,
			reviewFiles: filesToReviewSinceLast(delta),
		});
	});

	// ── Plan review ───────────────────────────────────────────────────────────
	// The same shape as the comment review, but for markdown plans an agent
	// submits before doing work. Reads/writes go through the plan store (backed by
	// plans.json, watched for live broadcasts), and the verdict is handed off via
	// the PlanReviewSession.
	app.get("/api/plans", async (c) => {
		return c.json(await plans.getAll());
	});

	app.get("/api/plans/:id", async (c) => {
		const plan = await plans.get(c.req.param("id"));
		if (!plan) return c.json({ error: "Plan not found" }, 404);
		return c.json(plan);
	});

	// List every historical version of a plan, oldest-first. Each entry
	// carries the body+title snapshot that was live at that version, so a
	// reviewer can browse what the agent submitted in v1, v2, …
	app.get("/api/plans/:id/versions", async (c) => {
		const plan = await plans.get(c.req.param("id"));
		if (!plan) return c.json({ error: "Plan not found" }, 404);
		return c.json(plan.versions ?? []);
	});

	// Return a single historical version's body (and title). The current
	// version is included — callers can pass `n = plan.version` and get the
	// same payload as a "show current" call.
	app.get("/api/plans/:id/versions/:n", async (c) => {
		const id = c.req.param("id");
		const n = Number(c.req.param("n"));
		if (!Number.isFinite(n) || n < 1) {
			return c.json({ error: "version must be a positive integer" }, 400);
		}
		const plan = await plans.get(id);
		if (!plan) return c.json({ error: "Plan not found" }, 404);
		const version = (plan.versions ?? []).find((v) => v.version === n);
		if (!version) return c.json({ error: `Version ${n} not found` }, 404);
		return c.json({
			version,
			plan: {
				id: plan.id,
				title: plan.title,
				decision: plan.decision,
				currentVersion: plan.version,
			},
		});
	});

	app.post("/api/plans", async (c) => {
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		if (typeof body.body !== "string" || !body.body.trim()) {
			return c.json({ error: "A plan body (markdown) is required" }, 400);
		}
		const title =
			typeof body.title === "string" && body.title.trim()
				? body.title.trim()
				: "Untitled plan";
		const plan = await plans.upsert({
			id: typeof body.id === "string" && body.id ? body.id : undefined,
			title,
			body: body.body,
			source: typeof body.source === "string" ? body.source : undefined,
			model: typeof body.model === "string" ? body.model : undefined,
		});
		return c.json(plan, 201);
	});

	app.put("/api/plans/:id", async (c) => {
		const id = c.req.param("id");
		const { title, body, source, model } = await c.req
			.json()
			.catch(() => ({}) as Record<string, unknown>);
		const updated = await plans.update(id, {
			title: typeof title === "string" ? title : undefined,
			body: typeof body === "string" ? body : undefined,
			source: typeof source === "string" ? source : undefined,
			model: typeof model === "string" ? model : undefined,
		});
		if (!updated) return c.json({ error: "Plan not found" }, 404);
		return c.json(updated);
	});

	app.delete("/api/plans/:id", async (c) => {
		const removed = await plans.remove(c.req.param("id"));
		if (!removed) return c.json({ error: "Plan not found" }, 404);
		return c.json({ ok: true });
	});

	app.post("/api/plans/:id/comments", async (c) => {
		const planId = c.req.param("id");
		const plan = await plans.get(planId);
		if (!plan) return c.json({ error: "Plan not found" }, 404);
		const body = await c.req.json();
		const lineNumber = Number.isFinite(body.lineNumber)
			? Number(body.lineNumber)
			: 0;
		const startLineNumber = Number.isFinite(body.startLineNumber)
			? Number(body.startLineNumber)
			: undefined;
		const anchorStart = startLineNumber ?? lineNumber;
		const lineContent =
			typeof body.lineContent === "string" && body.lineContent
				? body.lineContent
				: lineNumber > 0
					? extractPlanLines(plan.body, anchorStart, lineNumber)
					: "";
		const sectionTitle =
			typeof body.sectionTitle === "string" && body.sectionTitle
				? body.sectionTitle
				: lineNumber > 0
					? sectionTitleForLine(plan.body, anchorStart)
					: undefined;
		// Stamp the version the comment is anchored to. The client may pass an
		// explicit value (e.g. when commenting on a historical version in the
		// viewer), but the server's value is authoritative.
		const createdAtPlanVersion = Number.isFinite(body.createdAtPlanVersion)
			? Number(body.createdAtPlanVersion)
			: plan.version;
		const selectedQuote =
			typeof body.selectedQuote === "string" && body.selectedQuote.trim()
				? body.selectedQuote.trim()
				: undefined;
		const severityRaw = body.severity;
		const severity =
			severityRaw === "blocking" ||
			severityRaw === "nit" ||
			severityRaw === "question" ||
			severityRaw === "praise" ||
			severityRaw === "none"
				? severityRaw
				: undefined;
		const comment = {
			id: crypto.randomUUID(),
			lineNumber,
			startLineNumber,
			lineContent,
			selectedQuote,
			sectionTitle,
			body: body.body,
			status: "open" as const,
			createdAt: Date.now(),
			createdAtPlanVersion,
			replies: [],
			...(severity && severity !== "none" ? { severity } : {}),
		};
		const updated = await plans.addComment(planId, comment);
		if (!updated) return c.json({ error: "Plan not found" }, 404);
		return c.json(updated, 201);
	});

	app.put("/api/plans/:id/comments/:commentId", async (c) => {
		const { body, status } = await c.req.json();
		const updated = await plans.updateComment(
			c.req.param("id"),
			c.req.param("commentId"),
			{ body, status },
		);
		if (!updated) return c.json({ error: "Plan or comment not found" }, 404);
		return c.json(updated);
	});

	app.delete("/api/plans/:id/comments/:commentId", async (c) => {
		const updated = await plans.removeComment(
			c.req.param("id"),
			c.req.param("commentId"),
		);
		if (!updated) return c.json({ error: "Plan or comment not found" }, 404);
		return c.json(updated);
	});

	app.post("/api/plans/:id/comments/:commentId/replies", async (c) => {
		const { body, role, model } = await c.req.json();
		const reply = {
			id: crypto.randomUUID(),
			body,
			createdAt: Date.now(),
			role: role || (model ? "agent" : "user"),
			model: model || undefined,
		};
		const updated = await plans.addReply(
			c.req.param("id"),
			c.req.param("commentId"),
			reply,
		);
		if (!updated) return c.json({ error: "Plan or comment not found" }, 404);
		return c.json(updated);
	});

	app.put("/api/plans/:id/comments/:commentId/replies/:replyId", async (c) => {
		const { body } = await c.req.json();
		if (!body) return c.json({ error: "Body is required" }, 400);
		const updated = await plans.updateReply(
			c.req.param("id"),
			c.req.param("commentId"),
			c.req.param("replyId"),
			body,
		);
		if (!updated)
			return c.json({ error: "Plan, comment, or reply not found" }, 404);
		return c.json(updated);
	});

	app.delete(
		"/api/plans/:id/comments/:commentId/replies/:replyId",
		async (c) => {
			const updated = await plans.removeReply(
				c.req.param("id"),
				c.req.param("commentId"),
				c.req.param("replyId"),
			);
			if (!updated)
				return c.json({ error: "Plan, comment, or reply not found" }, 404);
			return c.json(updated);
		},
	);

	// The human's verdict. Persists the decision on the plan AND releases every
	// agent blocked on /api/plan-review/await with the full review payload.
	app.post("/api/plans/:id/decision", async (c) => {
		const planId = c.req.param("id");
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		const decision = body.decision as PlanDecision;
		if (
			decision !== "approved" &&
			decision !== "rejected" &&
			decision !== "changes-requested" &&
			decision !== "comment-only"
		) {
			return c.json(
				{
					error:
						"decision must be one of: approved, rejected, changes-requested, comment-only",
				},
				400,
			);
		}
		const decisionComment =
			typeof body.decisionComment === "string" ? body.decisionComment : undefined;
		const mode =
			body?.mode === "comment-only" || body?.mode === "standard"
				? (body.mode as PlanMode)
				: "standard";
		const plan = await plans.setDecision(planId, decision, decisionComment);
		if (!plan) return c.json({ error: "Plan not found" }, 404);

		const openCommentCount = (plan.comments ?? []).filter(
			(x) => x.status === "open",
		).length;
		const payload = planReviewSession.decide({
			sentAt: Date.now(),
			planId,
			decision,
			decisionComment: plan.decisionComment,
			reviewXml: formatPlanReview(plan, { mode }),
			openCommentCount,
			plan,
			mode,
		});
		return c.json({
			ok: true,
			round: payload.round,
			decision,
			mode: payload.mode,
			openCommentCount,
			waiters: planReviewSession.snapshot().waiters,
		});
	});

	app.get("/api/plan-review/await", async (c) => {
		const sinceRaw = c.req.query("sinceRound");
		const sinceRound =
			sinceRaw !== undefined && sinceRaw !== "" ? Number(sinceRaw) : undefined;
		const requested = Number(c.req.query("timeoutMs")) || 25000;
		const timeoutMs = Math.min(Math.max(requested, 1000), 50000);
		const result = await planReviewSession.await({
			sinceRound: Number.isNaN(sinceRound as number) ? undefined : sinceRound,
			timeoutMs,
			signal: c.req.raw.signal,
		});
		return c.json(result);
	});

	app.get("/api/plan-review/status", (c) => {
		return c.json(planReviewSession.snapshot());
	});

	async function resolveDesignSystem(
		id?: string | null,
		revision?: number,
	): Promise<DesignSystem | null> {
		if (!id) return designSystems.getDefault();
		const system = await designSystems.get(id);
		if (!system) return null;
		if (revision && system.revisions?.length) {
			const snap = system.revisions.find((r) => r.revision === revision);
			if (snap) {
				return {
					...system,
					revision: snap.revision,
					status: snap.status,
					title: snap.title,
					tokens: snap.tokens,
					guidelines: snap.guidelines,
					components: snap.components,
					sources: snap.sources,
				};
			}
		}
		return system;
	}

	// ── Design system (per-repo, lives next to mockups) ──────────────────────
	app.get("/api/design-systems", async (c) => {
		return c.json(await designSystems.getAll());
	});

	app.get("/api/design-systems/default", async (c) => {
		const system = await designSystems.getDefault();
		if (!system) return c.json({ error: "No design system" }, 404);
		return c.json(system);
	});

	app.get("/api/design-systems/:id", async (c) => {
		const system = await designSystems.get(c.req.param("id"));
		if (!system) return c.json({ error: "Design system not found" }, 404);
		return c.json(system);
	});

	app.post("/api/design-systems", async (c) => {
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		const system = await designSystems.upsert({
			id: typeof body.id === "string" ? body.id : DEFAULT_DESIGN_SYSTEM_ID,
			title: typeof body.title === "string" ? body.title : undefined,
			tokens: body.tokens as never,
			guidelines:
				typeof body.guidelines === "string" ? body.guidelines : undefined,
			sources: Array.isArray(body.sources) ? (body.sources as never) : undefined,
			status: body.status === "published" ? "published" : "draft",
		});
		broadcast("design-system", Date.now().toString());
		return c.json(system, 201);
	});

	app.put("/api/design-systems/:id", async (c) => {
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		const existing = await designSystems.get(c.req.param("id"));
		if (!existing) return c.json({ error: "Design system not found" }, 404);
		const system = await designSystems.propose(c.req.param("id"), {
			title: typeof body.title === "string" ? body.title : undefined,
			tokens: body.tokens as never,
			guidelines:
				typeof body.guidelines === "string" ? body.guidelines : undefined,
			components: Array.isArray(body.components)
				? (body.components as never)
				: undefined,
			sources: Array.isArray(body.sources) ? (body.sources as never) : undefined,
		});
		broadcast("design-system", Date.now().toString());
		return c.json(system);
	});

	app.post("/api/design-systems/:id/publish", async (c) => {
		const system = await designSystems.publish(c.req.param("id"));
		if (!system) return c.json({ error: "Design system not found" }, 404);
		broadcast("design-system", Date.now().toString());
		return c.json(system);
	});

	app.post("/api/design-systems/:id/extract", async (c) => {
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		const from = typeof body.from === "string" ? body.from : "css";
		let extracted;
		if (from === "text" && typeof body.text === "string") {
			extracted = {
				tokens: extractTokensFromText(body.text),
				sources: [{ kind: "css-vars" as const, path: "paste" }],
				files: [],
			};
		} else if (from === "url" && typeof body.url === "string") {
			const url = body.url;
			if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url)) {
				return c.json(
					{ error: "Capture URL must be a local http(s) address" },
					400,
				);
			}
			const res = await fetch(url).catch(() => null);
			const text = res && res.ok ? await res.text() : "";
			extracted = {
				tokens: extractTokensFromText(text),
				sources: [{ kind: "url" as const, url }],
				files: text
					? [
							{
								path: url,
								count: Object.keys(extractTokensFromText(text).raw).length,
							},
						]
					: [],
			};
		} else {
			extracted = await extractFromRepo(repoRoot);
		}
		const id = c.req.param("id");
		const existing = await designSystems.get(id);
		const system = existing
			? await designSystems.propose(id, {
					tokens: extracted.tokens,
					sources: extracted.sources,
				})
			: await designSystems.upsert({
					id,
					title: typeof body.title === "string" ? body.title : "Default",
					tokens: extracted.tokens,
					sources: extracted.sources,
					status: "draft",
				});
		broadcast("design-system", Date.now().toString());
		return c.json({ system, extract: extracted });
	});

	app.post("/api/design-systems/:id/components", async (c) => {
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		if (typeof body.id !== "string" || typeof body.html !== "string") {
			return c.json({ error: "id and html are required" }, 400);
		}
		const system = await designSystems.addComponent(c.req.param("id"), {
			id: body.id,
			label: typeof body.label === "string" ? body.label : body.id,
			html: body.html,
			source: body.source === "promote" ? "promote" : "human",
		});
		if (!system) return c.json({ error: "Design system not found" }, 404);
		broadcast("design-system", Date.now().toString());
		return c.json(system);
	});

	app.post("/api/design-systems/:id/comments", async (c) => {
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		if (typeof body.body !== "string" || !body.body.trim()) {
			return c.json({ error: "body is required" }, 400);
		}
		const kind =
			body.kind === "token" ||
			body.kind === "component" ||
			body.kind === "guidelines"
				? body.kind
				: "general";
		const system = await designSystems.addComment(c.req.param("id"), {
			kind,
			target: typeof body.target === "string" ? body.target : undefined,
			body: body.body,
		});
		if (!system) return c.json({ error: "Design system not found" }, 404);
		broadcast("design-system", Date.now().toString());
		return c.json(system);
	});

	app.put("/api/design-systems/:id/comments/:commentId", async (c) => {
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		const system = await designSystems.updateComment(
			c.req.param("id"),
			c.req.param("commentId"),
			{
				body: typeof body.body === "string" ? body.body : undefined,
				status:
					body.status === "resolved" || body.status === "open"
						? body.status
						: undefined,
			},
		);
		if (!system) return c.json({ error: "Not found" }, 404);
		broadcast("design-system", Date.now().toString());
		return c.json(system);
	});

	// ── Mockup review (twin of plan review) ──────────────────────────────────
	const summarizeMockup = (
		mockup: Mockup,
		includeComments = false,
	): MockupSummary => ({
		id: mockup.id,
		title: mockup.title,
		screens: mockup.screens.map(({ id, label }) => ({ id, label })),
		source: mockup.source,
		model: mockup.model,
		createdAt: mockup.createdAt,
		updatedAt: mockup.updatedAt,
		version: mockup.version,
		decision: mockup.decision,
		decidedAt: mockup.decidedAt,
		versionCount: mockup.versions.length,
		commentCounts: {
			total: mockup.comments.length,
			open: mockup.comments.filter((comment) => comment.status === "open").length,
			resolved: mockup.comments.filter((comment) => comment.status === "resolved")
				.length,
		},
		designSystemId: mockup.designSystemId,
		planId: mockup.planId,
		...(includeComments ? { comments: mockup.comments } : {}),
	});

	app.get("/api/mockups", async (c) => {
		const all = await mockups.getAll();
		if (c.req.query("include") === "full") return c.json(all);
		const includeComments = c.req.query("include") === "comments";
		return c.json(all.map((mockup) => summarizeMockup(mockup, includeComments)));
	});

	app.get("/api/mockups/:id", async (c) => {
		const mockup = await mockups.get(c.req.param("id"));
		if (!mockup) return c.json({ error: "Mockup not found" }, 404);
		return c.json(mockup);
	});

	app.get("/api/mockups/:id/versions", async (c) => {
		const mockup = await mockups.get(c.req.param("id"));
		if (!mockup) return c.json({ error: "Mockup not found" }, 404);
		return c.json(
			(mockup.versions ?? []).map((version) => ({
				version: version.version,
				title: version.title,
				source: version.source,
				model: version.model,
				createdAt: version.createdAt,
				screens: version.screens.map(({ id, label }) => ({ id, label })),
			})),
		);
	});

	app.get("/api/mockups/:id/versions/:n", async (c) => {
		const id = c.req.param("id");
		const n = Number(c.req.param("n"));
		if (!Number.isFinite(n) || n < 1) {
			return c.json({ error: "version must be a positive integer" }, 400);
		}
		const mockup = await mockups.get(id);
		if (!mockup) return c.json({ error: "Mockup not found" }, 404);
		const version = (mockup.versions ?? []).find((v) => v.version === n);
		if (!version) return c.json({ error: `Version ${n} not found` }, 404);
		return c.json({
			version,
			mockup: {
				id: mockup.id,
				title: mockup.title,
				decision: mockup.decision,
				currentVersion: mockup.version,
			},
		});
	});

	app.get("/api/mockups/:id/screens/:screenId/document", async (c) => {
		const mockup = await mockups.get(c.req.param("id"));
		if (!mockup) return c.text("Mockup not found", 404);
		const versionRaw = c.req.query("version");
		const versionN = versionRaw ? Number(versionRaw) : mockup.version;
		const snap =
			versionN === mockup.version
				? mockup
				: (mockup.versions ?? []).find((v) => v.version === versionN);
		if (!snap) return c.text("Version not found", 404);
		const screen = snap.screens.find((s) => s.id === c.req.param("screenId"));
		if (!screen) return c.text("Screen not found", 404);
		// Viewport labels the layout the document is framed at; it is part of the
		// comment scope (version + screen + viewport). Legacy clients omit it →
		// desktop.
		const viewport = normalizeMockupViewport(c.req.query("viewport"));
		// mode=view serves a passive probe: the mockup stays fully interactive
		// (no selection shield) while still reporting sections + anchor checks.
		const passive = c.req.query("mode") === "view";
		// Per-document nonce: embedded in the probe and echoed back in every
		// posted event, and exposed to the UI via the response header so events
		// can be matched to the exact served document.
		const nonce = crypto.randomUUID();
		registerMockupNonce(nonce, {
			mockupId: mockup.id,
			screenId: screen.id,
			version: versionN,
			viewport,
		});
		const snapBinding = snap as {
			mode?: MockupRenderMode;
			designSystemId?: string;
			designRevision?: number;
		};
		const mode = snapBinding.mode ?? mockup.mode ?? "document";
		const theme = (
			c.req.query("theme") === "dark" ? "dark" : "light"
		) as MockupTheme;
		const system = await resolveDesignSystem(
			snapBinding.designSystemId ?? mockup.designSystemId,
			snapBinding.designRevision ?? mockup.designRevision,
		);
		const rendered = renderMockupHtml(screen.html, {
			mode,
			system,
			title: mockup.title,
			theme,
		});
		return c.html(
			injectMockupProbe(rendered, { nonce, viewport, passive }),
			200,
			{
				"Content-Security-Policy":
					"default-src 'none'; style-src 'unsafe-inline' https: data:; img-src data: blob: https:; font-src https: data:; script-src 'unsafe-inline';",
				"X-Content-Type-Options": "nosniff",
				"X-Diffing-Mockup-Nonce": nonce,
				"X-Diffing-Mockup-Viewport": viewport,
			},
		);
	});

	// ── Bounded mockup inspection ────────────────────────────────────────────
	// `diffing mockup inspect` / MCP inspect_mockup: compact, paginated, and
	// filterable by comment scope (status / screen / viewport / version).
	app.get("/api/mockups/:id/inspect", async (c) => {
		const mockup = await mockups.get(c.req.param("id"));
		if (!mockup) return c.json({ error: "Mockup not found" }, 404);
		const view = c.req.query("view") || "summary";
		if (
			view !== "summary" &&
			view !== "comments" &&
			view !== "comment" &&
			view !== "screen" &&
			view !== "preview"
		) {
			return c.json(
				{ error: "view must be summary|comments|comment|screen|preview" },
				400,
			);
		}
		const status = c.req.query("status");
		if (status !== undefined && status !== "open" && status !== "resolved") {
			return c.json({ error: "status must be open or resolved" }, 400);
		}
		const screenFilter = c.req.query("screen");
		const viewportRaw = c.req.query("viewport");
		if (viewportRaw !== undefined && !isMockupViewport(viewportRaw)) {
			return c.json({ error: "viewport must be desktop|tablet|mobile" }, 400);
		}
		const versionRaw = c.req.query("version");
		if (
			versionRaw !== undefined &&
			(!Number.isFinite(Number(versionRaw)) || Number(versionRaw) < 1)
		) {
			return c.json({ error: "version must be a positive integer" }, 400);
		}
		const contextRaw = c.req.query("context") || "anchor";
		if (
			contextRaw !== "none" &&
			contextRaw !== "anchor" &&
			contextRaw !== "source"
		) {
			return c.json({ error: "context must be none|anchor|source" }, 400);
		}
		const context = contextRaw as "none" | "anchor" | "source";
		const cursorRaw = c.req.query("cursor");
		const cursor = cursorRaw === undefined ? 0 : Number(cursorRaw);
		if (!Number.isFinite(cursor) || cursor < 0) {
			return c.json({ error: "cursor must be a non-negative integer" }, 400);
		}
		const limitRaw = c.req.query("limit");
		const limit =
			limitRaw === undefined
				? 50
				: Math.min(Math.max(Number(limitRaw) || 50, 1), 200);

		const allComments = mockup.comments ?? [];

		if (view === "summary") {
			const byViewport = { desktop: 0, tablet: 0, mobile: 0 };
			for (const c2 of allComments) byViewport[commentViewport(c2)] += 1;
			return c.json({
				view: "summary",
				id: mockup.id,
				title: mockup.title,
				version: mockup.version,
				decision: mockup.decision,
				decidedAt: mockup.decidedAt ?? null,
				createdAt: mockup.createdAt,
				updatedAt: mockup.updatedAt,
				source: mockup.source,
				model: mockup.model,
				screens: mockup.screens.map((s) => ({ id: s.id, label: s.label })),
				versions: (mockup.versions ?? []).length,
				commentCounts: {
					total: allComments.length,
					open: allComments.filter((c2) => c2.status === "open").length,
					resolved: allComments.filter((c2) => c2.status === "resolved").length,
					byViewport,
				},
			});
		}

		if (view === "preview") {
			const screenId = c.req.query("screen") || mockup.screens[0]?.id;
			const screen = mockup.screens.find((s) => s.id === screenId);
			if (!screen) return c.json({ error: "Screen not found" }, 404);
			const viewport = normalizeMockupViewport(c.req.query("viewport"));
			const theme = (
				c.req.query("theme") === "dark" ? "dark" : "light"
			) as MockupTheme;
			const system = await resolveDesignSystem(
				mockup.designSystemId,
				mockup.designRevision,
			);
			const rendered = renderMockupHtml(screen.html, {
				mode: mockup.mode ?? "document",
				system,
				title: mockup.title,
				theme,
			});
			const preview = await renderMockupPreview(rendered, { viewport });
			return c.json({
				view: "preview",
				mockupId: mockup.id,
				screenId: screen.id,
				...preview,
			});
		}

		if (view === "comment") {
			const id = c.req.query("id");
			if (!id) {
				return c.json({ error: "id is required for view=comment" }, 400);
			}
			const comment = allComments.find((c2) => c2.id === id);
			if (!comment) {
				return c.json({ error: `Comment ${id} not found` }, 404);
			}
			return c.json({
				view: "comment",
				mockupId: mockup.id,
				version: mockup.version,
				comment: serializeMockupCommentSummary(comment, context),
			});
		}

		if (view === "screen") {
			const requestedVersion =
				versionRaw === undefined ? mockup.version : Number(versionRaw);
			const snapshot =
				requestedVersion === mockup.version
					? mockup
					: mockup.versions.find((version) => version.version === requestedVersion);
			if (!snapshot) {
				return c.json({ error: `Version ${requestedVersion} not found` }, 404);
			}
			if (screenFilter) {
				const screen = snapshot.screens.find((item) => item.id === screenFilter);
				if (!screen) return c.json({ error: "Screen not found" }, 404);
				return c.json({
					view: "screen",
					mockupId: mockup.id,
					version: requestedVersion,
					screen: {
						id: screen.id,
						label: screen.label,
						htmlBytes: Buffer.byteLength(screen.html, "utf8"),
						...(context === "source" ? { html: screen.html } : {}),
					},
				});
			}
			const start = Math.min(cursor, snapshot.screens.length);
			const page = snapshot.screens.slice(start, start + limit);
			return c.json({
				view: "screen",
				mockupId: mockup.id,
				version: requestedVersion,
				cursor: start,
				limit,
				nextCursor:
					start + page.length < snapshot.screens.length ? start + page.length : null,
				screens: page.map((screen) => ({
					id: screen.id,
					label: screen.label,
					htmlBytes: Buffer.byteLength(screen.html, "utf8"),
				})),
			});
		}

		// view === "comments"
		const versionN = versionRaw === undefined ? undefined : Number(versionRaw);
		const filtered = allComments.filter((c2) => {
			if (status !== undefined && c2.status !== status) return false;
			if (screenFilter !== undefined && c2.screenId !== screenFilter) return false;
			if (viewportRaw !== undefined && commentViewport(c2) !== viewportRaw) {
				return false;
			}
			if (versionN !== undefined && c2.createdAtMockupVersion !== versionN) {
				return false;
			}
			return true;
		});
		const start = Math.min(cursor, filtered.length);
		const page = filtered.slice(start, start + limit);
		return c.json({
			view: "comments",
			mockupId: mockup.id,
			version: mockup.version,
			cursor: start,
			limit,
			nextCursor:
				start + page.length < filtered.length ? start + page.length : null,
			comments: page.map((c2) =>
				serializeMockupCommentSummary(c2, context, { truncateBody: 400 }),
			),
		});
	});

	// ── One-screen revisions (upsert / remove / exact-text patch) ────────────
	// Each op bumps the mockup version and accepts an optional expectedVersion;
	// a mismatch aborts with 409 and no mutation.
	const screenOpError = (c: Context, result: MockupScreenOpResult) => {
		if (result.versionMismatch) {
			return c.json(
				{
					error: `Mockup is at version ${result.versionMismatch.currentVersion}, expected ${result.versionMismatch.expectedVersion} — pass the current version and retry.`,
					code: "version-mismatch",
					currentVersion: result.versionMismatch.currentVersion,
					expectedVersion: result.versionMismatch.expectedVersion,
				},
				409,
			);
		}
		if (result.error === "Exact text not found") {
			return c.json({ error: result.error, code: "exact-text-not-found" }, 409);
		}
		if (
			result.error?.includes("not found") &&
			result.error.startsWith("Region ")
		) {
			return c.json({ error: result.error, code: "region-not-found" }, 409);
		}
		if (
			result.error === "Mockup not found" ||
			result.error?.endsWith("not found")
		) {
			return c.json({ error: result.error }, 404);
		}
		return c.json({ error: result.error ?? "Screen operation failed" }, 400);
	};

	app.put("/api/mockups/:id/screens/:screenId", async (c) => {
		const mockupId = c.req.param("id");
		const screenId = c.req.param("screenId");
		if (!MOCKUP_SCREEN_ID_RE.test(screenId)) {
			return c.json({ error: `Invalid screen id "${screenId}"` }, 400);
		}
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		if (typeof body.html !== "string" || !body.html.trim()) {
			return c.json({ error: "html is required" }, 400);
		}
		if (Buffer.byteLength(body.html, "utf8") > MOCKUP_MAX_SCREEN_BYTES) {
			return c.json(
				{ error: `Each screen must be ≤ ${MOCKUP_MAX_SCREEN_BYTES} bytes` },
				400,
			);
		}
		const expectedVersion = Number.isFinite(body.expectedVersion)
			? Number(body.expectedVersion)
			: undefined;
		const label =
			typeof body.label === "string" && body.label.trim()
				? body.label.trim()
				: undefined;
		const result = await mockups.upsertScreen(
			mockupId,
			{ id: screenId, label, html: body.html },
			{ expectedVersion },
		);
		if (!result.mockup) return screenOpError(c, result);
		const hints = lintMockupScreens([{ id: screenId, html: body.html }]);
		return c.json(
			hints.length > 0 ? { ...result.mockup, hints } : result.mockup,
			200,
		);
	});

	app.patch("/api/mockups/:id/screens/:screenId", async (c) => {
		const mockupId = c.req.param("id");
		const screenId = c.req.param("screenId");
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		const expectedVersion = Number.isFinite(body.expectedVersion)
			? Number(body.expectedVersion)
			: undefined;
		const region = typeof body.region === "string" ? body.region.trim() : "";
		if (region) {
			if (typeof body.replacement !== "string") {
				return c.json({ error: "replacement is required" }, 400);
			}
			const result = await mockups.replaceRegion(
				mockupId,
				screenId,
				{ region, replacement: body.replacement },
				{ expectedVersion },
			);
			if (!result.mockup) return screenOpError(c, result);
			return c.json(
				{ mockup: result.mockup, occurrences: result.occurrences },
				200,
			);
		}
		const expectedText =
			typeof body.expectedText === "string" ? body.expectedText : "";
		if (!expectedText) {
			return c.json({ error: "expectedText or region is required" }, 400);
		}
		if (typeof body.replacement !== "string") {
			return c.json({ error: "replacement is required" }, 400);
		}
		const result = await mockups.patchScreen(
			mockupId,
			screenId,
			{ expectedText, replacement: body.replacement },
			{ expectedVersion },
		);
		if (!result.mockup) return screenOpError(c, result);
		return c.json(
			{ mockup: result.mockup, occurrences: result.occurrences },
			200,
		);
	});

	app.delete("/api/mockups/:id/screens/:screenId", async (c) => {
		const mockupId = c.req.param("id");
		const screenId = c.req.param("screenId");
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		const expectedVersion = Number.isFinite(body.expectedVersion)
			? Number(body.expectedVersion)
			: c.req.query("expectedVersion") === undefined
				? undefined
				: Number(c.req.query("expectedVersion"));
		const result = await mockups.removeScreen(mockupId, screenId, {
			expectedVersion,
		});
		if (!result.mockup) return screenOpError(c, result);
		return c.json(result.mockup, 200);
	});

	// ── Atomic thread batch ──────────────────────────────────────────────────
	// reply / edit / delete / resolve / unresolve, all validated before any is
	// applied (all-or-nothing). Thread ops never bump the mockup version.
	app.post("/api/mockups/:id/threads/batch", async (c) => {
		const mockupId = c.req.param("id");
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		const normalized = normalizeThreadOperations(body.operations);
		if (!normalized.ok) {
			return c.json({ error: normalized.error, index: normalized.index }, 400);
		}
		const result = await mockups.applyThreadBatch(mockupId, normalized.ops);
		if (!result.mockup) {
			return c.json(
				{
					error: result.error ?? "Thread batch failed",
					results: result.results,
				},
				result.error === "Mockup not found" ? 404 : 409,
			);
		}
		return c.json({
			ok: true,
			applied: result.results.length,
			results: result.results,
			mockup: result.mockup,
		});
	});

	app.post("/api/mockups", async (c) => {
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		if (typeof body.fromMockupId === "string") {
			const source = await mockups.get(body.fromMockupId);
			if (!source) return c.json({ error: "Source mockup not found" }, 404);
			body.screens = source.screens.map((s) => ({
				id: s.id,
				label: s.label,
				html: s.html,
				stateOf: s.stateOf,
				flow: s.flow,
			}));
			if (!body.designSystemId && !body.designSystem) {
				body.designSystemId = source.designSystemId;
			}
			if (!body.mode) body.mode = source.mode;
			if (!body.flows) body.flows = source.flows;
		} else if (body.blank === true && !body.html && !body.screens) {
			body.html = "";
		}
		if (body.blank === true && body.html === "") {
			body.html = "<!-- empty -->";
		}
		const normalized = screensFromSubmitBody(body);
		if (!normalized.ok) return c.json({ error: normalized.error }, 400);
		const title =
			typeof body.title === "string" && body.title.trim()
				? body.title.trim()
				: "Untitled mockup";
		const requestedMode = body.mode;
		const designSystemId =
			typeof body.designSystem === "string"
				? body.designSystem
				: typeof body.designSystemId === "string"
					? body.designSystemId
					: undefined;
		const system = await resolveDesignSystem(designSystemId);
		const mode = resolveRenderMode(requestedMode, system);
		const mockup = await mockups.upsert({
			id: typeof body.id === "string" && body.id ? body.id : undefined,
			title,
			screens: normalized.screens,
			source: typeof body.source === "string" ? body.source : undefined,
			model: typeof body.model === "string" ? body.model : undefined,
			designSystemId: system?.id,
			designRevision: system?.revision,
			mode,
			planId: typeof body.planId === "string" ? body.planId : undefined,
			flows: Array.isArray(body.flows) ? (body.flows as never) : undefined,
		});
		const hints = lintMockupScreens(normalized.screens);
		return c.json(hints.length > 0 ? { ...mockup, hints } : mockup, 201);
	});

	app.put("/api/mockups/:id", async (c) => {
		const id = c.req.param("id");
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		let screens;
		if (body.html !== undefined || body.screens !== undefined) {
			const normalized = screensFromSubmitBody(body);
			if (!normalized.ok) return c.json({ error: normalized.error }, 400);
			screens = normalized.screens;
		}
		const updated = await mockups.update(id, {
			title: typeof body.title === "string" ? body.title : undefined,
			screens,
			source: typeof body.source === "string" ? body.source : undefined,
			model: typeof body.model === "string" ? body.model : undefined,
		});
		if (!updated) return c.json({ error: "Mockup not found" }, 404);
		return c.json(updated);
	});

	app.get("/api/mockups/:id/handoff", async (c) => {
		const mockup = await mockups.get(c.req.param("id"));
		if (!mockup) return c.json({ error: "Mockup not found" }, 404);
		const system = await resolveDesignSystem(
			mockup.designSystemId,
			mockup.designRevision,
		);
		const handoff = buildMockupHandoff(mockup, system);
		return c.json({ ...handoff, xml: formatMockupHandoffXml(handoff) });
	});

	app.post(
		"/api/mockups/:id/comments/:commentId/apply-suggestion",
		async (c) => {
			const mockup = await mockups.get(c.req.param("id"));
			if (!mockup) return c.json({ error: "Mockup not found" }, 404);
			const comment = mockup.comments.find(
				(x) => x.id === c.req.param("commentId"),
			);
			if (!comment) return c.json({ error: "Comment not found" }, 404);
			const suggestion = extractSuggestion(comment.body);
			if (!suggestion) {
				return c.json({ error: "No ```suggestion block in comment" }, 400);
			}
			const reqBody = await c.req
				.json()
				.catch(() => ({}) as { expectedVersion?: number });
			const expectedVersion = Number.isFinite(reqBody.expectedVersion)
				? Number(reqBody.expectedVersion)
				: mockup.version;
			let result;
			if (comment.target) {
				result = await mockups.replaceRegion(
					mockup.id,
					comment.screenId,
					{ region: comment.target, replacement: suggestion },
					{ expectedVersion },
				);
			} else if (comment.html) {
				result = await mockups.patchScreen(
					mockup.id,
					comment.screenId,
					{ expectedText: comment.html, replacement: suggestion },
					{ expectedVersion },
				);
			} else {
				return c.json({ error: "Comment has no target or html to replace" }, 400);
			}
			if (!result.mockup) return screenOpError(c, result);
			return c.json(result.mockup);
		},
	);

	app.delete("/api/mockups/:id", async (c) => {
		const removed = await mockups.remove(c.req.param("id"));
		if (!removed) return c.json({ error: "Mockup not found" }, 404);
		return c.json({ ok: true });
	});

	app.post("/api/mockups/:id/comments", async (c) => {
		const mockupId = c.req.param("id");
		const mockup = await mockups.get(mockupId);
		if (!mockup) return c.json({ error: "Mockup not found" }, 404);
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		const kind = body.kind as MockupAnchorKind;
		if (kind !== "section" && kind !== "block" && kind !== "point") {
			return c.json({ error: "kind must be section, block, or point" }, 400);
		}
		const screenId = typeof body.screenId === "string" ? body.screenId : "";
		if (!mockup.screens.some((s) => s.id === screenId)) {
			return c.json({ error: "Unknown screenId" }, 400);
		}
		// Optional source-window validation: when the client echoes the per-
		// document nonce back, it must match a document this server issued for
		// this exact mockup + screen.
		if (typeof body.nonce === "string" && body.nonce) {
			const nonceError = validateMockupNonce(body.nonce, mockupId, screenId);
			if (nonceError) {
				return c.json({ error: nonceError, code: "invalid-nonce" }, 409);
			}
		}
		if (typeof body.body !== "string" || !body.body.trim()) {
			return c.json({ error: "body is required" }, 400);
		}
		if (body.viewport !== undefined && !isMockupViewport(body.viewport)) {
			return c.json({ error: "viewport must be desktop|tablet|mobile" }, 400);
		}
		const selector =
			typeof body.selector === "string" && body.selector.trim()
				? body.selector
				: undefined;
		const fingerprint =
			typeof body.fingerprint === "string" && body.fingerprint.trim()
				? body.fingerprint
				: undefined;
		if (kind === "block" && !selector && !fingerprint) {
			return c.json(
				{ error: "block comments require selector or fingerprint" },
				400,
			);
		}
		if (
			kind === "point" &&
			(!Number.isFinite(body.x) || !Number.isFinite(body.y))
		) {
			return c.json({ error: "point comments require x and y" }, 400);
		}
		const viewport = normalizeMockupViewport(body.viewport);
		const theme: MockupTheme = body.theme === "dark" ? "dark" : "light";
		const severityRaw = body.severity;
		const severity =
			severityRaw === "blocking" ||
			severityRaw === "nit" ||
			severityRaw === "question" ||
			severityRaw === "praise" ||
			severityRaw === "none"
				? severityRaw
				: undefined;
		const rect =
			body.rect && typeof body.rect === "object"
				? (body.rect as { x?: unknown; y?: unknown; w?: unknown; h?: unknown })
				: undefined;
		const comment = {
			id: crypto.randomUUID(),
			screenId,
			kind,
			target: typeof body.target === "string" ? body.target : undefined,
			selector,
			fingerprint,
			html: typeof body.html === "string" ? body.html : undefined,
			contextHtml:
				typeof body.contextHtml === "string" ? body.contextHtml : undefined,
			x: Number.isFinite(body.x) ? Number(body.x) : undefined,
			y: Number.isFinite(body.y) ? Number(body.y) : undefined,
			sectionX: Number.isFinite(body.sectionX) ? Number(body.sectionX) : undefined,
			sectionY: Number.isFinite(body.sectionY) ? Number(body.sectionY) : undefined,
			snapshot: typeof body.snapshot === "string" ? body.snapshot : undefined,
			rect:
				rect &&
				Number.isFinite(rect.x) &&
				Number.isFinite(rect.y) &&
				Number.isFinite(rect.w) &&
				Number.isFinite(rect.h)
					? {
							x: Number(rect.x),
							y: Number(rect.y),
							w: Number(rect.w),
							h: Number(rect.h),
						}
					: undefined,
			body: String(body.body),
			status: "open" as const,
			createdAt: Date.now(),
			createdAtMockupVersion: mockup.version,
			viewport,
			theme,
			replies: [],
			...(severity && severity !== "none" ? { severity } : {}),
		};
		const updated = await mockups.addComment(mockupId, comment);
		if (!updated) return c.json({ error: "Mockup not found" }, 404);
		return c.json(updated, 201);
	});

	app.put("/api/mockups/:id/comments/:commentId", async (c) => {
		const { body, status } = await c.req.json();
		const updated = await mockups.updateComment(
			c.req.param("id"),
			c.req.param("commentId"),
			{ body, status },
		);
		if (!updated) return c.json({ error: "Mockup or comment not found" }, 404);
		return c.json(updated);
	});

	app.delete("/api/mockups/:id/comments/:commentId", async (c) => {
		const updated = await mockups.removeComment(
			c.req.param("id"),
			c.req.param("commentId"),
		);
		if (!updated) return c.json({ error: "Mockup or comment not found" }, 404);
		return c.json(updated);
	});

	app.post("/api/mockups/:id/comments/:commentId/replies", async (c) => {
		const { body, role, model } = await c.req.json();
		const reply = {
			id: crypto.randomUUID(),
			body,
			createdAt: Date.now(),
			role: role || (model ? "agent" : "user"),
			model: model || undefined,
		};
		const updated = await mockups.addReply(
			c.req.param("id"),
			c.req.param("commentId"),
			reply,
		);
		if (!updated) return c.json({ error: "Mockup or comment not found" }, 404);
		return c.json(updated);
	});

	app.put("/api/mockups/:id/comments/:commentId/replies/:replyId", async (c) => {
		const { body } = await c.req.json();
		if (!body) return c.json({ error: "Body is required" }, 400);
		const updated = await mockups.updateReply(
			c.req.param("id"),
			c.req.param("commentId"),
			c.req.param("replyId"),
			body,
		);
		if (!updated)
			return c.json({ error: "Mockup, comment, or reply not found" }, 404);
		return c.json(updated);
	});

	app.delete(
		"/api/mockups/:id/comments/:commentId/replies/:replyId",
		async (c) => {
			const updated = await mockups.removeReply(
				c.req.param("id"),
				c.req.param("commentId"),
				c.req.param("replyId"),
			);
			if (!updated)
				return c.json({ error: "Mockup, comment, or reply not found" }, 404);
			return c.json(updated);
		},
	);

	app.post("/api/mockups/:id/decision", async (c) => {
		const mockupId = c.req.param("id");
		const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		const decision = body.decision as MockupDecision;
		if (
			decision !== "approved" &&
			decision !== "rejected" &&
			decision !== "changes-requested" &&
			decision !== "comment-only"
		) {
			return c.json(
				{
					error:
						"decision must be one of: approved, rejected, changes-requested, comment-only",
				},
				400,
			);
		}
		const decisionComment =
			typeof body.decisionComment === "string" ? body.decisionComment : undefined;
		const mode =
			body?.mode === "comment-only" || body?.mode === "standard"
				? (body.mode as MockupMode)
				: "standard";
		const focusedScreen =
			typeof body.screen === "string" ? body.screen : undefined;
		const focusedViewport = isMockupViewport(body.viewport)
			? body.viewport
			: undefined;
		const mockup = await mockups.setDecision(mockupId, decision, decisionComment);
		if (!mockup) return c.json({ error: "Mockup not found" }, 404);

		const openCommentCount = (mockup.comments ?? []).filter(
			(x) => x.status === "open",
		).length;
		const payload = mockupReviewSession.decide({
			mockup,
			decision,
			decisionComment: mockup.decisionComment,
			reviewXml: formatMockupReview(mockup, {
				mode,
				focusedScreen,
				focusedViewport,
			}),
			openCommentCount,
			mode,
		});
		return c.json({
			ok: true,
			round: payload.round,
			decision,
			mode: payload.mode,
			openCommentCount,
			waiters: mockupReviewSession.snapshot().waiters,
		});
	});

	app.get("/api/mockup-review/await", async (c) => {
		const sinceRaw = c.req.query("sinceRound");
		const sinceRound =
			sinceRaw !== undefined && sinceRaw !== "" ? Number(sinceRaw) : undefined;
		const requested = Number(c.req.query("timeoutMs")) || 25000;
		const timeoutMs = Math.min(Math.max(requested, 1000), 50000);
		const result = await mockupReviewSession.await({
			sinceRound: Number.isNaN(sinceRound as number) ? undefined : sinceRound,
			timeoutMs,
			signal: c.req.raw.signal,
		});
		return c.json(result);
	});

	app.get("/api/mockup-review/status", (c) => {
		return c.json(mockupReviewSession.snapshot());
	});

	app.post("/api/attachments", async (c) => {
		const body = await c.req.parseBody();
		const file = body["file"];
		if (!file || !(file instanceof File)) {
			return c.json({ error: "No file uploaded" }, 400);
		}

		try {
			if (file.size <= 0 || file.size > MAX_AI_IMAGE_BYTES) {
				return c.json({ error: "Images must be between 1 byte and 10 MB." }, 413);
			}
			const mimeType = file.type.toLowerCase();
			const ext = AI_IMAGE_MIME_TO_EXTENSION.get(mimeType);
			if (!ext)
				return c.json(
					{ error: "Only PNG, JPEG, WebP, and GIF images are supported." },
					415,
				);
			const storageDir = getProjectStorageDir();
			const filename = `pasted_image_${crypto.randomUUID()}${ext}`;
			const content = Buffer.from(await file.arrayBuffer());
			if (!hasImageSignature(content, mimeType))
				return c.json(
					{ error: "The uploaded file does not match its image type." },
					415,
				);
			// Only the trusted storage root is created with ambient authority.
			// All child creation and file replacement use its pinned capability.
			await mkdir(storageDir, { recursive: true });
			const files = getNativeRepositoryFs(storageDir);
			await files.write("repo_path.txt", Buffer.from(repoRoot, "utf8"));
			await files.write(`attachments/${filename}`, content, {
				createParents: true,
			});

			return c.json({
				url: `/api/attachments/${filename}`,
				name: file.name || filename,
				mimeType,
				size: file.size,
			});
		} catch (error) {
			if (error instanceof NativeFsError) throw error;
			return c.json({ error: "Failed to save attachment" }, 500);
		}
	});

	app.get("/api/attachments/:filename", async (c) => {
		const filename = c.req.param("filename");
		if (filename === ".." || /[/\\\0]/.test(filename))
			return c.text("Forbidden", 403);
		const image = await readStoredImage(filename);
		if (!image) return c.text("Attachment not found", 404);
		return new Response(new Uint8Array(image.bytes), {
			headers: { "Content-Type": image.mimeType },
		});
	});

	app.get("/*", async (c) => {
		let filePath = c.req.path;
		if (filePath === "/") filePath = "/index.html";

		const relativePath = filePath.slice(1);
		if (!isSafePath(relativePath, clientDir)) {
			return c.text("Forbidden", 403);
		}
		const fullPath = resolve(clientDir, relativePath);
		try {
			const content = await readFile(fullPath);
			const ext = extname(fullPath);
			const contentType = MIME_TYPES[ext] || "application/octet-stream";
			if (contentType === "text/html" && security.authToken) {
				const html = injectSessionTokenIntoHtml(
					content.toString("utf-8"),
					security.authToken,
				);
				return new Response(html, {
					headers: {
						"Content-Type": contentType,
						"Set-Cookie": buildSessionTokenSetCookieValue(security.authToken),
					},
				});
			}
			return new Response(content, {
				headers: { "Content-Type": contentType },
			});
		} catch {
			let indexContent: Buffer;
			try {
				indexContent = await readFile(join(clientDir, "index.html"));
			} catch {
				return c.text(
					"diffing review UI unavailable: client bundle is missing",
					503,
				);
			}
			const html = injectSessionTokenIntoHtml(
				indexContent.toString("utf-8"),
				security.authToken,
			);
			const spaHeaders: Record<string, string> = {
				"Content-Type": "text/html",
			};
			if (security.authToken) {
				spaHeaders["Set-Cookie"] = buildSessionTokenSetCookieValue(
					security.authToken,
				);
			}
			return new Response(html, { headers: spaHeaders });
		}
	});

	return app;
}

/**
 * Newest mtime (epoch ms) across everything that counts as project activity:
 * comments.json, plans.json, and any attachment (media) file. Plans and media
 * extend a project's life exactly like comments do, so retention is uniform
 * across all three. Returns null when none of them exist yet.
 */
async function newestActivityMs(projectDir: string): Promise<number | null> {
	const candidates: number[] = [];
	const safeStat = async (p: string): Promise<number | null> => {
		try {
			return (await stat(p)).mtimeMs;
		} catch {
			return null;
		}
	};

	for (const name of [
		"comments.json",
		"plans.json",
		"mockups.json",
		"pr-session.json",
	]) {
		const file = join(projectDir, name);
		if (!existsSync(file)) continue;
		const m = await safeStat(file);
		if (m !== null) candidates.push(m);
	}

	const attachmentsDir = join(projectDir, "attachments");
	if (existsSync(attachmentsDir)) {
		const dirM = await safeStat(attachmentsDir);
		if (dirM !== null) candidates.push(dirM);
		try {
			for (const file of await readdir(attachmentsDir)) {
				const m = await safeStat(join(attachmentsDir, file));
				if (m !== null) candidates.push(m);
			}
		} catch {
			// unreadable attachments dir — fall back to whatever we already have
		}
	}

	return candidates.length ? Math.max(...candidates) : null;
}

export async function cleanupStaleProjects(): Promise<void> {
	const baseDir = join(homedir(), ".diffing");
	if (!existsSync(baseDir)) return;

	try {
		const entries = await readdir(baseDir, { withFileTypes: true });
		const now = Date.now();
		const STALE_TIME = 14 * 24 * 60 * 60 * 1000;

		for (const entry of entries) {
			if (entry.isDirectory()) {
				const projectDir = join(baseDir, entry.name);
				const repoPathFile = join(projectDir, "repo_path.txt");

				let shouldDelete = false;

				// Dead project: the repository it mirrored no longer exists on disk.
				if (existsSync(repoPathFile)) {
					try {
						const repoPath = (await readFile(repoPathFile, "utf-8")).trim();
						if (!repoPath || !existsSync(repoPath)) {
							shouldDelete = true;
						}
					} catch {
						// ignore
					}
				}

				// Stale project: nothing — comments, plans, or media — has been
				// touched within STALE_TIME. Plans live for the same span as comments
				// and attachments, so the freshest of the three keeps the dir alive.
				if (!shouldDelete) {
					const newest = await newestActivityMs(projectDir);
					if (newest !== null && now - newest > STALE_TIME) {
						shouldDelete = true;
					}
				}

				if (shouldDelete) {
					await rm(projectDir, { recursive: true, force: true });
				}
			}
		}
	} catch (err) {
		console.error("Failed to cleanup stale projects:", err);
	}
}

export interface StartedServer {
	port: number;
	prMode: boolean;
	/** Stop accepting requests and tear down active review connections. */
	close?: () => Promise<void>;
}

export async function startServer(options: {
	port: number;
	host: string;
	clientDir: string;
	diffOpts?: DiffOptions;
	security: ServerAuthConfig;
	/**
	 * If set, the server builds a `pr-session.json` from this ref on startup so
	 * the web UI opens in PR mode. The session is persisted in the per-repo
	 * storage dir; if it already exists, the diff is NOT re-fetched (use the
	 * `POST /api/gh/pr/refresh` endpoint to re-fetch).
	 */
	prRef?: string;
}): Promise<StartedServer> {
	try {
		await readFile(join(options.clientDir, "index.html"));
	} catch {
		throw new Error(
			`Review UI bundle not found at ${join(options.clientDir, "index.html")}. ` +
				"Run the full TypeScript/client build before starting diffing.",
		);
	}
	cleanupStaleProjects().catch((err) => {
		console.error("Failed to clean up stale projects:", err);
	});

	// Build the PR session BEFORE creating the Hono app so `createApp` knows
	// whether it should enable the PR routes. `buildPrSession` shells out to
	// `gh` (auth + metadata + diff fetch) and takes a few seconds -- if we
	// fire-and-forget like before, the port-bound callback resolves with
	// `prMode = false` and the lockfile is written as `mode: "web"`. The UI
	// then hits `/api/diff` before the session lands in the store, falls
	// through to the local diff, and shows nothing.
	let prMode = false;
	let prStoreForApp: FilePrSessionStore | undefined;
	if (options.prRef) {
		console.error(`Building PR session for ${options.prRef}...`);
		try {
			const store = new FilePrSessionStore();
			prStoreForApp = store;
			const cwdRepo = await detectCwdRepo();
			const resolved = parsePrRef(options.prRef, cwdRepo ?? undefined);
			const existing = await store.get();
			if (!existing || !samePrIdentity(existing, resolved)) {
				const session = await buildPrSession(options.prRef);
				await store.set(session);
			}
			prMode = true;
		} catch (err: any) {
			// Fail hard: silent fall-through to local web mode is the #1 reason
			// users report "PR review doesn't work" (they see a working-tree diff).
			const detail = err?.message ?? String(err);
			throw new Error(
				`Failed to build PR session for ${options.prRef}: ${detail}`,
			);
		}
	}

	const app = createApp(
		options.clientDir,
		options.diffOpts,
		undefined,
		undefined,
		prStoreForApp,
		prMode,
		options.security,
	);

	return new Promise((resolve, reject) => {
		const nodeServer = serve(
			{
				fetch: app.fetch,
				port: options.port,
				hostname: options.host,
			},
			(info) => {
				nodeServer.off("error", onStartupError);
				resolve({
					port: info.port,
					prMode,
					close: () =>
						new Promise<void>((resolveClose, rejectClose) => {
							nodeServer.close((error) => {
								if (error) rejectClose(error);
								else resolveClose();
							});
							const closeAllConnections = (
								nodeServer as { closeAllConnections?: () => void }
							).closeAllConnections;
							closeAllConnections?.call(nodeServer);
						}),
				});
			},
		);
		const onStartupError = (error: Error) => reject(error);
		nodeServer.once("error", onStartupError);
	});
}
