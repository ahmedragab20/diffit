import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeJsonAtomically } from "./json-atomic.js";

const CONFIG_DIR = join(homedir(), ".config", "diffing");
const SETTINGS_FILE = join(CONFIG_DIR, "settings.json");

export type LineDiffType = "word" | "word-alt" | "char" | "none";
export type DiffIndicators = "classic" | "bars" | "none";
export type HunkSeparatorStyle =
	| "simple"
	| "metadata"
	| "line-info"
	| "line-info-basic";
export type LineHoverHighlight = "disabled" | "both" | "number" | "line";
export type DefaultMode = "web" | "tui";

/** Human-facing label for stored mode values (`tui` → `TUI`, `web` → `Web`). */
export function formatModeLabel(mode: string): string {
	if (mode === "tui") return "TUI";
	if (mode === "web") return "Web";
	return mode;
}

export interface AiLanguageServer {
	/** Resolved on PATH; never run through a shell. */
	command: string;
	args?: string[];
}

export interface Settings {
	/** Interactive mode used when no explicit output-mode flag is provided. */
	defaultMode: DefaultMode;
	staged: boolean;
	untracked: boolean;
	diffStyle: "split" | "unified";
	defaultTabSize: number;
	browser?: string;
	theme: string;
	editorIDE?: "default" | "vscode" | "zed" | "vim" | "neovim" | "ghostty";
	/** Inline change highlight algorithm — pinpoint exact diff inside a line. */
	lineDiffType: LineDiffType;
	/** Soft-wrap long lines instead of horizontal scroll. */
	lineWrap: boolean;
	/** Visual style for added/removed line indicators. */
	diffIndicators: DiffIndicators;
	/** Show gutter line numbers. */
	showLineNumbers: boolean;
	/** Display style for the divider between hunks (includes function context). */
	hunkSeparators: HunkSeparatorStyle;
	/** How a hovered line should be highlighted. */
	lineHoverHighlight: LineHoverHighlight;
	/** Render code at this base font-size (px). */
	fontSize: number;
	/** Auto-load full file contents so hunk context becomes expandable. */
	expandContextByDefault: boolean;
	/** Only collapse unchanged context gaps larger than this. */
	collapsedContextThreshold: number;
	/** How many lines to reveal per expand-up / expand-down click. */
	expansionLineCount: number;
	/** Tactile feedback (web-haptics) on interaction. */
	haptics: boolean;
	/** Synthesized audio feedback on interaction. */
	sounds: boolean;
	/** UI font family override. null = default (Geist Mono from CDN). */
	uiFont?: string | null;
	/** Code/diff/plans font family override. null = default (JetBrains Mono from CDN). */
	monoFont?: string | null;
	/** UI density — compact tightens padding / control heights. */
	density: "comfortable" | "compact";
	/**
	 * Auto-collapse file cards whose added+deleted line count exceeds this.
	 * Set 0 to disable.
	 */
	autoCollapseLineThreshold: number;
	/**
	 * When true, "Send to agent" warns (and blocks until acknowledged) if any
	 * files in the current diff are still unviewed.
	 */
	requireViewAllBeforeSend: boolean;
	/** Whether the vim-style status bar at the bottom is visible. */
	showStatusBar: boolean;
	/**
	 * Saved reply templates for quick insert into comment forms.
	 * Stored globally in settings.json.
	 */
	savedReplies: SavedReply[];
	/** Ignore changes in amount of whitespace (`git diff -b`). Live-toggled from UI. */
	ignoreSpaceChange: boolean;
	/** Ignore all whitespace (`git diff -w`). Live-toggled from UI. */
	ignoreAllSpace: boolean;
	/** Canonical `source/credential-route/provider/model` selected for AI actions. */
	aiModel?: string | null;
	/** Model-specific reasoning choice used for the next explicit AI action. */
	aiReasoningEffort?: string | null;
	/** Model-specific service tier used for the next explicit AI action. */
	aiServiceTier?: string | null;
	/** Width of the shared diff/plan AI assistant rail. */
	aiRailWidth?: number;
	/** The user has acknowledged what review context is sent to a provider. */
	aiPrivacyAcknowledged?: boolean;
	/** Whether the shared AI Connections section is expanded in Settings. */
	aiSettingsExpanded?: boolean;
	/**
	 * Language servers used for AI definition/reference lookups, keyed by file
	 * extension without the dot (e.g. `ts`). Empty by default: diffing presumes
	 * no server and reports the feature unavailable until one is configured.
	 */
	aiLanguageServers?: Record<string, AiLanguageServer>;
	/** ISO timestamp when `diffing setup` last completed successfully. */
	setupCompletedAt?: string | null;
}

export interface SavedReply {
	id: string;
	title: string;
	body: string;
}

const DEFAULTS: Settings = {
	defaultMode: "web",
	staged: true,
	untracked: true,
	diffStyle: "split",
	defaultTabSize: 4,
	theme: "rose-pine",
	editorIDE: "default",
	lineDiffType: "word",
	lineWrap: false,
	diffIndicators: "classic",
	showLineNumbers: true,
	hunkSeparators: "line-info",
	lineHoverHighlight: "both",
	fontSize: 14,
	expandContextByDefault: false,
	collapsedContextThreshold: 10,
	expansionLineCount: 20,
	haptics: true,
	sounds: true,
	uiFont: null,
	monoFont: null,
	density: "comfortable",
	autoCollapseLineThreshold: 400,
	requireViewAllBeforeSend: false,
	showStatusBar: true,
	savedReplies: [],
	ignoreSpaceChange: false,
	ignoreAllSpace: false,
	aiModel: null,
	aiReasoningEffort: null,
	aiServiceTier: null,
	aiRailWidth: 360,
	aiPrivacyAcknowledged: false,
	aiSettingsExpanded: false,
	aiLanguageServers: {},
};

/**
 * Keeps only well-formed entries. A malformed server is dropped rather than
 * repaired, so a bad edit disables a lookup instead of running something odd.
 */
export function sanitizeLanguageServers(
	value: unknown,
): Record<string, AiLanguageServer> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const servers: Record<string, AiLanguageServer> = {};
	for (const [extension, entry] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (!/^[A-Za-z0-9_+-]{1,32}$/.test(extension)) continue;
		const server = entry as Partial<AiLanguageServer> | null;
		if (
			!server ||
			typeof server.command !== "string" ||
			!server.command.trim() ||
			server.command.length > 1024
		)
			continue;
		const args = server.args ?? [];
		if (
			!Array.isArray(args) ||
			args.length > 32 ||
			args.some((arg) => typeof arg !== "string" || arg.length > 1024)
		)
			continue;
		servers[extension.toLowerCase()] = { command: server.command, args };
	}
	return servers;
}

export function loadSettings(): Settings {
	try {
		const data = readFileSync(SETTINGS_FILE, "utf-8");
		const settings = { ...DEFAULTS, ...JSON.parse(data) } as Settings;
		if (settings.defaultMode !== "web" && settings.defaultMode !== "tui") {
			settings.defaultMode = DEFAULTS.defaultMode;
		}
		settings.aiLanguageServers = sanitizeLanguageServers(
			settings.aiLanguageServers,
		);
		return settings;
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveSettings(settings: Partial<Settings>): Settings {
	const current = loadSettings();
	const merged = { ...current, ...settings };
	writeJsonAtomically(SETTINGS_FILE, merged);
	return merged;
}

export function configDir(): string {
	return CONFIG_DIR;
}

export function settingsFilePath(): string {
	return SETTINGS_FILE;
}

export function ensureConfigDir(): void {
	mkdirSync(CONFIG_DIR, { recursive: true });
}

export function isSetupCompleted(): boolean {
	const at = loadSettings().setupCompletedAt;
	return typeof at === "string" && at.length > 0;
}

export function markSetupCompleted(): Settings {
	return saveSettings({ setupCompletedAt: new Date().toISOString() });
}

export function resetSetupCompleted(): Settings {
	return saveSettings({ setupCompletedAt: null });
}
