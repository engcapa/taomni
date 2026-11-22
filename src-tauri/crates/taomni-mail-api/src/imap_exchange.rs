//! An IMAP operation has one socket for the server and one for request data.

use std::io;

use serde::{Deserialize, Serialize};
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::IncomingTest;

const MAX_FRAME_BYTES: usize = taomni_plugin_stream::MAX_PAYLOAD_BYTES;
pub const MAX_PREFETCH_BODIES: usize = 4;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrefetchBodies {
    pub account_id: String,
    pub folder: String,
    pub uids: Vec<u32>,
    pub body_max_bytes: u32,
    pub save_original: bool,
}

impl PrefetchBodies {
    pub fn is_valid(&self) -> bool {
        !self.account_id.trim().is_empty()
            && self.account_id.len() <= 1024
            && !self.folder.trim().is_empty()
            && !self.uids.is_empty()
            && self.uids.len() <= MAX_PREFETCH_BODIES
            && self
                .uids
                .iter()
                .enumerate()
                .all(|(index, uid)| *uid != 0 && !self.uids[..index].contains(uid))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapExchange {
    pub connection: IncomingTest,
    pub exchange: Endpoint,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawMessageRequest {
    pub connection: IncomingTest,
    pub exchange: Endpoint,
    pub folder: String,
    pub uid: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentRequest {
    pub connection: IncomingTest,
    pub exchange: Endpoint,
    pub folder: String,
    pub uid: u32,
    pub index: usize,
    pub section: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentReceipt {
    pub name: Option<String>,
    pub content_type: Option<String>,
    pub size: usize,
}

pub async fn read_frame(stream: &mut (impl AsyncRead + Unpin)) -> io::Result<Vec<u8>> {
    let size = stream.read_u32().await? as usize;
    validate_size(size)?;
    read_payload(stream, size).await
}

/// A decoded body can exceed the control frame limit when the server returns
/// a complete text or HTML section for an oversized message.
pub async fn read_body_frame(stream: &mut (impl AsyncRead + Unpin)) -> io::Result<Vec<u8>> {
    let size = usize::try_from(stream.read_u64().await?)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Mail body size is invalid"))?;
    read_payload(stream, size).await
}

pub async fn write_body_frame(
    stream: &mut (impl AsyncWrite + Unpin),
    data: &[u8],
) -> io::Result<()> {
    stream.write_u64(data.len() as u64).await?;
    stream.write_all(data).await
}

async fn read_payload(stream: &mut (impl AsyncRead + Unpin), size: usize) -> io::Result<Vec<u8>> {
    let mut data = Vec::new();
    stream.take(size as u64).read_to_end(&mut data).await?;
    if data.len() != size {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Incomplete Mail IMAP frame",
        ));
    }
    Ok(data)
}

pub async fn write_frame(stream: &mut (impl AsyncWrite + Unpin), data: &[u8]) -> io::Result<()> {
    validate_size(data.len())?;
    stream.write_u32(data.len() as u32).await?;
    stream.write_all(data).await
}

fn validate_size(size: usize) -> io::Result<()> {
    if size > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Mail IMAP frame exceeds its limit",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transfers_a_frame_larger_than_the_control_channel() {
        let payload: Vec<_> = (0..2 * 1024 * 1024)
            .map(|value| (value % 251) as u8)
            .collect();
        let (mut local, mut remote) = tokio::io::duplex(4096);
        let (written, received) =
            tokio::join!(write_frame(&mut local, &payload), read_frame(&mut remote));
        written.unwrap();
        assert_eq!(received.unwrap(), payload);
    }

    #[tokio::test]
    async fn rejects_a_truncated_frame() {
        let (mut local, mut remote) = tokio::io::duplex(16);
        local.write_u32(5).await.unwrap();
        local.write_all(b"only").await.unwrap();
        drop(local);
        assert_eq!(
            read_frame(&mut remote).await.unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[tokio::test]
    async fn rejects_an_oversized_frame_before_reading_its_body() {
        let (mut local, mut remote) = tokio::io::duplex(4);
        local.write_u32((MAX_FRAME_BYTES + 1) as u32).await.unwrap();
        assert_eq!(
            read_frame(&mut remote).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
