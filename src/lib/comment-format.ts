import type { ReviewComment, ReviewDecision, ReviewMode } from './types.js'
import { escapeXmlAttribute as escapeAttr, escapeCdataText, joinReviewXml } from './xml.js'

/** Plain-language guidance the agent should act on, derived from the verdict. */
export function reviewDecisionSummary(decision: ReviewDecision): string {
  switch (decision) {
    case 'approved':
      return 'The reviewer APPROVED these changes. Address any open comments below, then proceed — the overall direction is good.'
    case 'changes-requested':
      return 'The reviewer REQUESTED EDITS. Address every open comment below and apply the requested changes before considering this review done.'
    case 'rejected':
      return 'The reviewer REJECTED these changes. Do NOT keep building on this approach; reconsider it in light of the comments below before continuing.'
    case 'comment-only':
      return 'The reviewer chose COMMENT-ONLY mode. You MUST NOT edit any files. Only reply to the comments below — answer questions, provide clarification, or discuss. The general comment (if any) is your prompt for the chat.'
  }
}

/**
 * Render review comments as the `<code-review-comments>` XML envelope used to
 * hand a review to an AI agent. Shared by the UI clipboard button
 * (`useComments.formatAllComments`), the server's `/api/review/send` handoff,
 * and the `diffing` CLI/MCP so every channel emits byte-identical output.
 *
 * A review may carry a headline `decision` (approve / request edits / reject / comment-only)
 * and/or an overall comment, so the envelope is emitted even with zero inline
 * comments — letting a reviewer submit a verdict without annotating any line.
 */
export function formatComments(
  comments: ReviewComment[],
  generalComment?: string,
  decision?: ReviewDecision,
  mode?: ReviewMode,
): string {
  const trimmedGeneral = generalComment?.trim()
  // Nothing to hand off: no inline comments, no verdict, no overall note.
  if (comments.length === 0 && !decision && !trimmedGeneral) return ''

  const grouped = new Map<string, ReviewComment[]>()
  for (const comment of comments) {
    const list = grouped.get(comment.filePath) ?? []
    list.push(comment)
    grouped.set(comment.filePath, list)
  }
  // Alphabetical file order so handoff XML is stable across clients/reloads.
  const sortedFilePaths = [...grouped.keys()].sort((a, b) => a.localeCompare(b))

  const modeAttr = mode && mode !== 'standard' ? ` mode="${escapeAttr(mode)}"` : ''
  const lines: string[] = []
  lines.push(decision ? `<code-review-comments decision="${escapeAttr(decision)}"${modeAttr}>` : `<code-review-comments${modeAttr}>`)
  lines.push('  <instructions>')
  lines.push('    You are an AI coding assistant. You are receiving a structured list of code review comments to address in the repository.')
  if (mode === 'comment-only') {
    lines.push('    ⚠️ COMMENT-ONLY MODE: You MUST NOT edit any files. Your only task is to reply to the comments below — answer questions, provide clarification, or discuss. The general comment (if present) is your prompt for this chat.')
  } else {
    lines.push('    For each file, review the inline comments and apply the changes requested.')
  }
  if (decision) {
    lines.push('    - The "decision" attribute on the root element is the reviewer\'s headline verdict: "approved", "changes-requested", "rejected", or "comment-only".')
    lines.push('    - <decision-summary> tells you, in plain language, what to do next based on that verdict.')
  }
  if (mode) {
    lines.push(`    - The "mode" attribute on the root element controls your behavior: "standard" (apply edits) or "comment-only" (reply only, no edits).`)
  }
  lines.push('    - Target lines are specified by the "line" attribute (e.g. line="10" or line="10-15").')
  lines.push('    - When line="A-B", the range is INCLUSIVE on that side (both A and B and every line between). Address the whole span, not only the last line.')
  lines.push('    - "side" indicates whether the comment is on "additions" (added/modified lines) or "deletions" (deleted/old lines).')
  lines.push('    - "status" indicates whether the comment is "open" or "resolved". Only address comments with status="open".')
  lines.push('    - Optional severity="blocking|nit|question|praise":')
  lines.push('        blocking = must fix before considering the review done;')
  lines.push('        nit = optional polish; question = needs an answer; praise = positive (no change required).')
  lines.push('      Omit severity (or severity="none") means untriaged — treat as a normal request.')
  lines.push('    - The <code> block contains the specific code context at the reviewed lines, prefixed with "+" or "-".')
  lines.push('    - The <body> tag contains the review feedback or request.')
  lines.push('    - If developers have replied to the comment, their discussion is captured under the <replies> element.')
  lines.push('    - The comment "id" attribute can be used to reference or update the comment via API if available.')
  lines.push('')
  lines.push('    HOW TO REPLY OR ASK FOR CLARIFICATION:')
  lines.push('    If you need to ask for clarification, explain what you did, or reply to any comment:')
  lines.push('')
  lines.push('    Option A: Via the diffing CLI or MCP (Preferred — port-agnostic, no copy-paste)')
  lines.push('      diffing reply <comment-id> --body "Your response" --model "<your-model-name>"')
  lines.push('      diffing resolve <comment-id>')
  lines.push('    (Or the equivalent MCP tools: reply_to_comment, resolve_comment.)')
  lines.push('')
  lines.push('    Option B: Via the local HTTP API (if you know the running port)')
  lines.push('      POST http://localhost:<port>/api/comments/<comment-id>/replies')
  lines.push('      Payload: { "body": "Your response or clarification request here", "model": "<your-model-name>" }')
  lines.push('      PUT  http://localhost:<port>/api/comments/<comment-id>  Payload: { "status": "resolved" }')
  lines.push('')
  lines.push('    Option C: Via Text Response (Offline / Chat Copy-Paste)')
  lines.push('    If you do not have local API access, output your comments/replies inside a structured XML block at the end of your response:')
  lines.push('      <comment-replies>')
  lines.push('        <reply to="<comment-id>" model="<your-model-name>"><![CDATA[Your reply or clarification request here]]></reply>')
  lines.push('      </comment-replies>')
  lines.push('  </instructions>')

  if (decision) {
    lines.push(`  <decision-summary><![CDATA[${reviewDecisionSummary(decision)}]]></decision-summary>`)
  }

  if (trimmedGeneral) {
    lines.push('  <general-comment>')
    lines.push(`    <![CDATA[${escapeCdataText(trimmedGeneral)}]]>`)
    lines.push('  </general-comment>')
  }

  for (const filePath of sortedFilePaths) {
    const fileComments = grouped.get(filePath)!
    lines.push(`  <file path="${escapeAttr(filePath)}">`)
    for (const comment of fileComments) {
      const lineAttr = comment.lineNumber === 0
        ? 'file'
        : (comment.startLineNumber && comment.startLineNumber !== comment.lineNumber
          ? `${comment.startLineNumber}-${comment.lineNumber}`
          : `${comment.lineNumber}`)

      const isoDate = new Date(comment.createdAt).toISOString()
      const severityAttr =
        comment.severity && comment.severity !== 'none'
          ? ` severity="${escapeAttr(comment.severity)}"`
          : ''
      lines.push(
        `    <comment id="${escapeAttr(comment.id)}" line="${escapeAttr(lineAttr)}" side="${escapeAttr(comment.side)}" status="${escapeAttr(comment.status)}"${severityAttr} created-at="${isoDate}">`,
      )

      if (comment.lineNumber !== 0) {
        const prefix = comment.side === 'additions' ? '+' : '-'
        const isMultiLine = comment.lineContent && comment.lineContent.includes('\n')
        let codeVal = ''
        if (isMultiLine) {
          const formattedCodeLines = comment.lineContent
            .split('\n')
            .map((l) => `${prefix} ${l}`)
            .join('\n')
          codeVal = `\n${formattedCodeLines}\n`
        } else {
          codeVal = `${prefix} ${comment.lineContent}`
        }

        lines.push(`      <code><![CDATA[${escapeCdataText(codeVal)}]]></code>`)
      }
      lines.push(`      <body><![CDATA[${escapeCdataText(comment.body)}]]></body>`)

      if (comment.replies && comment.replies.length > 0) {
        lines.push('      <replies>')
        for (const reply of comment.replies) {
          const replyIsoDate = new Date(reply.createdAt).toISOString()
          const roleAttr = reply.role ? ` role="${escapeAttr(reply.role)}"` : ' role="agent"'
          const modelAttr = reply.model ? ` model="${escapeAttr(reply.model)}"` : ''
          lines.push(`        <reply id="${escapeAttr(reply.id)}" created-at="${replyIsoDate}"${roleAttr}${modelAttr}>`)
          lines.push(`          <![CDATA[${escapeCdataText(reply.body)}]]>`)
          lines.push('        </reply>')
        }
        lines.push('      </replies>')
      }

      lines.push('    </comment>')
    }
    lines.push('  </file>')
  }
  lines.push('</code-review-comments>')

  return joinReviewXml(lines)
}
