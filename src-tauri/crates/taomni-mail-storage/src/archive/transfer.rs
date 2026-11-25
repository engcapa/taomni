use std::{
    fs::{self, File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::Path,
};

use sha2::{Digest, Sha256};

use super::CHUNK;
use crate::storage::query::ArchiveKey;

/// Resume an original within the account's archive directory. The caller
/// serializes transfers for this account and checks publication eligibility
/// under the account writer lock. Keep the parts until publication succeeds.
pub fn download_imap_original(
    root: &Path,
    message: &ArchiveKey,
    mut fetch: impl FnMut(u64) -> Result<(u32, u64, Vec<u8>), String>,
    progress: impl Fn(u64, Option<u64>) -> Result<(), String>,
    check: impl Fn() -> Result<(), String>,
    publish: impl FnOnce(File, u64) -> Result<(), String>,
) -> Result<(), String> {
    let directory = root.join("partial");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let folder_hash = hex::encode(Sha256::digest(message.folder.as_bytes()));
    let path = directory.join(format!(
        "{folder_hash}-{}-{}.part",
        message.uid_validity, message.uid
    ));
    let metadata = path.with_extension("json");
    let mut offset = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    let mut expected: Option<u64> = if offset == 0 {
        // A crash can leave metadata before the first byte or after publication.
        None
    } else {
        fs::read(&metadata)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    };
    if offset > 0 && expected.is_none() {
        // A partial without its identity metadata cannot be resumed safely.
        fs::remove_file(&path).map_err(|error| error.to_string())?;
        offset = 0;
    }
    loop {
        progress(offset, expected.map(|size| size.max(offset)))?;
        let (remote_validity, size, bytes) = fetch(offset)?;
        check()?;
        if remote_validity != message.uid_validity {
            return Err("Mailbox identity changed; refresh before resuming full storage".into());
        }
        if expected.is_some_and(|old| old != size) {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
            let _ = fs::remove_file(&metadata);
            return Err("Email size changed; partial download reset. Retry full storage".into());
        }
        expected = Some(size);
        fs::write(&metadata, size.to_string()).map_err(|error| error.to_string())?;
        let mut output = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        if output
            .seek(SeekFrom::End(0))
            .map_err(|error| error.to_string())?
            != offset
        {
            return Err("Partial email changed during download; retry storage".into());
        }
        output
            .write_all(&bytes)
            .map_err(|error| error.to_string())?;
        output.sync_data().map_err(|error| error.to_string())?;
        offset += bytes.len() as u64;
        drop(output);
        // Full blocks, inaccurate size estimates and resumed complete files
        // need a separate range request to confirm EOF.
        if bytes.is_empty() || (bytes.len() < CHUNK && offset == size) {
            break;
        }
    }
    publish(
        File::open(&path).map_err(|error| error.to_string())?,
        offset,
    )?;
    fs::remove_file(path).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(metadata);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, io::Read};

    use super::*;

    #[test]
    fn cancellation_and_failed_publication_preserve_the_correct_resume_offset() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let prefix = vec![b'x'; CHUNK];
        let suffix = b"remaining MIME bytes";
        let size = (prefix.len() + suffix.len()) as u64;
        let message = ArchiveKey {
            folder: "INBOX".into(),
            uid: 41,
            uid_validity: 1000,
        };
        let paused = Cell::new(false);

        let error = download_imap_original(
            root,
            &message,
            |offset| {
                if offset == 0 {
                    Ok((1000, size, prefix.clone()))
                } else {
                    assert_eq!(offset, CHUNK as u64);
                    paused.set(true);
                    Ok((1000, size, suffix.to_vec()))
                }
            },
            |_, _| Ok(()),
            || {
                if paused.get() {
                    Err("paused".into())
                } else {
                    Ok(())
                }
            },
            |_, _| panic!("a cancelled transfer reached publication"),
        )
        .unwrap_err();
        assert_eq!(error, "paused");

        let error = download_imap_original(
            root,
            &message,
            |offset| {
                assert_eq!(offset, CHUNK as u64);
                Ok((1000, size, suffix.to_vec()))
            },
            |_, _| Ok(()),
            || Ok(()),
            |_, _| Err("writer busy".into()),
        )
        .unwrap_err();
        assert_eq!(error, "writer busy");

        download_imap_original(
            root,
            &message,
            |offset| {
                assert_eq!(offset, size);
                Ok((1000, size, vec![]))
            },
            |offset, total| {
                assert_eq!((offset, total), (size, Some(size)));
                Ok(())
            },
            || Ok(()),
            |mut raw, length| {
                assert_eq!(length, size);
                let mut received = Vec::new();
                raw.read_to_end(&mut received).unwrap();
                assert_eq!(received[..CHUNK], prefix);
                assert_eq!(&received[CHUNK..], suffix);
                Ok(())
            },
        )
        .unwrap();
        assert!(fs::read_dir(root.join("partial")).unwrap().next().is_none());
    }
}
