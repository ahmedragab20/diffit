//! `formatComments` — Rust port of `src/lib/comment-format.ts`.
//!
//! Produces the `<code-review-comments>` XML envelope that hands a
//! review off to an AI agent. Shared by the TUI's "send to agent"
//! popover, the "Copy" button, and the lockfile update that wakes
//! `diffing await-review`. All three channels emit byte-identical
//! output.

use diffing_core::comments::{CommentStatus, ReviewComment};

use crate::handoff::review::ReviewDecision;

const ENVELOPE_INSTRUCTIONS: &str = r#"    You are an AI coding assistant. You are receiving a structured list of code review comments to address in the repository.
    For each file, review the inline comments and apply the changes requested.
    - The "decision" attribute on the root element is the reviewer's headline verdict: "approved", "changes-requested", or "rejected".
    - `<decision-summary>` tells you, in plain language, what to do next based on that verdict.
    - Target lines are specified by the "line" attribute (e.g. line="10" or line="10-15").
    - "side" indicates whether the comment is on "additions" (added/modified lines) or "deletions" (deleted/old lines).
    - "status" indicates whether the comment is "open" or "resolved". Only address comments with status="open".
    - The `<code>` block contains the specific code context at the reviewed lines, prefixed with "+" or "-".
    - The `<body>` tag contains the review feedback or request.
    - If developers have replied to the comment, their discussion is captured under the `<replies>` element.
    - The comment "id" attribute can be used to reference or update the comment via API if available.

    HOW TO REPLY OR ASK FOR CLARIFICATION:
    If you need to ask for clarification, explain what you did, or reply to any comment:

    Option A: Via the diffing CLI or MCP (Preferred — port-agnostic, no copy-paste)
      diffing reply <comment-id> --body "Your response" --model "<your-model-name>"
      diffing resolve <comment-id>
    (Or the equivalent MCP tools: reply_to_comment, resolve_comment.)

    Option B: Via the local HTTP API (if you know the running port)
      POST http://localhost:<port>/api/comments/<comment-id>/replies
      Payload: { "body": "Your response or clarification request here", "model": "<your-model-name>" }
      PUT  http://localhost:<port>/api/comments/<comment-id>  Payload: { "status": "resolved" }

    Option C: Via Text Response (Offline / Chat Copy-Paste)
    If you do not have local API access, output your comments/replies inside a structured XML block at the end of your response:
      <comment-replies>
        <reply to="<comment-id>" model="<your-model-name>"><![CDATA[Your reply or clarification request here]]></reply>
      </comment-replies>"#;

/// Plain-language guidance the agent should act on, derived from the verdict.
pub fn review_decision_summary(decision: ReviewDecision) -> &'static str {
    match decision {
        ReviewDecision::Approved => {
            "The reviewer APPROVED these changes. Address any open comments below, then proceed — the overall direction is good."
        }
        ReviewDecision::ChangesRequested => {
            "The reviewer REQUESTED EDITS. Address every open comment below and apply the requested changes before considering this review done."
        }
        ReviewDecision::Rejected => {
            "The reviewer REJECTED these changes. Do NOT keep building on this approach; reconsider it in light of the comments below before continuing."
        }
    }
}

/// Build the `<code-review-comments>` envelope. Returns an empty string when
/// there's nothing to send (no comments, no verdict, no general note).
pub fn format_comments(
    comments: &[ReviewComment],
    general_comment: Option<&str>,
    decision: Option<ReviewDecision>,
) -> String {
    let trimmed_general = general_comment.map(str::trim).filter(|s| !s.is_empty());
    if comments.is_empty() && decision.is_none() && trimmed_general.is_none() {
        return String::new();
    }

    // Group comments by file path, preserving the input order.
    let mut grouped: Vec<(&str, Vec<&ReviewComment>)> = Vec::new();
    for c in comments {
        if let Some((_, list)) = grouped.iter_mut().find(|(p, _)| *p == c.file_path) {
            list.push(c);
        } else {
            grouped.push((c.file_path.as_str(), vec![c]));
        }
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push(match decision {
        Some(d) => format!("<code-review-comments decision=\"{}\">", d.as_str()),
        None => "<code-review-comments>".to_string(),
    });
    lines.push(format!(
        "  <instructions><![CDATA[{}]]></instructions>",
        escape_cdata(ENVELOPE_INSTRUCTIONS)
    ));

    if let Some(d) = decision {
        lines.push(format!(
            "  <decision-summary><![CDATA[{}]]></decision-summary>",
            review_decision_summary(d)
        ));
    }

    if let Some(g) = trimmed_general {
        lines.push("  <general-comment>".to_string());
        lines.push(format!("    <![CDATA[{}]]>", escape_cdata(g)));
        lines.push("  </general-comment>".to_string());
    }

    for (file_path, file_comments) in &grouped {
        lines.push(format!("  <file path=\"{}\">", escape_attr(file_path)));
        for comment in file_comments {
            let line_attr = if comment.line_number == 0 {
                "file".to_string()
            } else if let Some(start) = comment.start_line_number {
                if start != comment.line_number {
                    format!(
                        "{}-{}",
                        start.min(comment.line_number),
                        start.max(comment.line_number)
                    )
                } else {
                    comment.line_number.to_string()
                }
            } else {
                comment.line_number.to_string()
            };

            let iso_date = ms_to_iso(comment.created_at);
            let status_str = match comment.status {
                CommentStatus::Open => "open",
                CommentStatus::Resolved => "resolved",
            };
            let side_str = match comment.side {
                diffing_core::comments::CommentSide::Additions => "additions",
                diffing_core::comments::CommentSide::Deletions => "deletions",
            };
            let severity_attr = comment
                .severity
                .filter(|severity| *severity != diffing_core::comments::CommentSeverity::None)
                .map(|severity| format!(" severity=\"{}\"", severity.as_str()))
                .unwrap_or_default();
            lines.push(format!(
                "    <comment id=\"{}\" line=\"{}\" side=\"{}\" status=\"{}\"{} created-at=\"{}\">",
                escape_attr(&comment.id),
                line_attr,
                side_str,
                status_str,
                severity_attr,
                iso_date
            ));

            if comment.line_number != 0 {
                let prefix = match comment.side {
                    diffing_core::comments::CommentSide::Additions => "+",
                    diffing_core::comments::CommentSide::Deletions => "-",
                };
                let is_multi = comment.line_content.contains('\n');
                let code_val = if is_multi {
                    let formatted = comment
                        .line_content
                        .split('\n')
                        .map(|l| format!("{prefix} {l}"))
                        .collect::<Vec<_>>()
                        .join("\n");
                    format!("\n{formatted}\n")
                } else {
                    format!("{prefix} {}", comment.line_content)
                };
                lines.push(format!(
                    "      <code><![CDATA[{}]]></code>",
                    escape_cdata(&code_val)
                ));
            }
            lines.push(format!(
                "      <body><![CDATA[{}]]></body>",
                escape_cdata(&comment.body)
            ));

            if !comment.replies.is_empty() {
                lines.push("      <replies>".to_string());
                for reply in &comment.replies {
                    let reply_iso = ms_to_iso(reply.created_at);
                    let role = reply.role.as_deref().unwrap_or("agent");
                    let model_attr = reply
                        .model
                        .as_deref()
                        .map(|m| format!(" model=\"{}\"", escape_attr(m)))
                        .unwrap_or_default();
                    lines.push(format!(
                        "        <reply id=\"{}\" created-at=\"{}\" role=\"{}\"{}>",
                        escape_attr(&reply.id),
                        reply_iso,
                        escape_attr(role),
                        model_attr
                    ));
                    lines.push(format!(
                        "          <![CDATA[{}]]>",
                        escape_cdata(&reply.body)
                    ));
                    lines.push("        </reply>".to_string());
                }
                lines.push("      </replies>".to_string());
            }

            lines.push("    </comment>".to_string());
        }
        lines.push("  </file>".to_string());
    }
    lines.push("</code-review-comments>".to_string());

    lines.join("\n")
}

fn xml_characters(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            '\u{9}' | '\u{a}' | '\u{d}' | '\u{20}'..='\u{d7ff}'
            | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}' => c,
            _ => '\u{fffd}',
        })
        .collect()
}

fn escape_attr(value: &str) -> String {
    xml_characters(value)
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
        .replace('\t', "&#9;")
        .replace('\n', "&#10;")
        .replace('\r', "&#13;")
}

fn escape_cdata(value: &str) -> String {
    xml_characters(value)
        .replace("]]>", "]]]]><![CDATA[>")
        .replace('\r', "]]>\x26#13;<![CDATA[")
}

fn ms_to_iso(ms: u64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    let secs = (ms / 1000) as i64;
    let nanos = ((ms % 1000) * 1_000_000) as u32;
    let dt = UNIX_EPOCH + Duration::new(secs.max(0) as u64, nanos);
    // Manual ISO-8601 / RFC 3339 formatting: YYYY-MM-DDTHH:MM:SS.sssZ
    let secs_total = dt
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (year, month, day, hour, minute, second) = epoch_seconds_to_ymdhms(secs_total);
    let ms_part = ms % 1000;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, ms_part
    )
}

fn epoch_seconds_to_ymdhms(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    // Civil-from-days algorithm (Howard Hinnant).
    let z = (secs / 86_400) as i64;
    let s = (secs % 86_400) as u32;
    let hour = s / 3600;
    let minute = (s % 3600) / 60;
    let second = s % 60;
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d, hour, minute, second)
}

#[cfg(test)]
mod tests {
    use super::*;
    use diffing_core::comments::{CommentReply, CommentSide, CommentStatus, ReviewComment};

    fn sample_comment(id: &str, body: &str, status: CommentStatus) -> ReviewComment {
        ReviewComment {
            id: id.to_string(),
            file_path: "src/index.ts".to_string(),
            side: CommentSide::Additions,
            line_number: 10,
            start_line_number: None,
            line_content: "const x = 1".to_string(),
            body: body.to_string(),
            status,
            created_at: 1000,
            replies: Vec::new(),
            severity: None,
        }
    }

    #[test]
    fn returns_empty_for_no_inputs() {
        assert_eq!(format_comments(&[], None, None), "");
    }

    #[test]
    fn returns_empty_for_blank_general_when_no_comments() {
        assert_eq!(format_comments(&[], Some("   "), None), "");
    }

    #[test]
    fn wraps_comments_in_envelope() {
        let out = format_comments(
            &[sample_comment("c1", "rename", CommentStatus::Open)],
            None,
            None,
        );
        assert!(out.contains("<code-review-comments>"));
        assert!(out.contains("</code-review-comments>"));
        assert!(out.contains("<file path=\"src/index.ts\">"));
        assert!(out.contains("<comment id=\"c1\""));
        assert!(out.contains("rename"));
    }

    #[test]
    fn includes_general_comment_when_present() {
        let out = format_comments(
            &[sample_comment("c1", "x", CommentStatus::Open)],
            Some("Prioritise the security fixes first"),
            None,
        );
        assert!(out.contains("<general-comment>"));
        assert!(out.contains("Prioritise the security fixes first"));
        assert!(out.contains("</general-comment>"));
    }

    #[test]
    fn omits_general_when_blank() {
        let out = format_comments(
            &[sample_comment("c1", "x", CommentStatus::Open)],
            Some("   "),
            None,
        );
        assert!(!out.contains("<general-comment>"));
    }

    #[test]
    fn uses_file_for_zero_line() {
        let mut c = sample_comment("c1", "x", CommentStatus::Open);
        c.line_number = 0;
        let out = format_comments(&[c], None, None);
        assert!(out.contains("line=\"file\""));
        // The instructions mention `<code>` as prose; the emitted element
        // is `<code><![CDATA[...]]></code>`. Assert on the closing tag.
        assert!(!out.contains("</code>"));
    }

    #[test]
    fn renders_line_range() {
        let mut c = sample_comment("c1", "x", CommentStatus::Open);
        c.start_line_number = Some(8);
        let out = format_comments(&[c], None, None);
        assert!(out.contains("line=\"8-10\""));
    }

    #[test]
    fn normalizes_legacy_reverse_ranges() {
        let mut c = sample_comment("c1", "x", CommentStatus::Open);
        c.start_line_number = Some(12);
        c.line_number = 10;
        let out = format_comments(&[c], None, None);
        assert!(out.contains("line=\"10-12\""));
    }

    #[test]
    fn includes_comment_severity() {
        let mut c = sample_comment("c1", "must fix", CommentStatus::Open);
        c.severity = Some(diffing_core::comments::CommentSeverity::Blocking);
        let out = format_comments(&[c], None, None);
        assert!(out.contains("severity=\"blocking\""));
    }

    #[test]
    fn prefixes_deletion_lines_with_minus() {
        let mut c = sample_comment("c1", "x", CommentStatus::Open);
        c.side = CommentSide::Deletions;
        c.line_content = "a()\nb()".to_string();
        let out = format_comments(&[c], None, None);
        assert!(out.contains("- a()\n- b()"));
    }

    #[test]
    fn stamps_root_with_decision_and_summary() {
        let out = format_comments(
            &[sample_comment("c1", "x", CommentStatus::Open)],
            None,
            Some(ReviewDecision::ChangesRequested),
        );
        assert!(out.contains("<code-review-comments decision=\"changes-requested\">"));
        assert!(out.contains("<decision-summary>"));
        assert!(out.contains("REQUESTED EDITS"));
    }

    #[test]
    fn omits_decision_when_not_given() {
        let out = format_comments(
            &[sample_comment("c1", "x", CommentStatus::Open)],
            None,
            None,
        );
        assert!(!out.contains("decision="));
        // The instructions mention `<decision-summary>` as prose; the actual
        // emitted element is a self-contained `<decision-summary><![CDATA[...
        // ]]></decision-summary>` block. Asserting on the closing tag avoids
        // matching the prose inside `<instructions>`.
        assert!(!out.contains("</decision-summary>"));
    }

    #[test]
    fn emits_envelope_for_verdict_with_zero_comments() {
        let out = format_comments(&[], None, Some(ReviewDecision::Approved));
        assert!(out.contains("<code-review-comments decision=\"approved\">"));
        assert!(!out.contains("<file "));
    }

    #[test]
    fn includes_replies_when_present() {
        let mut c = sample_comment("c1", "main", CommentStatus::Open);
        c.replies.push(CommentReply {
            id: "r1".to_string(),
            body: "agent reply".to_string(),
            created_at: 2000,
            role: Some("agent".to_string()),
            model: Some("gpt-4o".to_string()),
        });
        let out = format_comments(&[c], None, None);
        assert!(out.contains("<replies>"));
        assert!(out.contains("role=\"agent\""));
        assert!(out.contains("model=\"gpt-4o\""));
        assert!(out.contains("agent reply"));
    }

    #[test]
    fn xml_escapes_cdata_correctly() {
        // The body is inside CDATA so raw `<` and `&` don't need escaping
        // — but we should make sure the format doesn't break the envelope.
        let mut c = sample_comment("c1", "raw <tag> & ampersand", CommentStatus::Open);
        c.line_content = "raw <tag>".to_string();
        let out = format_comments(&[c], None, None);
        assert!(out.contains("raw <tag> & ampersand"));
    }

    #[test]
    fn multiline_comment_cannot_terminate_cdata_early() {
        let c = sample_comment(
            "c1",
            "first line\ncontains ]]> safely\nlast line",
            CommentStatus::Open,
        );
        let out = format_comments(&[c], None, None);
        assert!(out.contains("contains ]]]]><![CDATA[> safely"));
        assert!(!out.contains("contains ]]> safely"));
    }

    #[test]
    fn groups_by_file() {
        let mut a = sample_comment("a", "a body", CommentStatus::Open);
        a.file_path = "src/a.rs".to_string();
        let mut b = sample_comment("b", "b body", CommentStatus::Open);
        b.file_path = "src/b.rs".to_string();
        let out = format_comments(&[a, b], None, None);
        let pos_a = out.find("src/a.rs").unwrap();
        let pos_b = out.find("src/b.rs").unwrap();
        assert!(pos_a < pos_b, "file order must match input order");
    }

    #[test]
    fn escapes_quote_bearing_paths_and_attributes() {
        let mut c = sample_comment("c\"1", "body", CommentStatus::Open);
        c.file_path = "src/\"evil\".ts".to_string();
        c.replies.push(CommentReply {
            id: "r\"1".to_string(),
            body: "reply".to_string(),
            created_at: 2000,
            role: Some("reviewer\"".to_string()),
            model: Some("gpt\"4".to_string()),
        });
        let out = format_comments(&[c], None, None);
        assert!(out.contains("<file path=\"src/&quot;evil&quot;.ts\">"));
        assert!(out.contains("<comment id=\"c&quot;1\""));
        assert!(out.contains("role=\"reviewer&quot;\""));
        assert!(out.contains("model=\"gpt&quot;4\""));
        assert!(out.contains("<reply id=\"r&quot;1\""));
    }

    #[test]
    fn ms_to_iso_handles_epoch_zero() {
        let s = ms_to_iso(0);
        assert!(s.starts_with("1970-01-01T00:00:00.000Z"));
    }
}
