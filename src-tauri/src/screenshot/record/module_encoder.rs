use std::{path::Path, sync::mpsc::Receiver, time::Duration};

use anyhow::{Context, bail, ensure};
use taomni_plugin_stream::routed_tcp::Route;
use taomni_screenshot_api::{
    ClipMetadata, FrameHeader, MAX_CLIP_BYTES, RecordFormat, RecordStart, RecordingInfo, SLUG,
    START_RECORDING, TimedFrame,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, DuplexStream};

use crate::plugin::{LifecycleState, PluginRegistry};

pub(in crate::screenshot) const MODULE_UNAVAILABLE: &str =
    "Install and enable the Screenshot module in Settings → Module Store before recording.";

pub(in crate::screenshot) fn selected(registry: &PluginRegistry) -> anyhow::Result<bool> {
    let Some(module) = registry.get(SLUG) else {
        return legacy_recording();
    };
    if module.state != LifecycleState::Enabled {
        bail!(MODULE_UNAVAILABLE);
    }
    // An installed OCR-only module predates recording support.
    if module.manifest.commands.contains(START_RECORDING) {
        Ok(true)
    } else if cfg!(any(test, feature = "legacy-screenshot-media")) {
        Ok(false)
    } else {
        bail!("Update the Screenshot module in Settings → Module Store to record.");
    }
}

fn legacy_recording() -> anyhow::Result<bool> {
    if cfg!(any(test, feature = "legacy-screenshot-media")) {
        Ok(false)
    } else {
        bail!(MODULE_UNAVAILABLE);
    }
}

pub(in crate::screenshot) fn available(registry: &PluginRegistry) -> bool {
    selected(registry).is_ok()
}

pub(super) struct Encoder {
    _route: Route,
    stream: DuplexStream,
}

pub(super) fn connect(
    registry: &PluginRegistry,
    format: RecordFormat,
    fps: u32,
    (width, height): (u32, u32),
) -> anyhow::Result<Encoder> {
    let (_route, source, stream) = tauri::async_runtime::block_on(Route::pair())?;
    let request = RecordStart {
        source,
        format: format.extension().into(),
        fps,
        width,
        height,
    };
    registry.invoke(SLUG, START_RECORDING, serde_json::to_value(request)?)?;
    Ok(Encoder { _route, stream })
}

pub(super) fn encode(
    encoder: Encoder,
    input: Receiver<TimedFrame>,
    format: RecordFormat,
    (width, height): (u32, u32),
    path: &Path,
) -> anyhow::Result<RecordingInfo> {
    let runtime = tauri::async_runtime::handle();
    let Encoder { _route, mut stream } = encoder;
    for frame in input {
        let end = frame.image.width() == 0;
        let header = FrameHeader {
            at_ms: frame.at_ms,
            end,
        };
        if !end {
            ensure!(
                frame.image.dimensions() == (width, height),
                "Recording frame size changed mid-stream"
            );
        }
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(15), async {
                stream.write_all(&header.bytes()).await?;
                stream.write_all(frame.image.as_raw()).await
            })
            .await
            .context("Recording encoder stopped accepting frames")?
            .context("Send screenshot recording frame")
        })?;
        if end {
            let clip = runtime
                .block_on(async {
                    tokio::time::timeout(
                        Duration::from_secs(60),
                        receive(&mut stream, path, format, width, height, frame.at_ms),
                    )
                    .await
                })
                .context("Recording encoder did not return a finished clip")??;
            return Ok(RecordingInfo::from_clip(path.to_path_buf(), clip));
        }
    }
    bail!("Screen capture stopped before it sent the end of the recording");
}

async fn receive(
    stream: &mut (impl AsyncRead + Unpin),
    path: &Path,
    format: RecordFormat,
    width: u32,
    height: u32,
    end_ms: u64,
) -> anyhow::Result<ClipMetadata> {
    let metadata_size = stream
        .read_u16()
        .await
        .context("Read recording clip metadata")?;
    ensure!(
        (1..=512).contains(&metadata_size),
        "Invalid recording clip metadata size"
    );
    let mut metadata = vec![0; usize::from(metadata_size)];
    stream.read_exact(&mut metadata).await?;
    let clip: ClipMetadata = serde_json::from_slice(&metadata)?;
    ensure!(
        clip.width == width
            && clip.height == height
            && clip.frames > 0
            && clip.duration_ms == end_ms,
        "The recording clip does not match the captured frames"
    );
    let size = stream.read_u64().await?;
    ensure!(
        (8..=MAX_CLIP_BYTES).contains(&size),
        "Invalid recording clip size"
    );
    let mut header = [0; 8];
    stream.read_exact(&mut header).await?;
    let valid = match format {
        RecordFormat::Gif => header.starts_with(b"GIF89a"),
        RecordFormat::Mp4 => &header[4..] == b"ftyp",
    };
    ensure!(
        valid,
        "The recording encoder returned a different file format"
    );
    let directory = path.parent().context("Invalid recording output path")?;
    let partial = tempfile::NamedTempFile::new_in(directory)?;
    let mut file = tokio::fs::File::from_std(partial.reopen()?);
    file.write_all(&header).await?;
    let remaining = size - 8;
    let copied = tokio::io::copy(&mut stream.take(remaining), &mut file).await?;
    ensure!(
        copied == remaining,
        "The recording encoder returned an incomplete clip"
    );
    file.flush().await?;
    drop(file);
    partial
        .persist_noclobber(path)
        .map_err(|error| error.error)?;
    Ok(clip)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(size: u64) -> Vec<u8> {
        let metadata = serde_json::json!({
            "width": 64, "height": 48, "frames": 1, "durationMs": 100,
        });
        let metadata = serde_json::to_vec(&metadata).unwrap();
        let mut reply = Vec::new();
        reply.extend_from_slice(&(metadata.len() as u16).to_be_bytes());
        reply.extend_from_slice(&metadata);
        reply.extend_from_slice(&size.to_be_bytes());
        reply.extend_from_slice(b"GIF89a\x40\x00\x30\x00");
        reply
    }

    #[tokio::test]
    async fn truncated_clip_leaves_no_published_or_partial_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recording.gif");
        let bytes = reply(11);
        let result = receive(&mut bytes.as_slice(), &path, RecordFormat::Gif, 64, 48, 100).await;
        assert!(result.unwrap_err().to_string().contains("incomplete clip"));
        assert_eq!(directory.path().read_dir().unwrap().count(), 0);
    }

    #[tokio::test]
    async fn complete_clip_is_published_without_replacing_existing_output() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recording.gif");
        let bytes = reply(10);
        let mut stream = bytes.as_slice();
        let clip = receive(&mut stream, &path, RecordFormat::Gif, 64, 48, 100)
            .await
            .unwrap();
        assert_eq!(clip.frames, 1);
        assert_eq!(std::fs::read(&path).unwrap(), b"GIF89a\x40\x00\x30\x00");
        std::fs::write(&path, b"existing").unwrap();
        let result = receive(&mut bytes.as_slice(), &path, RecordFormat::Gif, 64, 48, 100).await;
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"existing");
    }
}
