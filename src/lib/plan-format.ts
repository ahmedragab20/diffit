import type { Plan, PlanComment, PlanDecision, PlanMode } from './plan-types.js'
import { escapeXmlAttribute as escapeAttr, escapeCdataText, joinReviewXml } from './xml.js'

/**
 * Serialize a reviewed plan into the `<plan-review>` XML envelope handed back to
 * a waiting agent. The diff-review counterpart is {@link formatComments}; this
 * keeps the two handoffs structurally consistent so an agent learns one shape.
 *
 * Shared by the server's `/api/plan-review/await` handoff, the `diffing plan`
 * CLI, and the MCP server so every channel emits byte-identical output.
 */

/** Human-readable guidance the agent should act on, derived from the verdict. */
export function decisionSummary(decision: PlanDecision): string {
  switch (decision) {
    case 'approved':
      return 'The reviewer APPROVED this plan. Proceed with implementation exactly as described, taking any inline comments into account.'
    case 'rejected':
      return 'The reviewer REJECTED this plan. Do NOT proceed. Reconsider the approach based on the comments; only continue once a new plan is approved.'
    case 'changes-requested':
      return 'The reviewer REQUESTED CHANGES. Revise the plan to address every open comment below, then resubmit the updated plan for re-review (do not start implementation yet).'
    case 'comment-only':
      return 'The reviewer chose COMMENT-ONLY mode. You MUST NOT edit any files or implement the plan. Only reply to the comments below — answer questions, provide clarification, or discuss. The decision comment (if present) is your prompt for this chat.'
    default:
      return 'This plan has not been decided yet. Wait for the reviewer to approve, reject, or request changes.'
  }
}

/**
 * Resolve the line label for a plan comment: `plan` for whole-plan notes,
 * `12-15` for a multi-line selection, otherwise the single line number.
 */
function lineLabel(comment: PlanComment): string {
  if (comment.lineNumber === 0) return 'plan'
  if (comment.startLineNumber && comment.startLineNumber !== comment.lineNumber) {
    return `${comment.startLineNumber}-${comment.lineNumber}`
  }
  return `${comment.lineNumber}`
}

export interface FormatPlanReviewOptions {
  /**
   * When set, emit a `<plan-body>` for this historical version instead of
   * the current one, and tag the `<plan>` element with `viewing-version`.
   * Comments whose `createdAtPlanVersion` doesn't match `viewingVersion`
   * are filtered out so the agent only sees feedback anchored to the
   * version it just received.
   */
  viewingVersion?: number
  /** Mode controlling agent behavior: 'standard' (default) or 'comment-only'. */
  mode?: PlanMode
}

export function formatPlanReview(plan: Plan, options: FormatPlanReviewOptions = {}): string {
  const { viewingVersion, mode } = options
  // When reading a historical version we render that version's body and
  // filter comments to those anchored to it.
  const isHistorical = viewingVersion !== undefined && viewingVersion !== plan.version
  const versions = plan.versions ?? []
  const historical =
    isHistorical && versions.length > 0 ? versions.find((v) => v.version === viewingVersion) : undefined
  const bodyToRender = historical ? historical.body : plan.body
  const titleToRender = historical ? historical.title : plan.title
  const visibleComments = isHistorical
    ? (plan.comments ?? []).filter((c) => c.createdAtPlanVersion === viewingVersion)
    : plan.comments ?? []

  const modeAttr = mode && mode !== 'standard' ? ` mode="${mode}"` : ''
  const lines: string[] = []
  lines.push('<plan-review>')
  lines.push('  <instructions>')
  lines.push('    You are an AI coding assistant receiving a human review of a plan you submitted.')
  if (mode === 'comment-only') {
    lines.push('    ⚠️ COMMENT-ONLY MODE: You MUST NOT edit any files or implement the plan. Your only task is to reply to the comments below — answer questions, provide clarification, or discuss. The decision comment (if present) is your prompt for this chat.')
  } else {
    lines.push('    - The "decision" attribute is the headline verdict: "approved", "rejected", "changes-requested", "comment-only", or "pending".')
    lines.push('    - <decision-summary> tells you, in plain language, what to do next based on that verdict.')
    lines.push('    - <decision-comment> is the reviewer\'s overall note (may be absent).')
    lines.push('    - <plan-body> is the exact markdown of the plan being reviewed. Inline comments target lines within it.')
    lines.push('    - Each <comment> targets a line ("line=42"), a range ("line=12-15"), or the whole plan ("line=plan").')
    lines.push('      "section" names the nearest markdown heading for context. Only address comments with status="open".')
    lines.push('    - <context> is structured: <quote> is the exact text the human highlighted (when present);')
    lines.push('      <source line="N" end-line="M"> is the full plan source line(s). Prefer <quote> when deciding what they meant.')
    lines.push('    - Optional severity="blocking|nit|question|praise" on <comment>: treat blocking as must-fix,')
    lines.push('      nit as optional polish, question as needing an answer, praise as positive note (no action required).')
    lines.push('')
    lines.push('    HOW TO RESPOND:')
    lines.push('    - If approved: proceed with the work.')
    lines.push('    - If changes-requested: revise the plan and resubmit it for another review round.')
    lines.push('    - If rejected: stop and rethink; do not implement.')
    lines.push('    - If comment-only: do NOT implement; only reply to comments.')
    lines.push('    Prefer the diffing CLI or MCP (port-agnostic, no copy-paste):')
    lines.push('      diffing plan reply <comment-id> --body "..." --model "<your-model-name>"')
    lines.push('      diffing plan resolve <comment-id>')
    lines.push('      diffing plan submit <revised-plan.md> --id <plan-id>   # resubmit a new version for re-review')
    lines.push('    (Or the equivalent MCP tools: reply_to_plan_comment, resolve_plan_comment, submit_plan.)')
  }
  lines.push('  </instructions>')

  const decidedAttr = plan.decidedAt ? ` decided-at="${new Date(plan.decidedAt).toISOString()}"` : ''
  const viewingAttr = isHistorical ? ` viewing-version="${viewingVersion}"` : ''
  lines.push(
    `  <plan id="${escapeAttr(plan.id)}" title="${escapeAttr(titleToRender)}" version="${plan.version}" decision="${plan.decision}"${decidedAttr}${viewingAttr}${modeAttr}>`,
  )
  lines.push(`    <decision-summary><![CDATA[${escapeCdataText(decisionSummary(plan.decision))}]]></decision-summary>`)

  const trimmedDecisionComment = plan.decisionComment?.trim()
  if (trimmedDecisionComment) {
    lines.push(`    <decision-comment><![CDATA[${escapeCdataText(trimmedDecisionComment)}]]></decision-comment>`)
  }

  if (isHistorical) {
    lines.push(
      `    <viewing-version-info><![CDATA[Reviewing historical version ${viewingVersion} of ${plan.version}. Comments are filtered to those anchored to v${viewingVersion}.]]></viewing-version-info>`,
    )
  }

  lines.push(`    <plan-body><![CDATA[${escapeCdataText(bodyToRender)}]]></plan-body>`)

  if (visibleComments.length > 0) {
    lines.push('    <comments>')
    for (const comment of visibleComments) {
      const sectionAttr = comment.sectionTitle ? ` section="${escapeAttr(comment.sectionTitle)}"` : ''
      const isoDate = new Date(comment.createdAt).toISOString()
      const versionAttr = ` plan-version="${comment.createdAtPlanVersion ?? plan.version}"`
      const severityAttr =
        comment.severity && comment.severity !== 'none'
          ? ` severity="${comment.severity}"`
          : ''
      lines.push(
        `      <comment id="${escapeAttr(comment.id)}" line="${escapeAttr(lineLabel(comment))}"${sectionAttr} status="${comment.status}"${severityAttr} created-at="${isoDate}"${versionAttr}>`,
      )
      if (comment.lineNumber !== 0 && (comment.lineContent || comment.selectedQuote)) {
        const start = comment.startLineNumber && comment.startLineNumber !== comment.lineNumber
          ? comment.startLineNumber
          : comment.lineNumber
        const end = comment.lineNumber
        const endAttr = end !== start ? ` end-line="${end}"` : ''
        lines.push(`        <context line="${start}"${endAttr}>`)
        if (comment.selectedQuote?.trim()) {
          lines.push(`          <quote><![CDATA[${escapeCdataText(comment.selectedQuote.trim())}]]></quote>`)
        }
        if (comment.lineContent) {
          lines.push(
            `          <source line="${start}"${endAttr}><![CDATA[${escapeCdataText(comment.lineContent)}]]></source>`,
          )
        }
        lines.push('        </context>')
      }
      lines.push(`        <body><![CDATA[${escapeCdataText(comment.body)}]]></body>`)

      if (comment.replies && comment.replies.length > 0) {
        lines.push('        <replies>')
        for (const reply of comment.replies) {
          const replyIsoDate = new Date(reply.createdAt).toISOString()
          const roleAttr = reply.role ? ` role="${escapeAttr(reply.role)}"` : ' role="agent"'
          const modelAttr = reply.model ? ` model="${escapeAttr(reply.model)}"` : ''
          lines.push(`          <reply id="${escapeAttr(reply.id)}" created-at="${replyIsoDate}"${roleAttr}${modelAttr}>`)
          lines.push(`            <![CDATA[${escapeCdataText(reply.body)}]]>`)
          lines.push('          </reply>')
        }
        lines.push('        </replies>')
      }
      lines.push('      </comment>')
    }
    lines.push('    </comments>')
  }

  lines.push('  </plan>')
  lines.push('</plan-review>')
  return joinReviewXml(lines)
}

/**
 * Find the nearest markdown ATX heading at or above a 1-based line, so a comment
 * can record which section of the plan it belongs to. Returns the heading text
 * without the leading `#`s, or undefined when the line precedes any heading.
 */
export function sectionTitleForLine(body: string, lineNumber: number): string | undefined {
  if (lineNumber < 1) return undefined
  const lines = body.split('\n')
  const end = Math.min(lineNumber, lines.length)
  for (let i = end - 1; i >= 0; i--) {
    const match = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i])
    if (match) return match[2].trim()
  }
  return undefined
}

/**
 * Snapshot the plan text spanned by a 1-based, inclusive [start, end] line
 * range, used as the `lineContent` anchor when a comment is created without one
 * (e.g. posted by an agent over the API).
 */
export function extractPlanLines(body: string, startLine: number, endLine: number): string {
  if (startLine < 1) return ''
  const lines = body.split('\n')
  const from = Math.max(1, startLine)
  const to = Math.min(endLine, lines.length)
  if (to < from) return ''
  return lines.slice(from - 1, to).join('\n')
}
