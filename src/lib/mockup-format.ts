import type {
	Mockup,
	MockupComment,
	MockupDecision,
	MockupMode,
	MockupViewport,
} from "./mockup-types.js";
import { commentViewport } from "./mockup-types.js";
import { decisionSummary } from "./plan-format.js";
import {
	escapeXmlAttribute as escapeAttr,
	escapeCdataText,
	joinReviewXml,
} from "./xml.js";
function mockupDecisionSummary(decision: MockupDecision): string {
	return decisionSummary(decision)
		.replaceAll("plan", "mockup")
		.replaceAll("Plan", "Mockup")
		.replaceAll("PLAN", "MOCKUP");
}

export interface FormatMockupReviewOptions {
	viewingVersion?: number;
	mode?: MockupMode;
	/** Optional focused screen at submit time — comment elements still carry screen=. */
	focusedScreen?: string;
	/** Optional focused viewport at submit time. */
	focusedViewport?: MockupViewport;
	/**
	 * Emit the full agent instructions block. Default (false) is the compact
	 * handoff XML: no instructions, terse attributes, everything an agent needs
	 * to act on the decision + comments. comment-only mode always gets a short
	 * no-edit instruction line.
	 */
	instructions?: boolean;
}

export function formatMockupReview(
	mockup: Mockup,
	options: FormatMockupReviewOptions = {},
): string {
	const { viewingVersion, mode, focusedScreen, focusedViewport, instructions } =
		options;
	const isHistorical =
		viewingVersion !== undefined && viewingVersion !== mockup.version;
	const versions = mockup.versions ?? [];
	const historical =
		isHistorical && versions.length > 0
			? versions.find((v) => v.version === viewingVersion)
			: undefined;
	const titleToRender = historical ? historical.title : mockup.title;
	const screensToRender = historical ? historical.screens : mockup.screens;
	const commentVersion = viewingVersion ?? mockup.version;
	const visibleComments = (mockup.comments ?? []).filter(
		(comment) =>
			comment.status === "open" &&
			comment.createdAtMockupVersion === commentVersion &&
			(!focusedScreen || comment.screenId === focusedScreen) &&
			(!focusedViewport || commentViewport(comment) === focusedViewport),
	);

	const modeAttr = mode && mode !== "standard" ? ` mode="${mode}"` : "";
	const screenAttr = focusedScreen
		? ` screen="${escapeAttr(focusedScreen)}"`
		: "";
	const viewportAttr = focusedViewport ? ` viewport="${focusedViewport}"` : "";
	const lines: string[] = [];
	lines.push("<mockup-review>");
	if (instructions || mode === "comment-only") {
		lines.push("  <instructions>");
		if (instructions) {
			lines.push(
				"    You are an AI coding assistant receiving a human review of an HTML mockup you submitted.",
			);
			if (mode === "comment-only") {
				lines.push(
					"    ⚠️ COMMENT-ONLY MODE: You MUST NOT edit any files or implement the mockup. Your only task is to reply to the comments below.",
				);
			} else {
				lines.push(
					'    - The "decision" attribute is the headline verdict: "approved", "rejected", "changes-requested", "comment-only", or "pending".',
				);
				lines.push("    - <decision-summary> tells you what to do next.");
				lines.push(
					'    - Each <comment> has kind="section|block|point" and screen="<id>".',
				);
				lines.push(
					"      Locate the spot from <html> (clicked node) and <context-html> (section/parent).",
				);
				lines.push(
					"      selector= is a CSS path to that node. target= is the data-diffing section when present.",
				);
				lines.push(
					"      Do NOT rely on x/y/rect — those change across screens and viewports.",
				);
				lines.push(
					"      Give each screen's elements stable ids (an id= or a data-diffing= name per",
				);
				lines.push(
					"      section/block) so anchors survive revisions and never drift to a different tab.",
				);
				lines.push(
					"      A comment whose anchor no longer exists in its screen is hidden from the canvas.",
				);
				lines.push(
					"      One state per screen: never use tabs/accordions/toggles/modals/JS content-swapping —",
				);
				lines.push("      each variant or case must be a separate screen.");
				lines.push('    - Only address comments with status="open".');
				lines.push('    - Optional severity="blocking|nit|question|praise".');
				lines.push("");
				lines.push("    HOW TO RESPOND:");
				lines.push("    - If approved: implement the mockup.");
				lines.push(
					"    - If changes-requested: revise the mockup and resubmit the same id.",
				);
				lines.push("    - If rejected: stop and rethink; do not implement.");
				lines.push(
					"    - If comment-only: do NOT implement; only reply to comments.",
				);
				lines.push("    Prefer the diffing CLI or MCP:");
				lines.push(
					'      diffing mockup reply <comment-id> --body "..." --model "<your-model-name>"',
				);
				lines.push("      diffing mockup resolve <comment-id>");
				lines.push("      diffing mockup submit <file-or-dir> --id <mockup-id>");
			}
		} else if (mode === "comment-only") {
			lines.push(
				"    COMMENT-ONLY MODE: reply to the comments below; do NOT edit files or implement the mockup.",
			);
		}
		lines.push("  </instructions>");
	}

	const decidedAttr = mockup.decidedAt
		? ` decided-at="${new Date(mockup.decidedAt).toISOString()}"`
		: "";
	const viewingAttr = isHistorical ? ` viewing-version="${viewingVersion}"` : "";
	const screenIds = (screensToRender ?? []).map((s) => s.id).join(",");
	lines.push(
		`  <mockup id="${escapeAttr(mockup.id)}" title="${escapeAttr(titleToRender)}" version="${mockup.version}" screens="${escapeAttr(screenIds)}" decision="${mockup.decision}"${decidedAttr}${viewingAttr}${modeAttr}${screenAttr}${viewportAttr}>`,
	);
	lines.push(
		`    <decision-summary><![CDATA[${escapeCdataText(mockupDecisionSummary(mockup.decision))}]]></decision-summary>`,
	);

	const trimmedDecisionComment = mockup.decisionComment?.trim();
	if (trimmedDecisionComment) {
		lines.push(
			`    <decision-comment><![CDATA[${escapeCdataText(trimmedDecisionComment)}]]></decision-comment>`,
		);
	}

	if (visibleComments.length > 0) {
		lines.push("    <comments>");
		for (const comment of visibleComments) {
			lines.push(formatComment(comment, mockup.version, Boolean(instructions)));
		}
		lines.push("    </comments>");
	}

	lines.push("  </mockup>");
	lines.push("</mockup-review>");
	return joinReviewXml(lines);
}

function formatComment(
	comment: MockupComment,
	fallbackVersion: number,
	includeContext: boolean,
): string {
	const isoDate = new Date(comment.createdAt).toISOString();
	const versionAttr = ` mockup-version="${comment.createdAtMockupVersion ?? fallbackVersion}"`;
	const viewportAttr = ` viewport="${commentViewport(comment)}"`;
	const severityAttr =
		comment.severity && comment.severity !== "none"
			? ` severity="${comment.severity}"`
			: "";
	const targetAttr = comment.target
		? ` target="${escapeAttr(comment.target)}"`
		: "";
	const selectorAttr = comment.selector
		? ` selector="${escapeAttr(comment.selector)}"`
		: "";
	const fingerprintAttr = comment.fingerprint
		? ` fingerprint="${escapeAttr(comment.fingerprint)}"`
		: "";
	const xAttr = comment.x === undefined ? "" : ` x="${comment.x}%"`;
	const yAttr = comment.y === undefined ? "" : ` y="${comment.y}%"`;
	const sectionXAttr =
		comment.sectionX === undefined ? "" : ` section-x="${comment.sectionX}%"`;
	const sectionYAttr =
		comment.sectionY === undefined ? "" : ` section-y="${comment.sectionY}%"`;
	const parts: string[] = [];
	parts.push(
		`      <comment id="${escapeAttr(comment.id)}" kind="${comment.kind}" screen="${escapeAttr(comment.screenId)}"${targetAttr}${selectorAttr}${fingerprintAttr}${xAttr}${yAttr}${sectionXAttr}${sectionYAttr} status="${comment.status}"${severityAttr} created-at="${isoDate}"${versionAttr}${viewportAttr}>`,
	);
	if (
		includeContext &&
		(comment.html?.trim() ||
			comment.contextHtml?.trim() ||
			comment.snapshot?.trim())
	) {
		parts.push("        <location>");
		if (comment.html?.trim()) {
			parts.push(
				`          <html><![CDATA[${escapeCdataText(comment.html.trim())}]]></html>`,
			);
		}
		if (comment.contextHtml?.trim()) {
			parts.push(
				`          <context-html><![CDATA[${escapeCdataText(comment.contextHtml.trim())}]]></context-html>`,
			);
		}
		if (comment.snapshot?.trim()) {
			parts.push(
				`          <snapshot><![CDATA[${escapeCdataText(comment.snapshot.trim())}]]></snapshot>`,
			);
		}
		parts.push("        </location>");
	}
	parts.push(`        <body><![CDATA[${escapeCdataText(comment.body)}]]></body>`);
	if (comment.replies && comment.replies.length > 0) {
		parts.push("        <replies>");
		for (const reply of comment.replies) {
			const replyIsoDate = new Date(reply.createdAt).toISOString();
			const roleAttr = reply.role
				? ` role="${escapeAttr(reply.role)}"`
				: ' role="agent"';
			const modelAttr = reply.model ? ` model="${escapeAttr(reply.model)}"` : "";
			parts.push(
				`          <reply id="${escapeAttr(reply.id)}" created-at="${replyIsoDate}"${roleAttr}${modelAttr}>`,
			);
			parts.push(`            <![CDATA[${escapeCdataText(reply.body)}]]>`);
			parts.push("          </reply>");
		}
		parts.push("        </replies>");
	}
	parts.push("      </comment>");
	return parts.join("\n");
}
