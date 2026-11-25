//! Framed output of a signed host encoding one selected MIME original.
use std::{io::Write, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::{archive_index::ArchiveKey, imap_sync::HeaderStepRequest};

pub const PUBLISH_IMAP_ARCHIVE: &str = "mail/publish-imap-archive";
pub const ARCHIVE_FRAME_BYTES: usize = 64 * 1024;
pub const IMAP_ARCHIVE_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveStatus {
    pub phase: String,
    pub folder: Option<String>,
    pub saved: usize,
    pub headers_synced: usize,
    pub headers_total: Option<u32>,
    pub total: usize,
    pub bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveEncoding {
    pub exchange: Endpoint,
    pub raw_size: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveDecoding {
    pub exchange: Endpoint,
    pub account_id: String,
    pub folder: String,
    pub uid: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveAttachmentDecoding {
    pub exchange: Endpoint,
    pub attachment_index: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishArchiveOriginal {
    pub account_id: String,
    pub cache_database: PathBuf,
    pub key: ArchiveKey,
    pub staged: StagedArchiveOriginal,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedArchiveOriginal {
    pub filename: String,
    pub stored_size: u64,
    pub object: MessageObject,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageObject {
    pub hash: String,
    pub raw_size: u64,
    pub has_attachments: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum ArchiveQuery {
    Folders {
        account_id: String,
    },
    Headers(HeaderStepRequest),
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

pub async fn receive_encoding(
    output: &mut impl Write,
    size: u64,
    mut reader: impl AsyncRead + Unpin,
    idle_timeout: Duration,
) -> Result<MessageObject, String> {
    // Deflate's bounded overhead is below 1% plus one frame even for
    // incompressible input. Reject excess output before writing it to disk.
    let maximum = size
        .saturating_add(size / 100)
        .saturating_add(ARCHIVE_FRAME_BYTES as u64);
    let mut total = 0_u64;
    let mut buffer = vec![0; ARCHIVE_FRAME_BYTES];
    let mut length = [0; 4];
    loop {
        read_exact(&mut reader, &mut length, idle_timeout).await?;
        let count = u32::from_be_bytes(length) as usize;
        if count == 0 {
            break;
        }
        total = total.saturating_add(count as u64);
        if count > buffer.len() || total > maximum {
            return Err("Mail archive encoding exceeds the expected size".into());
        }
        read_exact(&mut reader, &mut buffer[..count], idle_timeout).await?;
        output
            .write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
    }
    read_exact(&mut reader, &mut length, idle_timeout).await?;
    let count = u32::from_be_bytes(length) as usize;
    if !(1..=4096).contains(&count) {
        return Err("Mail archive encoding receipt has an invalid length".into());
    }
    read_exact(&mut reader, &mut buffer[..count], idle_timeout).await?;
    serde_json::from_slice(&buffer[..count]).map_err(|e| e.to_string())
}

async fn read_exact(
    reader: &mut (impl AsyncRead + Unpin),
    mut bytes: &mut [u8],
    idle_timeout: Duration,
) -> Result<(), String> {
    while !bytes.is_empty() {
        let count = tokio::time::timeout(idle_timeout, reader.read(bytes))
            .await
            .map_err(|_| "Mail archive encoding stalled".to_owned())?
            .map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("Mail archive encoding ended early".into());
        }
        bytes = &mut bytes[count..];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncWriteExt, duplex};

    fn frame(bytes: &[u8]) -> Vec<u8> {
        let mut wire = (bytes.len() as u32).to_be_bytes().to_vec();
        wire.extend_from_slice(bytes);
        wire
    }

    #[tokio::test(start_paused = true)]
    async fn stalls_in_a_header_chunk_or_receipt_expire() {
        for prefix in [
            vec![],
            vec![0, 0],
            vec![0, 0, 0, 2, 1],
            vec![0, 0, 0, 0],
            vec![0, 0, 0, 0, 0, 0, 0, 2, b'{'],
        ] {
            let (mut sender, receiver) = duplex(32);
            sender.write_all(&prefix).await.unwrap();
            let result =
                receive_encoding(&mut Vec::new(), 12, receiver, Duration::from_secs(1)).await;
            assert_eq!(result.unwrap_err(), "Mail archive encoding stalled");
        }
    }

    #[tokio::test]
    async fn a_truncated_or_oversized_reply_never_produces_a_receipt() {
        let limit = Duration::from_secs(1);
        for wire in [
            vec![0, 0, 0, 1],
            [frame(b"abc"), vec![0; 4]].concat(),
            [vec![0; 4], 4097_u32.to_be_bytes().to_vec()].concat(),
            vec![0; 8],
            ((ARCHIVE_FRAME_BYTES + 1) as u32).to_be_bytes().to_vec(),
            [frame(&vec![0; ARCHIVE_FRAME_BYTES]), frame(b"excess")].concat(),
        ] {
            assert!(
                receive_encoding(&mut Vec::new(), 0, wire.as_slice(), limit)
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_active_transfer_can_exceed_the_idle_deadline() {
        let receipt = br#"{"hash":"sample","rawSize":4,"hasAttachments":false}"#;
        let wire = [frame(b"one"), frame(b"two"), vec![0; 4], frame(receipt)].concat();
        let (mut sender, receiver) = duplex(8);
        let mut output = Vec::new();
        let slow = async {
            for piece in wire.chunks(3) {
                tokio::time::sleep(Duration::from_millis(600)).await;
                sender.write_all(piece).await.unwrap();
            }
        };
        let (object, ()) = tokio::join!(
            receive_encoding(&mut output, 4, receiver, Duration::from_secs(1)),
            slow
        );
        assert_eq!(object.unwrap().raw_size, 4);
        assert_eq!(output, b"onetwo");
    }
}
