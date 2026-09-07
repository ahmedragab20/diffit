//! Bounded, versioned stdio transport for repository file capabilities.
//! The root is opened once before requests are processed. No request can
//! change roots, select an executable, or invoke Git/shell commands.

use std::io::{self, BufRead, Read, Write};
use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine};
use diffing_core::repo_fs::{RepoFs, RepoFsError, WriteOptions, MAX_FILE_BYTES};
use serde::Deserialize;
use serde_json::{json, Value};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_RPC_FRAME_BYTES: u64 = 70 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 16 * 1024;
const MAX_SAFE_ID: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u64,
    op: Operation,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Operation {
    Read {
        path: String,
    },
    Write {
        path: String,
        #[serde(rename = "contentBase64")]
        content_base64: String,
        #[serde(default, rename = "createParents")]
        create_parents: bool,
        #[serde(default, rename = "expectedSha256")]
        expected_sha256: Option<String>,
    },
}

struct RpcFailure {
    code: &'static str,
    message: String,
}

impl From<RepoFsError> for RpcFailure {
    fn from(error: RepoFsError) -> Self {
        Self {
            code: error.code(),
            // RepoFsError's Display deliberately excludes ambient paths/data.
            message: error.to_string(),
        }
    }
}

impl RpcFailure {
    fn invalid() -> Self {
        Self {
            code: "invalid-request",
            message: "invalid filesystem request".to_owned(),
        }
    }
}

fn perform(filesystem: &RepoFs, operation: Operation) -> Result<Value, RpcFailure> {
    match operation {
        Operation::Read { path } => {
            if path.len() > MAX_PATH_BYTES {
                return Err(RpcFailure::invalid());
            }
            let file = filesystem.read(Path::new(&path))?;
            Ok(json!({
                "contentBase64": STANDARD.encode(&file.bytes),
                "sha256": file.sha256,
                "size": file.bytes.len(),
            }))
        }
        Operation::Write {
            path,
            content_base64,
            create_parents,
            expected_sha256,
        } => {
            if path.len() > MAX_PATH_BYTES
                || expected_sha256.as_ref().is_some_and(|hash| {
                    hash.len() != 64
                        || !hash
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })
            {
                return Err(RpcFailure::invalid());
            }
            if content_base64.len() as u64 > 4 * MAX_FILE_BYTES.div_ceil(3) {
                return Err(RepoFsError::TooLarge.into());
            }
            let bytes = STANDARD
                .decode(content_base64)
                .map_err(|_| RpcFailure::invalid())?;
            let result = filesystem.write(
                Path::new(&path),
                &bytes,
                WriteOptions {
                    create_parents,
                    expected_sha256,
                },
            )?;
            Ok(json!({ "sha256": result.sha256, "size": result.size }))
        }
    }
}

fn write_frame(output: &mut impl Write, value: Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, &value).map_err(io::Error::other)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn write_failure(output: &mut impl Write, id: Option<u64>, failure: RpcFailure) -> io::Result<()> {
    write_frame(
        output,
        json!({
            "protocol": PROTOCOL_VERSION,
            "id": id,
            "ok": false,
            "error": { "code": failure.code, "message": failure.message },
        }),
    )
}

pub fn serve(
    filesystem: &RepoFs,
    mut input: impl BufRead,
    mut output: impl Write,
) -> io::Result<()> {
    write_frame(
        &mut output,
        json!({
            "protocol": PROTOCOL_VERSION,
            "type": "ready",
            "maxFileBytes": MAX_FILE_BYTES,
            "maxFrameBytes": MAX_RPC_FRAME_BYTES,
        }),
    )?;
    loop {
        let mut frame = Vec::new();
        let length = input
            .by_ref()
            .take(MAX_RPC_FRAME_BYTES + 1)
            .read_until(b'\n', &mut frame)?;
        if length == 0 {
            return Ok(());
        }
        if length as u64 > MAX_RPC_FRAME_BYTES {
            write_failure(
                &mut output,
                None,
                RpcFailure {
                    code: "too-large",
                    message: "filesystem request exceeds the frame limit".to_owned(),
                },
            )?;
            // Do not drain an unbounded hostile stream to find its newline.
            return Ok(());
        }
        let request = match serde_json::from_slice::<Request>(&frame) {
            Ok(request) if request.id <= MAX_SAFE_ID => request,
            _ => {
                write_failure(&mut output, None, RpcFailure::invalid())?;
                continue;
            }
        };
        match perform(filesystem, request.op) {
            Ok(result) => write_frame(
                &mut output,
                json!({
                    "protocol": PROTOCOL_VERSION,
                    "id": request.id,
                    "ok": true,
                    "result": result,
                }),
            )?,
            Err(error) => write_failure(&mut output, Some(request.id), error)?,
        }
    }
}

pub fn run(root: &Path) -> anyhow::Result<()> {
    let filesystem = RepoFs::open(root)?;
    serve(&filesystem, io::stdin().lock(), io::stdout().lock())?;
    Ok(())
}
