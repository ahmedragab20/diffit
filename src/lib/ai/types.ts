import type {
	AiSnapshotManifest,
	ReviewSnapshot,
	AiEvidenceReference,
} from "./snapshots.js";

export type AiSourceId =
	| "codex"
	| "claude"
	| "opencode"
	| "cursor"
	| "openai"
	| "anthropic"
	| "xai";

export type AiCredentialRoute = "subscription" | "direct-key" | "runtime-key";

export type AiConnectionStatus =
	| "connected"
	| "disconnected"
	| "missing-runtime"
	| "needs-configuration"
	| "error";

export interface AiProviderCapabilities {
	protocol:
		| "codex-app-server"
		| "claude-stream-json"
		| "opencode-json"
		| "cursor-stream-json"
		| "responses-sse"
		| "anthropic-sse";
	contractVersion: 1;
	/** No installed runtime or account has been certified by a static declaration. */
	runtimeVersion: string | null;
	liveVerified: false;
	routes: AiCredentialRoute[];
	reasoningEffort: "model-catalog" | "unsupported";
	serviceTier: "model-catalog" | "unsupported";
	images: "model-catalog" | "unsupported";
	toolAuthority: "disabled" | "runtime-managed-unverified";
	investigation: false;
}

export interface AiConnection {
	id: AiSourceId;
	label: string;
	status: AiConnectionStatus;
	runtimeAvailable: boolean;
	credentialRoutes: AiCredentialRoute[];
	/** Verified active routes only; discovery must not copy the declared routes here. */
	activeRoutes: AiCredentialRoute[];
	/** Legacy `connected` status means available/configured, not authenticated. */
	authentication?: {
		evidence: "none" | "key-configured" | "runtime-status";
		verified: false;
		configuredRoutes: AiCredentialRoute[];
	};
	detail?: string;
	setupCommand?: string;
	modelCount?: number;
	capabilities?: AiProviderCapabilities;
}

export interface AiModel {
	id: string;
	sourceId: AiSourceId;
	/** Selection namespace; does not certify the runtime's credential or billing route. */
	credentialRoute: AiCredentialRoute;
	providerId: string;
	modelId: string;
	displayName: string;
	description?: string;
	isDefault?: boolean;
	reasoningEfforts?: string[];
	serviceTiers?: string[];
	supportsImages?: boolean;
	catalogSource?: "runtime" | "provider" | "fallback";
	capabilities?: AiProviderCapabilities;
}

export interface AiDiffSelection {
	filePath: string;
	side: "additions" | "deletions";
	startLine: number;
	endLine: number;
	selectedText: string;
}

export interface AiImageAttachmentReference {
	url: string;
	name: string;
	mimeType: string;
	size?: number;
}

/** Server-resolved image input. Clients may send references, never these fields. */
export interface AiResolvedImageAttachment extends AiImageAttachmentReference {
	absolutePath: string;
	dataUrl: string;
}

export type AiSurface = "diff" | "pr-diff" | "plan" | "mockup";

export type AiAction =
	| "ask"
	| "summarize"
	| "review-risks"
	| "explain"
	| "draft-comment"
	| "improve-comment"
	| "shorten-comment"
	| "make-specific"
	| "draft-reply"
	| "suggest-change"
	| "review-map"
	| "explain-hunk"
	| "draft-review-summary"
	| "critique-plan"
	| "find-plan-gaps"
	| "rewrite-plan-section"
	| "compare-plan-versions"
	| "critique-mockup"
	| "find-mockup-gaps"
	| "rewrite-region"
	| "generate-screen"
	| "compare-mockup-versions";

export interface AiDiffContext {
	kind: "diff" | "file" | "selection" | "comment-thread";
	repoName?: string;
	branch?: string;
	/**
	 * The file currently nearest the reviewer in the UI. This is a navigation
	 * hint only: it must never narrow a whole-diff context to one file.
	 */
	focusedFilePath?: string;
	filePath?: string;
	side?: "additions" | "deletions";
	startLine?: number;
	endLine?: number;
	patch?: string;
	selectedText?: string;
	draft?: string;
	commentBody?: string;
	replies?: string[];
	attachmentPaths?: string[];
	attachments?: AiAttachment[];
	selections?: AiDiffSelection[];
	imageAttachments?: AiImageAttachmentReference[];
}

export interface AiPlanContext {
	kind: "plan" | "plan-selection" | "plan-thread" | "plan-version-compare";
	planId: string;
	title: string;
	version: number;
	body?: string;
	/** Explicit unsubmitted plan text; never substitutes for the stored version. */
	bodyDraft?: string;
	selectedText?: string;
	section?: string;
	draft?: string;
	commentBody?: string;
	replies?: string[];
	previousVersion?: number;
	previousBody?: string;
	attachmentPaths?: string[];
	attachments?: AiAttachment[];
	imageAttachments?: AiImageAttachmentReference[];
}

export interface AiMockupContext {
	kind:
		| "mockup"
		| "mockup-screen"
		| "mockup-region"
		| "mockup-thread"
		| "mockup-version-compare";
	mockupId: string;
	title: string;
	version: number;
	screenId?: string;
	screenLabel?: string;
	viewport?: "desktop" | "tablet" | "mobile";
	html?: string;
	selectedHtml?: string;
	region?: string;
	draft?: string;
	commentBody?: string;
	replies?: string[];
	previousVersion?: number;
	previousHtml?: string;
	attachmentPaths?: string[];
	attachments?: AiAttachment[];
	imageAttachments?: AiImageAttachmentReference[];
}

export interface AiAttachment {
	path: string;
	content: string;
	truncated?: boolean;
}

export interface AiConversationContextLabel {
	kind?: string;
	filePath?: string;
	label?: string;
	version?: number;
	attachmentPaths?: string[];
	selectionLabels?: string[];
	imageAttachments?: AiImageAttachmentReference[];
}

export interface AiConversationTurn {
	id?: string;
	role: "user" | "assistant";
	text: string;
	createdAt?: number;
	modelId?: string;
	context?: AiConversationContextLabel;
}

export type AiReviewContext = AiDiffContext | AiPlanContext | AiMockupContext;

export interface AiRunRequest {
	/** The server rejects anything except an explicit user-triggered request. */
	trigger: "user";
	conversationId: string;
	modelId: string;
	surface: AiSurface;
	action: AiAction;
	mode?: "answer" | "investigate";
	prompt?: string;
	context: AiReviewContext;
	reasoningEffort?: string;
	serviceTier?: string;
	history?: AiConversationTurn[];
	/** Populated by the server after validating project-local image references. */
	resolvedImages?: AiResolvedImageAttachment[];
	/** Server-only source identity, rejected at the wire boundary. */
	snapshot?: AiSnapshotManifest;
	/** Server-only captured reader and the references actually included in the prompt. */
	snapshotReader?: ReviewSnapshot;
	evidence?: AiEvidenceReference[];
}

export type AiRunEvent =
	| { type: "start"; runId: string; modelId: string }
	| { type: "text-delta"; text: string }
	| { type: "warning"; message: string }
	| { type: "error"; message: string; code?: string }
	| { type: "complete"; text: string };

export interface AiBackendAdapter {
	id: AiSourceId;
	capabilities?: AiProviderCapabilities;
	supportsImages?: boolean;
	connection(): Promise<AiConnection>;
	models(): Promise<AiModel[]>;
	connectKey?(key: string, remember: boolean): Promise<void>;
	disconnect?(): Promise<void>;
	setupCommand?(route: AiCredentialRoute, providerId?: string): string | null;
	run(
		request: AiRunRequest,
		signal: AbortSignal,
		onEvent: (event: AiRunEvent) => void | Promise<void>,
	): Promise<string>;
}
