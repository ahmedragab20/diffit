//! Regression tests for the Rust handoff envelope escaping
//! (`diffing_tui::handoff::format::format_comments`).
//!
//! These tests pin down the XML-safety contract of the
//! `<code-review-comments>` handoff document:
//!
//! 1. `<instructions>` is emitted as a CDATA block
//!    (`  <instructions><![CDATA[`) and the nested example terminator
//!    (`]]>` inside the copy-paste example) is split safely, while a
//!    normal code-comment body stays verbatim inside its CDATA.
//! 2. Attribute values (`filePath`, reply `model`, ...) escape quotes,
//!    `&`, `<`, `>` and control characters (tab/LF/CR as `&#9;`/`&#10;`/`&#13;`).
//! 3. CDATA content (body/code/reply/general text) splits repeated `]]>`
//!    occurrences and emits CR as a `&#13;` character reference.
//! 4. Valid emoji survive byte-for-byte; NUL, vertical tab and U+FFFE
//!    are replaced with U+FFFD.

use diffing_core::comments::{CommentReply, CommentSide, CommentStatus, ReviewComment};
use diffing_tui::handoff::format::format_comments;
use diffing_tui::handoff::review::ReviewDecision;

fn comment(id: &str, file_path: &str, body: &str) -> ReviewComment {
    ReviewComment {
        id: id.to_string(),
        file_path: file_path.to_string(),
        side: CommentSide::Additions,
        line_number: 10,
        start_line_number: None,
        line_content: "const x = 1".to_string(),
        body: body.to_string(),
        status: CommentStatus::Open,
        created_at: 1000,
        replies: Vec::new(),
        severity: None,
    }
}

fn reply(id: &str, body: &str, model: &str) -> CommentReply {
    CommentReply {
        id: id.to_string(),
        body: body.to_string(),
        created_at: 2000,
        role: Some("agent".to_string()),
        model: Some(model.to_string()),
    }
}

#[test]
fn instructions_are_cdata_wrapped_and_nested_terminator_is_split() {
    let out = format_comments(&[comment("c1", "src/a.rs", "fix this")], None, None);

    // The instructions block must open as a CDATA section on the same line.
    assert!(
        out.contains("  <instructions><![CDATA["),
        "instructions must be CDATA-wrapped; got:\n{out}"
    );
    assert!(
        out.contains("]]></instructions>"),
        "instructions must close their CDATA section"
    );

    // The nested example terminator inside the instructions prose must be
    // split so it cannot terminate the enclosing CDATA section early.
    assert!(
        out.contains("<![CDATA[Your reply or clarification request here]]]]><![CDATA[>"),
        "nested example `]]>` must be split safely; got:\n{out}"
    );
    assert!(
        !out.contains("<![CDATA[Your reply or clarification request here]]>"),
        "raw nested `]]>` must never appear unsplit"
    );
}

#[test]
fn normal_code_comment_body_remains_present_verbatim() {
    let out = format_comments(
        &[comment("c1", "src/plain.rs", "rename this variable")],
        None,
        None,
    );
    assert!(
        out.contains("      <body><![CDATA[rename this variable]]></body>"),
        "plain body must survive verbatim; got:\n{out}"
    );
    assert!(out.contains("      <code><![CDATA[+ const x = 1]]></code>"));
}

#[test]
fn file_path_attribute_escapes_quotes_ampersand_angle_brackets_and_whitespace() {
    let mut c = comment("c1", "src/a.rs", "body");
    c.file_path = "we'\"rd<&>p\ta\th\r\nb.rs".to_string();
    let out = format_comments(&[c], None, None);
    assert!(
        out.contains("  <file path=\"we&apos;&quot;rd&lt;&amp;&gt;p&#9;a&#9;h&#13;&#10;b.rs\">"),
        "filePath must attribute-escape quote/&/</> and tab/LF/CR; got:\n{out}"
    );
}

#[test]
fn reply_model_attribute_escapes_the_same_character_set() {
    let mut c = comment("c1", "src/a.rs", "body");
    c.replies.push(reply("r1", "ok", "mo\"del<&>\ttab\t\r\nlf"));
    let out = format_comments(&[c], None, None);
    assert!(
        out.contains(" model=\"mo&quot;del&lt;&amp;&gt;&#9;tab&#9;&#13;&#10;lf\""),
        "reply model must attribute-escape the same set; got:\n{out}"
    );
}

#[test]
fn body_with_repeated_terminators_and_crlf_uses_splitting_and_cr_refs() {
    let mut c = comment("c1", "src/a.rs", "keep");
    c.body = "alpha\r\nbeta]]>gamma]]>delta".to_string();
    let out = format_comments(&[c], None, None);
    assert!(
        out.contains("      <body><![CDATA[alpha]]>\x26#13;<![CDATA[\nbeta]]]]><![CDATA[>gamma]]]]><![CDATA[>delta]]></body>"),
        "body must split each `]]>` and emit CR as `&#13;`; got:\n{out}"
    );
}

#[test]
fn code_content_with_repeated_terminators_and_crlf_is_split_safely() {
    let mut c = comment("c1", "src/a.rs", "keep");
    c.line_number = 12;
    c.start_line_number = Some(11);
    c.line_content = "x\r\ny]]>z".to_string();
    let out = format_comments(&[c], None, None);
    assert!(
        out.contains(
            "      <code><![CDATA[\n+ x]]>\x26#13;<![CDATA[\n+ y]]]]><![CDATA[>z\n]]></code>"
        ),
        "code content must split `]]>` and emit CR as `&#13;`; got:\n{out}"
    );
}

#[test]
fn reply_body_with_repeated_terminators_and_crlf_is_split_safely() {
    let mut c = comment("c1", "src/a.rs", "keep");
    c.replies.push(reply("r1", "p\r\nq]]>r]]>s", "m1"));
    let out = format_comments(&[c], None, None);
    assert!(
        out.contains(
            "          <![CDATA[p]]>\x26#13;<![CDATA[\nq]]]]><![CDATA[>r]]]]><![CDATA[>s]]>"
        ),
        "reply body must split `]]>` and emit CR as `&#13;`; got:\n{out}"
    );
}

#[test]
fn general_comment_with_repeated_terminators_and_crlf_is_split_safely() {
    let out = format_comments(
        &[comment("c1", "src/a.rs", "keep")],
        Some("g\r\nh]]>i]]>j"),
        None,
    );
    assert!(
        out.contains("    <![CDATA[g]]>\x26#13;<![CDATA[\nh]]]]><![CDATA[>i]]]]><![CDATA[>j]]>"),
        "general comment must split `]]>` and emit CR as `&#13;`; got:\n{out}"
    );
}

#[test]
fn valid_emoji_survives_cdata_untouched() {
    let emoji_body = "ship it 🚀 done ✅";
    let out = format_comments(&[comment("c1", "src/a.rs", emoji_body)], None, None);
    assert!(
        out.contains(&format!("      <body><![CDATA[{emoji_body}]]></body>")),
        "valid emoji must survive byte-for-byte; got:\n{out}"
    );
}

#[test]
fn nul_vertical_tab_and_noncharacter_are_replaced_with_replacement_char() {
    let mut c = comment("c1", "src/a.rs", "ok");
    c.body = "a\u{0000}b\u{000B}c\u{FFFE}d".to_string();
    let out = format_comments(&[c], None, None);
    assert!(
        out.contains("      <body><![CDATA[a\u{FFFD}b\u{FFFD}c\u{FFFD}d]]></body>"),
        "NUL / vertical tab / U+FFFE must be replaced with U+FFFD; got:\n{out}"
    );
    assert!(
        !out.contains('\u{0000}') && !out.contains('\u{000B}') && !out.contains('\u{FFFE}'),
        "forbidden control/noncharacters must not appear anywhere in the envelope"
    );
}

#[test]
fn decision_summary_cdata_is_untouched_by_escaping_rules() {
    let out = format_comments(
        &[comment("c1", "src/a.rs", "keep")],
        None,
        Some(ReviewDecision::ChangesRequested),
    );
    assert!(out.contains("<code-review-comments decision=\"changes-requested\">"));
    assert!(
        out.contains("  <decision-summary><![CDATA[The reviewer REQUESTED EDITS."),
        "decision summary must remain a clean CDATA block; got:\n{out}"
    );
}
