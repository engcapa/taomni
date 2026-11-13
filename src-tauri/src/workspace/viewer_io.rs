//! Narrow, crate-private bridge to the workspace's lossless codec and byte writer.
//! Viewer policy (limits, paths, EOL) stays outside the workspace facade.
use super::*;
use std::sync::{Mutex, MutexGuard};

static FILE_WRITES: Mutex<()> = Mutex::new(());

pub(super) fn serialize_file_write() -> MutexGuard<'static, ()> {
    // A panicking writer releases its file handles; hash checks still establish
    // the next write's precondition, so poisoning must not disable all saves.
    FILE_WRITES
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

pub(crate) fn decode_text_bytes(
    bytes: &[u8],
    encoding: Option<&str>,
) -> Result<(String, String, bool), String> {
    decode_workspace_bytes(bytes, encoding)
}

pub(crate) fn encode_text_bytes(text: &str, encoding: &str, bom: bool) -> Result<Vec<u8>, String> {
    encode_workspace_text(text, encoding, bom)
}

pub(crate) fn text_encoding(label: &str) -> Result<&'static Encoding, String> {
    encoding_for_label(label)
}

pub(crate) fn atomic_viewer_write(
    target: &Path,
    bytes: Vec<u8>,
    expected_hash: &str,
    max_bytes: u64,
) -> Result<(String, u64), WorkspaceWriteError> {
    reject_protected_loose_write(target)
        .map_err(|error| WorkspaceWriteError::new(WorkspaceWriteErrorKind::Permission, error))?;
    let ack = write_workspace_bytes_limited(target, bytes, expected_hash, max_bytes)?;
    Ok((ack.written_hash, ack.written_byte_length))
}
