//! Bounded messages for the authenticated Local Voice channel.

use std::{io, path::PathBuf};

use serde::{Deserialize, Serialize};
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const SLUG: &str = "ai-voice-local";
pub const PREPARE: &str = "voice/prepare";
pub const START: &str = "voice/start";
pub const COMMANDS: [&str; 2] = [PREPARE, START];
pub const SAMPLE_RATE: usize = 16_000;
pub const MAX_AUDIO_SAMPLES: usize = 120 * SAMPLE_RATE;
pub const MAX_CHUNK_SAMPLES: usize = 16 * 1024;
const MAX_RESPONSE: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelSelection {
    pub models_root: PathBuf,
    pub model_id: String,
    pub language: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Start {
    pub selection: ModelSelection,
    pub mode: Mode,
    pub channel: Endpoint,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Mode {
    Decode,
    FinalSegments,
    Zipformer {
        directory: PathBuf,
        language: String,
    },
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
pub struct Transcript {
    pub text: String,
    pub final_text: bool,
    pub processing_ms: u64,
    pub provider: String,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reply {
    Transcript(Transcript),
    Complete(Result<(), String>),
}

pub async fn read_audio(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<Option<Vec<f32>>> {
    let count = reader.read_u32_le().await? as usize;
    if count == 0 {
        return Ok(None);
    }
    if count > MAX_CHUNK_SAMPLES {
        return Err(invalid("Local Voice audio chunk exceeds limit"));
    }
    let mut bytes = vec![0; count * size_of::<f32>()];
    reader.read_exact(&mut bytes).await?;
    let pcm: Vec<f32> = bytes
        .chunks_exact(size_of::<f32>())
        .map(|sample| f32::from_le_bytes(sample.try_into().expect("four bytes per sample")))
        .collect();
    if pcm.iter().any(|sample| !sample.is_finite()) {
        return Err(invalid("Local Voice audio contains an invalid sample"));
    }
    Ok(Some(pcm))
}

pub async fn write_audio(writer: &mut (impl AsyncWrite + Unpin), pcm: &[f32]) -> io::Result<()> {
    for chunk in pcm.chunks(MAX_CHUNK_SAMPLES) {
        writer.write_u32_le(chunk.len() as u32).await?;
        let mut bytes = Vec::with_capacity(std::mem::size_of_val(chunk));
        for sample in chunk {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        writer.write_all(&bytes).await?;
    }
    Ok(())
}

pub async fn finish_audio(writer: &mut (impl AsyncWrite + Unpin)) -> io::Result<()> {
    writer.write_u32_le(0).await?;
    writer.flush().await
}

pub async fn read_reply(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<Reply> {
    let bytes = reader.read_u32_le().await? as usize;
    if bytes == 0 || bytes > MAX_RESPONSE {
        return Err(invalid("Invalid Local Voice reply length"));
    }
    let mut payload = vec![0; bytes];
    reader.read_exact(&mut payload).await?;
    serde_json::from_slice(&payload).map_err(io::Error::other)
}

pub async fn write_reply(writer: &mut (impl AsyncWrite + Unpin), value: &Reply) -> io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(io::Error::other)?;
    if payload.len() > MAX_RESPONSE {
        return Err(invalid("Local Voice reply exceeds limit"));
    }
    writer.write_u32_le(payload.len() as u32).await?;
    writer.write_all(&payload).await?;
    writer.flush().await
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn audio_frames_preserve_samples_and_split_large_buffers() {
        let mut input = vec![0.25; MAX_CHUNK_SAMPLES];
        input.push(-0.5);
        let mut wire = Vec::new();
        write_audio(&mut wire, &input).await.unwrap();
        finish_audio(&mut wire).await.unwrap();
        let mut read = wire.as_slice();
        assert_eq!(
            read_audio(&mut read).await.unwrap().unwrap(),
            input[..MAX_CHUNK_SAMPLES]
        );
        assert_eq!(read_audio(&mut read).await.unwrap().unwrap(), vec![-0.5]);
        assert!(read_audio(&mut read).await.unwrap().is_none());
        assert!(read.is_empty());
    }

    #[tokio::test]
    async fn an_invalid_or_truncated_frame_cannot_finish_recording() {
        let oversize = (MAX_CHUNK_SAMPLES as u32 + 1).to_le_bytes();
        assert_eq!(
            read_audio(&mut oversize.as_slice())
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            read_audio(&mut 1_u32.to_le_bytes().as_slice())
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
}
