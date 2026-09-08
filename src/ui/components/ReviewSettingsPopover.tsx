import { useEffect, useState } from "react";
import { LayoutGrid, Palette, Settings, Sparkles, Type } from "lucide-react";
import type { DiffOptions } from "../hooks/useDiff";
import type {
	DiffIndicators,
	HunkSeparatorStyle,
	LineDiffType,
	LineHoverHighlight,
} from "../hooks/useSettings";
import { Popover } from "../primitives/Popover";
import { Select } from "../primitives/Select";
import { AiConnectionsPanel } from "../ai/AiConnectionsPanel";

export interface ReviewSettingsPopoverProps {
	diffStyle: "split" | "unified";
	diffOptions?: DiffOptions;
	defaultTabSize: number;
	browser?: string;
	editorIDE?: string;
	lineDiffType: LineDiffType;
	lineWrap: boolean;
	diffIndicators: DiffIndicators;
	showLineNumbers: boolean;
	hunkSeparators: HunkSeparatorStyle;
	lineHoverHighlight: LineHoverHighlight;
	fontSize: number;
	haptics: boolean;
	sounds: boolean;
	uiFont?: string | null;
	monoFont?: string | null;
	density: "comfortable" | "compact";
	autoCollapseLineThreshold: number;
	requireViewAllBeforeSend?: boolean;
	showStatusBar: boolean;
	ignoreSpaceChange?: boolean;
	ignoreAllSpace?: boolean;
	/** Opt-in inline diagnostics while editing in place. */
	editDiagnostics: boolean;
	/** Opt-in language-server hover and go-to-declaration in the diff. */
	codeIntel: boolean;
	/** Why code intel cannot answer for this review, when it cannot. */
	codeIntelUnavailable?: string;
	onDiffStyleChange: (style: "split" | "unified") => void;
	onDiffOptionsChange?: (options: DiffOptions) => void;
	onDefaultTabSizeChange: (size: number) => void;
	onBrowserChange?: (browser: string) => void;
	onOpenThemeModal: () => void;
	onEditorIDEChange?: (editor: string) => void;
	onLineDiffTypeChange: (v: LineDiffType) => void;
	onLineWrapChange: (v: boolean) => void;
	onDiffIndicatorsChange: (v: DiffIndicators) => void;
	onShowLineNumbersChange: (v: boolean) => void;
	onHunkSeparatorsChange: (v: HunkSeparatorStyle) => void;
	onLineHoverHighlightChange: (v: LineHoverHighlight) => void;
	onFontSizeChange: (v: number) => void;
	onHapticsChange: (v: boolean) => void;
	onSoundsChange: (v: boolean) => void;
	onDensityChange: (v: "comfortable" | "compact") => void;
	onAutoCollapseLineThresholdChange: (v: number) => void;
	onRequireViewAllBeforeSendChange?: (v: boolean) => void;
	onShowStatusBarChange: (v: boolean) => void;
	onIgnoreSpaceChange?: (v: boolean) => void;
	onIgnoreAllSpaceChange?: (v: boolean) => void;
	onEditDiagnosticsChange: (v: boolean) => void;
	onCodeIntelChange: (v: boolean) => void;
	onOpenUiFontModal: () => void;
	onOpenMonoFontModal: () => void;
	showSource?: boolean;
	showWhitespace?: boolean;
	showExternalTools?: boolean;
	showSendPolicy?: boolean;
}

const INLINE_DIFF_OPTS = [
	{ value: "word", label: "Word" },
	{ value: "word-alt", label: "Word (alt)" },
	{ value: "char", label: "Character" },
	{ value: "none", label: "None" },
];
const INDICATOR_OPTS = [
	{ value: "classic", label: "Classic (+/−)" },
	{ value: "bars", label: "Bars" },
	{ value: "none", label: "None" },
];
const HUNK_SEP_OPTS = [
	{ value: "line-info", label: "Line info + context" },
	{ value: "line-info-basic", label: "Line info" },
	{ value: "metadata", label: "Metadata only" },
	{ value: "simple", label: "Simple" },
];
const HOVER_OPTS = [
	{ value: "both", label: "Both" },
	{ value: "line", label: "Line only" },
	{ value: "number", label: "Number only" },
	{ value: "disabled", label: "Disabled" },
];
const FONT_SIZE_OPTS = [12, 13, 14, 15, 16, 17, 18].map((n) => ({
	value: String(n),
	label: `${n}px`,
}));
const TAB_SIZE_OPTS = [2, 4, 8].map((n) => ({
	value: String(n),
	label: String(n),
}));
const DENSITY_OPTS = [
	{ value: "comfortable", label: "Comfortable" },
	{ value: "compact", label: "Compact" },
];
const AUTO_COLLAPSE_OPTS = [
	{ value: "0", label: "Disabled" },
	{ value: "100", label: "100 lines" },
	{ value: "200", label: "200 lines" },
	{ value: "400", label: "400 lines" },
	{ value: "800", label: "800 lines" },
];
const BROWSER_OPTS = [
	{ value: "", label: "Default" },
	{ value: "chrome", label: "Chrome" },
	{ value: "firefox", label: "Firefox" },
	{ value: "edge", label: "Edge" },
	{ value: "brave", label: "Brave" },
];
const IDE_OPTS = [
	{ value: "default", label: "Default / System" },
	{ value: "vscode", label: "VS Code" },
	{ value: "zed", label: "Zed" },
	{ value: "vim", label: "Vim" },
	{ value: "neovim", label: "Neovim" },
	{ value: "ghostty", label: "Neovim (Ghostty)" },
];

export function ReviewSettingsPopover({
	diffStyle,
	diffOptions,
	defaultTabSize,
	browser,
	editorIDE,
	lineDiffType,
	lineWrap,
	diffIndicators,
	showLineNumbers,
	hunkSeparators,
	lineHoverHighlight,
	fontSize,
	haptics,
	sounds,
	uiFont,
	monoFont,
	density,
	autoCollapseLineThreshold,
	requireViewAllBeforeSend = false,
	showStatusBar,
	ignoreSpaceChange = false,
	editDiagnostics = false,
	codeIntel = false,
	codeIntelUnavailable,
	ignoreAllSpace = false,
	onDiffStyleChange,
	onDiffOptionsChange,
	onDefaultTabSizeChange,
	onBrowserChange,
	onOpenThemeModal,
	onEditorIDEChange,
	onLineDiffTypeChange,
	onLineWrapChange,
	onDiffIndicatorsChange,
	onShowLineNumbersChange,
	onHunkSeparatorsChange,
	onLineHoverHighlightChange,
	onFontSizeChange,
	onHapticsChange,
	onSoundsChange,
	onDensityChange,
	onAutoCollapseLineThresholdChange,
	onRequireViewAllBeforeSendChange,
	onShowStatusBarChange,
	onIgnoreSpaceChange,
	onIgnoreAllSpaceChange,
	onEditDiagnosticsChange,
	onCodeIntelChange,
	onOpenUiFontModal,
	onOpenMonoFontModal,
	showSource = true,
	showWhitespace = true,
	showExternalTools = true,
	showSendPolicy = true,
}: ReviewSettingsPopoverProps) {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				(event.metaKey || event.ctrlKey) &&
				(event.key === "," || event.code === "Comma")
			) {
				event.preventDefault();
				setOpen((value) => !value);
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, []);

	return (
		<Popover
			open={open}
			onOpenChange={setOpen}
			ariaLabel="Settings"
			className="settings-popover"
			trigger={
				<button
					className={`btn btn-sm settings-btn ${open ? "btn-active" : ""}`}
					title="Settings (⌘,)"
					aria-label="Settings"
				>
					<Settings size={14} />
					<span className="btn-label">Settings</span>
				</button>
			}
		>
			<div className="popover-scroll settings-panel">
				<AiConnectionsPanel />
				{showSource && diffOptions && onDiffOptionsChange && (
					<>
						<div className="settings-section-label">Source</div>
						<label className="settings-item">
							<input
								type="checkbox"
								checked={diffOptions.staged}
								onChange={(event) =>
									onDiffOptionsChange({
										...diffOptions,
										staged: event.target.checked,
									})
								}
							/>
							Show staged
						</label>
						<label className="settings-item">
							<input
								type="checkbox"
								checked={diffOptions.untracked}
								onChange={(event) =>
									onDiffOptionsChange({
										...diffOptions,
										untracked: event.target.checked,
									})
								}
							/>
							Show untracked
						</label>
					</>
				)}

				<div className="settings-section-label">Display</div>
				<div className="settings-item settings-item-spaced">
					<span>Inline diff</span>
					<Select
						value={lineDiffType}
						onValueChange={(value) =>
							onLineDiffTypeChange(value as LineDiffType)
						}
						options={INLINE_DIFF_OPTS}
						ariaLabel="Inline diff style"
					/>
				</div>
				<label className="settings-item">
					<input
						type="checkbox"
						checked={lineWrap}
						onChange={(event) => onLineWrapChange(event.target.checked)}
					/>
					Wrap long lines
				</label>
				<div className="settings-item settings-item-spaced">
					<span>Diff indicators</span>
					<Select
						value={diffIndicators}
						onValueChange={(value) =>
							onDiffIndicatorsChange(value as DiffIndicators)
						}
						options={INDICATOR_OPTS}
						ariaLabel="Diff indicators"
					/>
				</div>
				<label className="settings-item">
					<input
						type="checkbox"
						checked={showLineNumbers}
						onChange={(event) => onShowLineNumbersChange(event.target.checked)}
					/>
					Show line numbers
				</label>
				<div className="settings-item settings-item-spaced">
					<span>Hunk separator</span>
					<Select
						value={hunkSeparators}
						onValueChange={(value) =>
							onHunkSeparatorsChange(value as HunkSeparatorStyle)
						}
						options={HUNK_SEP_OPTS}
						ariaLabel="Hunk separator style"
					/>
				</div>
				<div className="settings-item settings-item-spaced">
					<span>Hover highlight</span>
					<Select
						value={lineHoverHighlight}
						onValueChange={(value) =>
							onLineHoverHighlightChange(value as LineHoverHighlight)
						}
						options={HOVER_OPTS}
						ariaLabel="Hover highlight"
					/>
				</div>
				<div className="settings-item settings-item-spaced">
					<span>Font size</span>
					<Select
						value={String(fontSize)}
						onValueChange={(value) => onFontSizeChange(Number(value))}
						options={FONT_SIZE_OPTS}
						ariaLabel="Font size"
					/>
				</div>
				<div className="settings-item settings-item-spaced">
					<span>Default tab size</span>
					<Select
						value={String(defaultTabSize)}
						onValueChange={(value) => onDefaultTabSizeChange(Number(value))}
						options={TAB_SIZE_OPTS}
						ariaLabel="Default tab size"
					/>
				</div>
				<div className="settings-item settings-item-spaced">
					<span>UI font</span>
					<button
						className="btn btn-sm settings-btn"
						onClick={() => {
							setOpen(false);
							onOpenUiFontModal();
						}}
						title={uiFont ?? "Default (Geist Mono)"}
					>
						<Type size={13} />
						<span className="settings-value-label">{uiFont ?? "Default…"}</span>
					</button>
				</div>

				<div className="settings-section-label">Comfort</div>
				<div className="settings-item settings-item-spaced">
					<span>Density</span>
					<Select
						value={density}
						onValueChange={(value) =>
							onDensityChange(value as "comfortable" | "compact")
						}
						options={DENSITY_OPTS}
						ariaLabel="UI density"
					/>
				</div>
				<div className="settings-item settings-item-spaced">
					<span>Auto-collapse huge files</span>
					<Select
						value={String(autoCollapseLineThreshold)}
						onValueChange={(value) =>
							onAutoCollapseLineThresholdChange(Number(value))
						}
						options={AUTO_COLLAPSE_OPTS}
						ariaLabel="Auto-collapse line threshold"
					/>
				</div>
				{showSendPolicy && onRequireViewAllBeforeSendChange && (
					<label className="settings-item">
						<input
							type="checkbox"
							checked={requireViewAllBeforeSend}
							onChange={(event) =>
								onRequireViewAllBeforeSendChange(event.target.checked)
							}
						/>
						<span className="settings-icon-label">
							<Sparkles size={12} /> Warn before sending if files are unviewed
						</span>
					</label>
				)}
				<label className="settings-item">
					<input
						type="checkbox"
						checked={showStatusBar}
						onChange={(event) => onShowStatusBarChange(event.target.checked)}
					/>
					<span className="settings-icon-label">
						<LayoutGrid size={12} /> Show status bar
					</span>
				</label>

				{showWhitespace && onIgnoreSpaceChange && onIgnoreAllSpaceChange && (
					<>
						<div className="settings-section-label">Whitespace</div>
						<label className="settings-item">
							<input
								type="checkbox"
								checked={ignoreSpaceChange}
								onChange={(event) => onIgnoreSpaceChange(event.target.checked)}
							/>
							Ignore space-change (-b)
						</label>
						<label className="settings-item">
							<input
								type="checkbox"
								checked={ignoreAllSpace}
								onChange={(event) =>
									onIgnoreAllSpaceChange(event.target.checked)
								}
							/>
							Ignore all space (-w)
						</label>
					</>
				)}

				<div className="settings-item settings-item-spaced">
					<span>Code font</span>
					<button
						className="btn btn-sm settings-btn"
						onClick={() => {
							setOpen(false);
							onOpenMonoFontModal();
						}}
						title={monoFont ?? "Default (JetBrains Mono)"}
					>
						<Type size={13} />
						<span className="settings-value-label">
							{monoFont ?? "Default…"}
						</span>
					</button>
				</div>

				{showExternalTools && (
					<>
						<div className="settings-section-label">External tools</div>
						{onBrowserChange && (
							<div className="settings-item settings-item-spaced">
								<span>Browser</span>
								<Select
									value={browser || ""}
									onValueChange={onBrowserChange}
									options={BROWSER_OPTS}
									ariaLabel="Browser"
								/>
							</div>
						)}
						{onEditorIDEChange && (
							<div className="settings-item settings-item-spaced">
								<span>Preferred IDE</span>
								<Select
									value={editorIDE || "default"}
									onValueChange={onEditorIDEChange}
									options={IDE_OPTS}
									ariaLabel="Preferred IDE"
								/>
							</div>
						)}
					</>
				)}

				<div className="settings-section-label">Appearance</div>
				<div className="settings-item settings-item-spaced">
					<span>Diff style</span>
					<Select
						value={diffStyle}
						onValueChange={(value) =>
							onDiffStyleChange(value as "split" | "unified")
						}
						options={[
							{ value: "split", label: "Split" },
							{ value: "unified", label: "Unified" },
						]}
						ariaLabel="Diff style"
					/>
				</div>
				<div className="settings-item settings-item-spaced">
					<span>Theme</span>
					<button
						className="btn btn-sm settings-btn"
						onClick={() => {
							setOpen(false);
							onOpenThemeModal();
						}}
					>
						<Palette size={14} /> Switch Theme…
					</button>
				</div>

				<div className="settings-section-label">Feedback</div>
				<label className="settings-item">
					<input
						type="checkbox"
						checked={haptics}
						onChange={(event) => onHapticsChange(event.target.checked)}
					/>
					Haptic feedback
				</label>
				<label className="settings-item">
					<input
						type="checkbox"
						checked={sounds}
						onChange={(event) => onSoundsChange(event.target.checked)}
					/>
					Sound effects
				</label>

				<div className="settings-section-label">Editing</div>
				<label
					className="settings-item"
					title="Inline diagnostics (whitespace, missing final newline, tabs) while editing a file in place. Off by default for a noise-free review."
				>
					<input
						type="checkbox"
						checked={editDiagnostics}
						onChange={(event) => onEditDiagnosticsChange(event.target.checked)}
					/>
					Edit diagnostics
				</label>
				<label
					className="settings-item"
					title={
						codeIntelUnavailable
							? `Code intel is unavailable for this review: ${codeIntelUnavailable}`
							: "Hover a token for its type and docs, and modifier-click to jump to its declaration. Needs a language server configured for the file's extension."
					}
				>
					<input
						type="checkbox"
						checked={codeIntel}
						disabled={Boolean(codeIntelUnavailable)}
						onChange={(event) => onCodeIntelChange(event.target.checked)}
					/>
					Code intel (hover, go to declaration)
				</label>
			</div>
		</Popover>
	);
}
