use super::chunks::{decode_prefix, detect_encoding};
use super::filesystem::{bounded_read, limit, mtime, open_regular};
use super::paths::{display, io_error};
use super::{DEFAULT_TEXT_BYTES, HARD_TEXT_BYTES, TextData, WriteAck};
use crate::workspace::WorkspaceWriteErrorKind;
use crate::workspace::viewer_io::{atomic_viewer_write, decode_text_bytes, encode_text_bytes};
use sha2::{Digest, Sha256};
use std::io::{Seek, SeekFrom};

pub(crate) fn read_text(
    path: &str,
    max_bytes: Option<u64>,
    encoding: Option<&str>,
) -> Result<TextData, String> {
    let limit = limit(max_bytes, DEFAULT_TEXT_BYTES, HARD_TEXT_BYTES)?;
    let (path, mut file, metadata) = open_regular(path)?;
    let mut bytes = bounded_read(&mut file, limit)?;
    let truncated = bytes.len() as u64 > limit;
    bytes.truncate(limit as usize);
    let (content, encoding, bom, consumed) = if truncated {
        let encoding = detect_encoding(&mut file, encoding)?;
        let (content, bom, consumed) = decode_prefix(&bytes, &encoding, 0, true)?;
        if consumed == 0 && !bytes.is_empty() {
            return Err("too_large: Read budget is smaller than one encoded character".into());
        }
        (content, encoding, bom, consumed)
    } else {
        let (content, encoding, bom) =
            decode_text_bytes(&bytes, encoding).map_err(|error| format!("binary: {error}"))?;
        (content, encoding, bom, bytes.len())
    };
    Ok(TextData {
        path: display(&path),
        eol: detect_eol(&content).into(),
        content,
        hash: if truncated {
            String::new()
        } else {
            hex::encode(Sha256::digest(&bytes))
        },
        encoding,
        bom,
        mtime: mtime(&metadata),
        size: metadata.len(),
        truncated,
        next_offset: consumed as u64,
    })
}

pub(crate) fn write_text(
    path: &str,
    content: &str,
    encoding: &str,
    bom: bool,
    eol: &str,
    expected_hash: &str,
) -> Result<WriteAck, String> {
    if expected_hash.len() != 64 || !expected_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(
            "conflict: expectedHash must be a full-file SHA-256 from an untruncated read".into(),
        );
    }
    if content.len() as u64 > HARD_TEXT_BYTES {
        return Err("too_large: Text exceeds the 20 MiB editing limit".into());
    }
    let content = normalize_eol(content, eol)?;
    let bytes =
        encode_text_bytes(&content, encoding, bom).map_err(|error| format!("binary: {error}"))?;
    if bytes.len() as u64 > HARD_TEXT_BYTES {
        return Err("too_large: Encoded text exceeds the 20 MiB editing limit".into());
    }
    // Never let a remote/attachment copy become writable by relabeling its
    // frontend source as local. Registry ownership, not UI state, is decisive.
    if super::temporary::is_owned_temp(std::path::Path::new(path)) {
        return Err(
            "permission: Viewer temporary copies are read-only; save a local copy first".into(),
        );
    }
    // Existing files only: save-as/create has separate, exclusive ownership.
    let (path, mut existing, metadata) = open_regular(path)?;
    if metadata.len() > HARD_TEXT_BYTES {
        return Err("too_large: Existing file exceeds the 20 MiB editing limit".into());
    }
    existing
        .seek(SeekFrom::Start(0))
        .map_err(|error| io_error("seek target", error))?;
    drop(existing);
    let (hash, size) =
        atomic_viewer_write(&path, bytes, expected_hash, HARD_TEXT_BYTES).map_err(|error| {
            let prefix = match error.kind {
                WorkspaceWriteErrorKind::HashMismatch => "conflict",
                WorkspaceWriteErrorKind::Encoding => "binary",
                _ if error.message.contains("too_large:") => "too_large",
                _ if error.message.contains("precondition")
                    || error.message.contains("recheck target") =>
                {
                    "conflict"
                }
                _ => "permission",
            };
            format!("{prefix}: {}", error.message)
        })?;
    let metadata = std::fs::metadata(&path).map_err(|error| io_error("stat saved file", error))?;
    Ok(WriteAck {
        hash,
        size,
        mtime: mtime(&metadata),
    })
}

pub(super) fn detect_eol(content: &str) -> &'static str {
    let bytes = content.as_bytes();
    let mut kinds = 0u8;
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => {
                kinds |= 2;
                index += 1;
            }
            b'\r' => kinds |= 4,
            b'\n' => kinds |= 1,
            _ => {}
        }
        index += 1;
    }
    match kinds {
        0 | 1 => "LF",
        2 => "CRLF",
        4 => "CR",
        _ => "mixed",
    }
}

fn normalize_eol(content: &str, eol: &str) -> Result<String, String> {
    if eol == "mixed" {
        return Ok(content.to_string());
    }
    let separator = match eol {
        "LF" => "\n",
        "CRLF" => "\r\n",
        "CR" => "\r",
        _ => return Err("binary: Unsupported EOL; use LF, CRLF, CR, or mixed".into()),
    };
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    Ok(if separator == "\n" {
        normalized
    } else {
        normalized.replace('\n', separator)
    })
}
