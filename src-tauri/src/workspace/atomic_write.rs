use super::*;

/// Byte identity of a successful write, returned by `write_workspace_bytes`
/// so the command layer can assemble the typed `WorkspaceWriteAck`.
#[derive(Debug)]
pub(super) struct WrittenBytesAck {
    /// Pre-mutation target bytes hash observed by the writer (null for a
    /// fresh create), per the §8.19.1 unified fact model.
    pub(super) old_hash: Option<String>,
    pub(super) written_hash: String,
    pub(super) written_byte_length: u64,
}

/// ED-IMPROVE-006: deterministic fault stages for the byte writer's own
/// tests. Production always passes `None`; the enum lets the Rust tests prove
/// each pre-replace failure keeps the target bytes untouched, reports the
/// intended-bytes identity and removes this writer's temp file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WriteBytesFault {
    None,
    TempOpen,
    TempWrite,
    TempSync,
    Replace,
}

pub(super) fn injected_write_fault(operation: &str) -> std::io::Error {
    std::io::Error::other(format!("{operation}: injected write-bytes fault"))
}

/// Best-effort removal of this writer's temp file, preserving the failure
/// facts and appending a cleanup diagnostic when removal itself fails. The
/// exact temp path came from this call's UUID, so another file is never
/// removed; `NotFound` is treated as already clean.
pub(super) fn temp_failure_with_cleanup(
    tmp: &Path,
    mut error: WorkspaceWriteError,
) -> WorkspaceWriteError {
    match fs::remove_file(tmp) {
        Ok(()) => error,
        Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => error,
        Err(cleanup_error) => {
            error.message = format!(
                "{}; temp cleanup failed for {}: {cleanup_error}",
                error.message,
                tmp.display()
            );
            error
        }
    }
}

pub(super) fn write_workspace_bytes(
    target: &Path,
    bytes: Vec<u8>,
    expected_hash: Option<&str>,
) -> Result<WrittenBytesAck, WorkspaceWriteError> {
    write_workspace_bytes_with_fault(target, bytes, expected_hash, WriteBytesFault::None)
}

pub(super) fn write_workspace_bytes_with_fault(
    target: &Path,
    bytes: Vec<u8>,
    expected_hash: Option<&str>,
    fault: WriteBytesFault,
) -> Result<WrittenBytesAck, WorkspaceWriteError> {
    // §8.19.1: compute the pre-mutation bytes identity before touching disk.
    // Every failure after this point carries it, so an unknown or zero-effect
    // error still lets the frontend record the real intended bytes.
    let intent_hash = sha256_hex(&bytes);
    let intent_byte_length = bytes.len() as u64;
    let with_intent =
        |error: WorkspaceWriteError| error.with_intent(intent_hash.clone(), intent_byte_length);
    // The pre-mutation read also serves the hash precondition when one was
    // requested; the observed value is carried on every failure fact either way.
    let old_hash: Option<String> = match fs::read(target) {
        Ok(current) => Some(sha256_hex(&current)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(with_intent(classify_io_error("read target", &error))
                .with_effect(WorkspaceWriteEffect::None, None)
                .with_old_hash(None));
        }
    };
    let expected = expected_hash
        .map(str::trim)
        .filter(|value| !value.is_empty());
    // A requested precondition against a missing target is a stale snapshot:
    // creating the file would silently violate the caller's expectation.
    if expected.is_some() && old_hash.is_none() {
        return Err(with_intent(WorkspaceWriteError::new(
            WorkspaceWriteErrorKind::Io,
            "read target: expected-hash precondition requires an existing target",
        ))
        .with_effect(WorkspaceWriteEffect::None, None)
        .with_old_hash(None));
    }
    if let Some(expected) = expected {
        if let Some(current_hash) = old_hash.as_deref() {
            if !current_hash.eq_ignore_ascii_case(expected) {
                // Precondition failed before any mutation: provably no disk effect.
                return Err(WorkspaceWriteError {
                    kind: WorkspaceWriteErrorKind::HashMismatch,
                    message: hash_mismatch_error(expected, current_hash),
                    expected_hash: Some(expected.to_string()),
                    actual_hash: Some(current_hash.to_string()),
                    effect: Some(WorkspaceWriteEffect::None),
                    written_hash: None,
                    written_byte_length: None,
                    intent_hash: Some(intent_hash),
                    intent_byte_length: Some(intent_byte_length),
                    old_hash: old_hash.clone(),
                });
            }
        }
    }
    let parent = match target.parent() {
        Some(parent) => parent,
        None => {
            return Err(with_intent(WorkspaceWriteError::new(
                WorkspaceWriteErrorKind::Io,
                "Cannot resolve parent directory for target",
            ))
            .with_effect(WorkspaceWriteEffect::None, None)
            .with_old_hash(old_hash));
        }
    };
    // A failed parent creation may still have created auxiliary directories;
    // the target bytes themselves are provably untouched.
    if let Err(error) = fs::create_dir_all(parent) {
        return Err(with_intent(classify_io_error("mkdir parent", &error))
            .with_effect(WorkspaceWriteEffect::None, None)
            .with_old_hash(old_hash));
    }
    let tmp = parent.join(format!(".taomni-write-{}", uuid::Uuid::new_v4().simple()));
    if fault == WriteBytesFault::TempOpen {
        return Err(with_intent(classify_io_error(
            "open temp file",
            &injected_write_fault("open temp file"),
        ))
        .with_effect(WorkspaceWriteEffect::None, None)
        .with_old_hash(old_hash));
    }
    let temp_write_stage = (|| -> Result<(), WorkspaceWriteError> {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|error| classify_io_error("open temp file", &error))?;
        if fault == WriteBytesFault::TempWrite {
            // Leave a partial temp file behind, then fail the stage so
            // cleanup and the zero-effect facts can be proven.
            file.write_all(&bytes[..bytes.len() / 2])
                .map_err(|error| classify_io_error("write temp file", &error))?;
            return Err(classify_io_error(
                "write temp file",
                &injected_write_fault("write temp file"),
            ));
        }
        file.write_all(&bytes)
            .map_err(|error| classify_io_error("write temp file", &error))?;
        if fault == WriteBytesFault::TempSync {
            return Err(classify_io_error(
                "sync temp file",
                &injected_write_fault("sync temp file"),
            ));
        }
        file.sync_all()
            .map_err(|error| classify_io_error("sync temp file", &error))?;
        Ok(())
    })();
    if let Err(error) = temp_write_stage {
        // The handle is dropped when the stage closure returns, so cleanup
        // can actually delete the temp file on Windows as well.
        return Err(temp_failure_with_cleanup(
            &tmp,
            with_intent(error)
                .with_effect(WorkspaceWriteEffect::None, None)
                .with_old_hash(old_hash),
        ));
    }
    if fault == WriteBytesFault::Replace {
        let effect = if target.exists() {
            WorkspaceWriteEffect::None
        } else {
            WorkspaceWriteEffect::Unknown
        };
        return Err(temp_failure_with_cleanup(
            &tmp,
            with_intent(classify_io_error(
                "rename temp file",
                &injected_write_fault("rename temp file"),
            ))
            .with_effect(effect, None)
            .with_old_hash(old_hash),
        ));
    }
    if let Err(error) = replace_file(&tmp, target) {
        let remove_result = fs::remove_file(&tmp);
        // The replace primitive is atomic on every supported platform, so a
        // failed replace leaves the old target in place. Only report `None`
        // when the target still exists and this run removed its own temp.
        let effect = if target.exists() && remove_result.is_ok() {
            WorkspaceWriteEffect::None
        } else {
            WorkspaceWriteEffect::Unknown
        };
        // §8.19.1: an uncertain outcome must still carry the intended-bytes
        // identity so the frontend ledger can record a non-null intent hash.
        let mut failure = classify_io_error("rename temp file", &error)
            .with_effect(effect, None)
            .with_intent(intent_hash, intent_byte_length)
            .with_old_hash(old_hash);
        if let Err(cleanup_error) = remove_result {
            failure.message = format!(
                "{}; temp cleanup failed for {}: {cleanup_error}",
                failure.message,
                tmp.display()
            );
        }
        return Err(failure);
    }
    Ok(WrittenBytesAck {
        old_hash,
        written_hash: sha256_hex(&bytes),
        written_byte_length: bytes.len() as u64,
    })
}
