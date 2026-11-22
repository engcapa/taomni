//! Streaming codec for immutable, content-addressed email archives.
mod imap_chunks;
mod metadata;
pub mod progress;
pub mod scanner;
mod transfer;
pub mod writer;

pub use imap_chunks::{CHUNK, CONTENT_ERROR, fetch_imap_chunk};
pub use transfer::download_imap_original;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum ArchiveQuery {
    Folders {
        account_id: String,
    },
    Headers(crate::imap_sync::HeaderStepRequest),
    Chunk {
        folder: String,
        uid: u32,
        offset: u64,
    },
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveChunk {
    pub uid_validity: u32,
    pub reported_size: u64,
    pub length: usize,
}

use std::io::{BufRead, BufReader, Read, Write};

use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use sha2::{Digest, Sha256};

use metadata::AttachmentScan;

pub use taomni_mail_api::archive::MessageObject;

/// Encode into a staging writer. The archive owner handles publication.
pub fn compress_message(
    mut raw: impl Read,
    destination: impl Write,
    check: impl Fn() -> Result<(), String>,
) -> Result<MessageObject, String> {
    let mut encoder = GzEncoder::new(destination, Compression::new(3));
    let mut hash = Sha256::new();
    let mut raw_size = 0u64;
    let mut attachments = AttachmentScan::default();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        check()?;
        let n = raw
            .read(&mut buffer)
            .map_err(|e| format!("Read full email: {e}"))?;
        if n == 0 {
            break;
        }
        let bytes = &buffer[..n];
        attachments.feed(bytes);
        hash.update(bytes);
        raw_size += n as u64;
        encoder
            .write_all(bytes)
            .map_err(|e| format!("Compress full email: {e}"))?;
    }
    encoder
        .finish()
        .map_err(|e| format!("Finish full email: {e}"))?;
    Ok(MessageObject {
        hash: hex::encode(hash.finalize()),
        raw_size,
        has_attachments: attachments.found,
    })
}

pub fn has_attachment(source: impl Read) -> Result<bool, String> {
    let mut reader = GzDecoder::new(source);
    let mut scan = AttachmentScan::default();
    let mut buffer = [0u8; 64 * 1024];
    while !scan.found {
        let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        scan.feed(&buffer[..n]);
    }
    Ok(scan.found)
}

pub fn verify_message(
    source: impl Read,
    hash: &str,
    expected: u64,
    destination: impl Write,
) -> Result<(), String> {
    verify_message_with(source, hash, expected, destination, || Ok(()))
}

pub(crate) fn verify_message_with(
    source: impl Read,
    hash: &str,
    expected: u64,
    destination: impl Write,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    verify_decoded(GzDecoder::new(source), hash, expected, destination, check)
}

/// Accept a host-produced object only when it contains exactly one gzip member
/// for the selected MIME. Previously stored objects retain their reader semantics.
pub fn verify_encoded_original(
    source: impl Read,
    receipt: &MessageObject,
    hash: &str,
    size: u64,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    if receipt.raw_size != size || receipt.hash != hash {
        return Err("Mail archive encoding does not match the selected original".into());
    }
    let mut member = flate2::bufread::GzDecoder::new(BufReader::new(source));
    verify_decoded(&mut member, hash, size, std::io::sink(), check)?;
    if !member
        .into_inner()
        .fill_buf()
        .map_err(|e| e.to_string())?
        .is_empty()
    {
        return Err("Unexpected data after the compressed Mail original".into());
    }
    Ok(())
}

fn verify_decoded(
    mut decoder: impl Read,
    hash: &str,
    expected: u64,
    mut destination: impl Write,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        check()?;
        let n = decoder
            .read(&mut buffer)
            .map_err(|e| format!("Saved email is damaged: {e}"))?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > expected {
            return Err("Saved email size verification failed".into());
        }
        digest.update(&buffer[..n]);
        destination
            .write_all(&buffer[..n])
            .map_err(|e| e.to_string())?;
    }
    if size != expected || hex::encode(digest.finalize()) != hash {
        return Err("Saved email checksum verification failed".into());
    }
    Ok(())
}

#[cfg(test)]
mod encoding_tests {
    use super::*;
    use std::io::Seek;

    #[test]
    fn only_the_exact_original_can_leave_staging() {
        let root = tempfile::tempdir().unwrap();
        let raw = b"Subject: Selected original\r\n\r\nLocal body";
        let mut gzip = Vec::new();
        let receipt = compress_message(raw.as_slice(), &mut gzip, || Ok(())).unwrap();
        let mut appended = gzip.clone();
        appended.extend_from_slice(&gzip);
        let mut different = Vec::new();
        compress_message(&b"x".repeat(raw.len())[..], &mut different, || Ok(())).unwrap();
        let truncated = &gzip[..gzip.len() - 1];
        for (bytes, checksum, paused) in [
            (gzip.as_slice(), "wrong receipt", false),
            (gzip.as_slice(), receipt.hash.as_str(), true),
            (truncated, receipt.hash.as_str(), false),
            (appended.as_slice(), receipt.hash.as_str(), false),
            (different.as_slice(), receipt.hash.as_str(), false),
        ] {
            let staged = crate::storage::prepare_with(root.path(), |file| {
                file.write_all(bytes).unwrap();
                file.rewind().unwrap();
                verify_encoded_original(file, &receipt, checksum, raw.len() as u64, || {
                    if paused { Err("paused".into()) } else { Ok(()) }
                })?;
                unreachable!("An invalid or cancelled encoding passed verification")
            });
            assert!(staged.is_err());
            assert_eq!(root.path().join("objects").read_dir().unwrap().count(), 0);
        }
        verify_encoded_original(
            gzip.as_slice(),
            &receipt,
            &receipt.hash,
            raw.len() as u64,
            || Ok(()),
        )
        .unwrap();
    }
}
