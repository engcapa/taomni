//! Streaming codec for immutable, content-addressed email archives.
mod imap_chunks;
mod metadata;

pub use imap_chunks::{CHUNK, CONTENT_ERROR, fetch_imap_chunk};

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

use std::io::{Read, Write};

use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use sha2::{Digest, Sha256};

use metadata::AttachmentScan;

pub struct MessageObject {
    pub hash: String,
    pub raw_size: u64,
    pub has_attachments: bool,
}

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
    mut destination: impl Write,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut decoder = GzDecoder::new(source);
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
