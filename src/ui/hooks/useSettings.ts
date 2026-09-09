import { useState, useEffect, useCallback, useRef } from "react";

export type LineDiffType = "word" | "word-alt" | "char" | "none";
export type DiffIndicators = "classic" | "bars" | "none";
export type HunkSeparatorStyle =
	| "simple"
	| "metadata"
	| "line-info"
	| "line-info-basic";
export type LineHoverHighlight = "disabled" | "both" | "number" | "line";

export interface Settings {
	/** Interactive mode used when no explicit output-mode flag is provided. */
	defaultMode: "web" | "tui";
	staged: boolean;
	untracked: boolean;
	diffStyle: "split" | "unified";
	defaultTabSize: number;
	browser?: string;
	theme: string;
	editorIDE?: "default" | "vscode" | "zed" | "vim" | "neovim" | "ghostty";
	lineDiffType: LineDiffType;
	lineWrap: boolean;
	diffIndicators: DiffIndicators;
	showLineNumbers: boolean;
	hunkSeparators: HunkSeparatorStyle;
	lineHoverHighlight: LineHoverHighlight;
	fontSize: number;
	expandContextByDefault: boolean;
	collapsedContextThreshold: number;
	expansionLineCount: number;
	/** Tactile feedback (web-haptics) on interaction. */
	haptics: boolean;
	/** Synthesized audio feedback on interaction. */
	sounds: boolean;
	/** UI font family override. null/undefined = default (Geist Mono from CDN). */
	uiFont?: string | null;
	/** Code/diff/plans font family override. null/undefined = default (JetBrains Mono from CDN). */
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
	savedReplies: SavedReply[];
	ignoreSpaceChange: boolean;
	ignoreAllSpace: boolean;
	/**
	 * Opt-in inline diagnostics (markers) on the in-place edit surface.
	 * Off by default so users who want a noise-free review never see them.
	 */
	editDiagnostics: boolean;
	/**
	 * Opt-in language-server hover and go-to-declaration in the diff.
	 * Off by default; requires a configured language server to do anything.
	 */
	codeIntel: boolean;
	/**
	 * Opt-in ghost-text edit prediction while editing in place. Off by default.
	 * Hold Alt to show a suggestion from the configured AI model.
	 */
	editPrediction: boolean;
	aiModel?: string | null;
	aiReasoningEffort?: string | null;
	aiServiceTier?: string | null;
	aiRailWidth?: number;
	aiPrivacyAcknowledged?: boolean;
	aiSettingsExpanded?: boolean;
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
	editDiagnostics: false,
	codeIntel: false,
	editPrediction: false,
	aiModel: null,
	aiReasoningEffort: null,
	aiServiceTier: null,
	aiRailWidth: 360,
	aiPrivacyAcknowledged: false,
	aiSettingsExpanded: false,
};

const MONO_FALLBACK =
	'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/** Returns the fully-resolved font-family CSS value for code/diff rendering. */
export function resolveMonoFont(monoFont?: string | null): string {
	return monoFont
		? `"${monoFont}", ${MONO_FALLBACK}`
		: `"JetBrains Mono", ${MONO_FALLBACK}`;
}

export function useSettings() {
	const [settings, setSettings] = useState<Settings>(DEFAULTS);
	const [loaded, setLoaded] = useState(false);

	// Skip persisting the very first state we hydrate from the server.
	const skipPersistRef = useRef(true);

	useEffect(() => {
		fetch("/api/settings")
			.then((res) => res.json())
			.then((data) => {
				skipPersistRef.current = true;
				setSettings({ ...DEFAULTS, ...data });
				setLoaded(true);
			})
			.catch(() => setLoaded(true));
	}, []);

	// AiProvider spans every route while each surface owns a local useSettings
	// instance. Mirror AI preference changes into that local copy so a later
	// display-setting save cannot overwrite the globally selected model.
	useEffect(() => {
		const onAiSettings = (event: Event) => {
			const patch = (event as CustomEvent<Partial<Settings>>).detail;
			if (!patch) return;
			setSettings((prev) => ({ ...prev, ...patch }));
		};
		window.addEventListener("diffing-ai-settings", onAiSettings);
		return () => window.removeEventListener("diffing-ai-settings", onAiSettings);
	}, []);

	// Persist settings whenever they change, debounced. Keeping the network
	// write out of the state updater keeps the updater pure (no double PUT in
	// StrictMode) and coalesces rapid changes (e.g. dragging font size).
	useEffect(() => {
		if (skipPersistRef.current) {
			skipPersistRef.current = false;
			return;
		}
		const id = setTimeout(() => {
			fetch("/api/settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(settings),
			}).catch(() => {});
		}, 300);
		return () => clearTimeout(id);
	}, [settings]);

	const updateSettings = useCallback((patch: Partial<Settings>) => {
		setSettings((prev) => ({ ...prev, ...patch }));
	}, []);

	return { settings, loaded, updateSettings };
}
