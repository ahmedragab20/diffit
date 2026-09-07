//! Tests for the bounded native filesystem RPC exposed by
//! `diffing_tui::fs_rpc`. The wire protocol is JSON lines over arbitrary
//! read/write streams; the first output line is a `ready` banner, requests
//! carry `{id, op}` and replies carry `{protocol, id, ok}`.
//!
//! Fixtures are owned `TempDir`s; streams are `Cursor<Vec<u8>>` (input) and
//! `Vec<u8>` (output) so nothing escapes the process except the CLI smoke
//! test, which pipes a child `diffing-tui --fs-rpc`.

use std::io::{Cursor, Write};
use std::process::{Command, Stdio};

use diffing_core::repo_fs::RepoFs;
use diffing_tui::fs_rpc::{serve, MAX_RPC_FRAME_BYTES, PROTOCOL_VERSION};
use tempfile::TempDir;

/// base64 of bytes `[0x00, 0xFF, 0x0A]` — exercises NUL, 0xFF and newline
/// bytes through the binary-safe round trip.
const BINARY_B64: &str = "AP8K";
const BINARY_SHA256: &str = "712450d3c4a79eea9509e75dc1dacdeff58034df538536cfae2da882bd8a0c50";
/// base64 of `"hello"`.
const HELLO_B64: &str = "aGVsbG8=";
const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

/// Parse the newline-delimited JSON stream produced by the server.
fn parse_lines(out: &[u8]) -> Vec<serde_json::Value> {
    let text = String::from_utf8(out.to_vec()).expect("server output is UTF-8");
    text.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("malformed server line {line:?}: {e}"))
        })
        .collect()
}

/// Run a request stream through `serve` and return the parsed replies.
fn run(fs: &RepoFs, requests: &str) -> Vec<serde_json::Value> {
    let mut out: Vec<u8> = Vec::new();
    serve(fs, Cursor::new(requests.as_bytes().to_vec()), &mut out)
        .expect("serve should not fail on well-formed framing");
    parse_lines(&out)
}

fn ready(replies: &[serde_json::Value]) -> serde_json::Value {
    let ready = &replies[0];
    assert_eq!(
        ready["type"], "ready",
        "first line must be the ready banner"
    );
    assert_eq!(ready["protocol"], PROTOCOL_VERSION);
    assert!(
        ready["maxFileBytes"].is_u64(),
        "ready must carry maxFileBytes"
    );
    assert!(
        ready["maxFrameBytes"].is_u64(),
        "ready must carry maxFrameBytes"
    );
    ready.clone()
}

fn expect_ok(replies: &[serde_json::Value], idx: usize, id: u64) -> serde_json::Value {
    let reply = &replies[idx];
    assert_eq!(reply["protocol"], PROTOCOL_VERSION);
    assert_eq!(reply["id"], id, "reply id must match request id");
    assert_eq!(reply["ok"], true, "expected ok reply: {reply}");
    reply["result"].clone()
}

fn expect_err(replies: &[serde_json::Value], idx: usize) -> serde_json::Value {
    let reply = &replies[idx];
    assert_eq!(reply["protocol"], PROTOCOL_VERSION);
    assert_eq!(reply["ok"], false, "expected error reply: {reply}");
    reply["error"].clone()
}

#[test]
fn ready_read_write_binary_round_trip() {
    let tmp = TempDir::new().expect("tempdir");
    let fs = RepoFs::open(tmp.path()).expect("open root");

    let read_req = serde_json::json!({"id": 1, "op": {"kind": "read", "path": "blob.bin"}});
    let write_req = serde_json::json!({
        "id": 2,
        "op": {
            "kind": "write",
            "path": "blob.bin",
            "contentBase64": BINARY_B64,
            "createParents": false
        }
    });
    let requests = format!("{read_req}\n{write_req}\n");
    let replies = run(&fs, &requests);
    assert_eq!(replies.len(), 3, "ready + two replies");
    ready(&replies);

    // The read of the not-yet-existing file fails cleanly.
    let err = expect_err(&replies, 1);
    assert_eq!(err["code"], "not-found");

    // The write succeeds and reports the exact digest and size of the bytes.
    let result = expect_ok(&replies, 2, 2);
    assert_eq!(result["contentBase64"], serde_json::Value::Null);
    assert_eq!(result["sha256"], BINARY_SHA256);
    assert_eq!(result["size"], 3);

    // Read back: byte-exact round trip.
    let replies = run(&fs, &format!("{read_req}\n"));
    assert_eq!(replies.len(), 2);
    ready(&replies);
    let result = expect_ok(&replies, 1, 1);
    assert_eq!(result["contentBase64"], BINARY_B64);
    assert_eq!(result["sha256"], BINARY_SHA256);
    assert_eq!(result["size"], 3);
}

#[test]
fn traversal_denial_never_touches_outside_sentinel() {
    // A sentinel lives in a sibling directory of the repo root; traversal
    // (`../`) must be denied and must not leak the sentinel in any output.
    let outside = TempDir::new().expect("outside tempdir");
    let tmp = TempDir::new_in(outside.path()).expect("repo tempdir");
    let sentinel = outside.path().join("sentinel-9f3a.txt");
    std::fs::write(&sentinel, b"OUTSIDE-SENTINEL").expect("sentinel");

    let fs = RepoFs::open(tmp.path()).expect("open root");
    let req = serde_json::json!({"id": 7, "op": {"kind": "read", "path": "../sentinel-9f3a.txt"}});
    let mut out: Vec<u8> = Vec::new();
    serve(
        &fs,
        Cursor::new(serde_json::to_string(&req).unwrap().into_bytes()),
        &mut out,
    )
    .expect("serve should report the denial, not fail");

    let replies = parse_lines(&out);
    assert_eq!(replies.len(), 2, "ready + one denial reply");
    ready(&replies);
    let err = expect_err(&replies, 1);
    assert_eq!(err["code"], "invalid-path");

    // No sentinel path or content may appear anywhere in the server output.
    assert!(!out
        .windows(b"sentinel-9f3a".len())
        .any(|w| w == b"sentinel-9f3a"));
    assert!(!out
        .windows(b"OUTSIDE-SENTINEL".len())
        .any(|w| w == b"OUTSIDE-SENTINEL"));
    // The sentinel itself is untouched.
    assert_eq!(
        std::fs::read(&sentinel).expect("sentinel still readable"),
        b"OUTSIDE-SENTINEL"
    );
}

#[test]
fn malformed_requests_recover_and_valid_request_still_succeeds() {
    let tmp = TempDir::new().expect("tempdir");
    std::fs::write(tmp.path().join("hello.txt"), b"hello").expect("fixture");
    let fs = RepoFs::open(tmp.path()).expect("open root");

    let unknown_op = serde_json::json!({"id": 3, "op": {"kind": "chmod", "path": "hello.txt"}});
    let unknown_field = serde_json::json!({
        "id": 4,
        "op": {"kind": "read", "path": "hello.txt", "bogus": 1}
    });
    let bad_b64 = serde_json::json!({
        "id": 5,
        "op": {
            "kind": "write",
            "path": "hello.txt",
            "contentBase64": "!!!not-base64!!!",
            "createParents": false
        }
    });
    let valid_read = serde_json::json!({"id": 6, "op": {"kind": "read", "path": "hello.txt"}});

    let requests = format!(
        "this is not json\n{}\n{}\n{}\n{}\n",
        unknown_op, unknown_field, bad_b64, valid_read
    );
    let replies = run(&fs, &requests);
    assert_eq!(replies.len(), 6, "ready + 4 errors + 1 ok");
    ready(&replies);

    // Invalid JSON: unattributable, so id is null with code invalid-request.
    let bad_json_reply = &replies[1];
    assert_eq!(bad_json_reply["ok"], false);
    assert_eq!(bad_json_reply["id"], serde_json::Value::Null);
    assert_eq!(bad_json_reply["error"]["code"], "invalid-request");

    // Unknown operation: rejected, server keeps going.
    assert_eq!(expect_err(&replies, 2)["code"], "invalid-request");

    // Unknown field on an otherwise-valid op: rejected.
    assert_eq!(expect_err(&replies, 3)["code"], "invalid-request");

    // Invalid base64 payload: rejected, and the target file is untouched.
    let err = expect_err(&replies, 4);
    assert_eq!(err["code"], "invalid-request");
    assert_eq!(replies[4]["id"], 5);
    assert_eq!(
        std::fs::read(tmp.path().join("hello.txt")).expect("fixture"),
        b"hello"
    );

    // The valid request after the error storm succeeds with its own id.
    let result = expect_ok(&replies, 5, 6);
    assert_eq!(result["contentBase64"], HELLO_B64);
    assert_eq!(result["sha256"], HELLO_SHA256);
    assert_eq!(result["size"], 5);
}

#[test]
fn stale_expected_sha256_rejects_write_and_preserves_bytes() {
    let tmp = TempDir::new().expect("tempdir");
    let fs = RepoFs::open(tmp.path()).expect("open root");

    // Seed the file via a correct write.
    let seed = serde_json::json!({
        "id": 1,
        "op": {
            "kind": "write",
            "path": "doc.txt",
            "contentBase64": HELLO_B64,
            "createParents": false
        }
    });
    let replies = run(&fs, &format!("{seed}\n"));
    assert_eq!(replies.len(), 2);
    expect_ok(&replies, 1, 1);

    // A second write whose expectedSha256 does not match the current file
    // must be rejected and must leave the original bytes intact.
    let stale = serde_json::json!({
        "id": 2,
        "op": {
            "kind": "write",
            "path": "doc.txt",
            "contentBase64": BINARY_B64,
            "createParents": false,
            "expectedSha256": "0".repeat(64)
        }
    });
    let replies = run(&fs, &format!("{stale}\n"));
    assert_eq!(replies.len(), 2);
    let err = expect_err(&replies, 1);
    assert_eq!(err["code"], "conflict");
    assert_eq!(
        std::fs::read(tmp.path().join("doc.txt")).expect("seeded file"),
        b"hello"
    );
}

#[test]
fn overlong_frame_gets_single_too_large_reply_and_ends_processing() {
    let tmp = TempDir::new().expect("tempdir");
    let fs = RepoFs::open(tmp.path()).expect("open root");

    // One line exactly one byte past the ceiling, no trailing newline, and
    // nothing else — the input never exceeds bound + 1.
    let frame = "a".repeat((MAX_RPC_FRAME_BYTES + 1) as usize);
    let replies = run(&fs, &frame);

    assert_eq!(replies.len(), 2, "ready + exactly one too-large reply");
    ready(&replies);
    let err = expect_err(&replies, 1);
    assert_eq!(err["code"], "too-large");
    // Processing ends after the overlong frame: no further replies, and no
    // files were written into the repo root.
    let wrote_any = std::fs::read_dir(tmp.path())
        .expect("repo root")
        .any(|e| e.is_ok());
    assert!(!wrote_any, "overlong frame must not trigger any writes");
}

#[test]
fn cli_fs_rpc_smoke_ready_plus_single_reply() {
    let tmp = TempDir::new().expect("tempdir");
    std::fs::write(tmp.path().join("hello.txt"), b"hello").expect("fixture");

    let mut child = Command::new(env!("CARGO_BIN_EXE_diffing-tui"))
        .current_dir(tmp.path())
        .env("HOME", tmp.path())
        .env("XDG_CONFIG_HOME", tmp.path().join("config"))
        .env("APPDATA", tmp.path().join("config"))
        .env("LOCALAPPDATA", tmp.path().join("local"))
        .env("DIFFING_STORAGE_ROOT", tmp.path().join("state"))
        .arg("--repo")
        .arg(tmp.path())
        .arg("--fs-rpc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn diffing-tui --fs-rpc");

    let req = serde_json::json!({"id": 1, "op": {"kind": "read", "path": "hello.txt"}});
    {
        let stdin = child.stdin.as_mut().expect("piped stdin");
        stdin
            .write_all(serde_json::to_string(&req).unwrap().as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .expect("write one read request");
    }
    // Closing stdin ends the session; the child should exit successfully.
    drop(child.stdin.take());
    let out = child.wait_with_output().expect("wait for child");

    assert!(
        out.status.success(),
        "exit {:?}, stderr: {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );

    let replies = parse_lines(&out.stdout);
    assert_eq!(replies.len(), 2, "exactly ready + reply, no TUI noise");
    let banner = ready(&replies);
    assert_eq!(banner["maxFrameBytes"], MAX_RPC_FRAME_BYTES);
    let result = expect_ok(&replies, 1, 1);
    assert_eq!(result["contentBase64"], HELLO_B64);
    assert_eq!(result["size"], 5);
}
