use crate::chat::GeneratedMediaFile;
use crate::chat::MediaGenerationKind;
use crate::chat::media::extension_for_mime;
use crate::chat::media::generation_output_path;
use crate::chat::media::infer_image_mime;
use futures::StreamExt;
use std::io::Read;
use std::path::Path;
use tauri::AppHandle;

pub(super) const GROK_GENERATED_MEDIA_MAX_BYTES: u64 = 512 * 1024 * 1024;

pub(super) async fn copy_grok_generated_media(
    app: &AppHandle,
    kind: MediaGenerationKind,
    candidates: &[String],
    model: &str,
) -> Result<GeneratedMediaFile, String> {
    // Video creation can first emit its generated still frame, so examine the
    // newest artifacts first and select by actual file type rather than a
    // Grok-private rawOutput type label.
    for candidate in candidates.iter().rev() {
        if let Some(file) = copy_grok_generated_media_candidate(app, kind, candidate, model).await?
        {
            return Ok(file);
        }
    }
    Err(format!(
        "Grok CLI completed without providing a readable generated {}.",
        kind.as_str()
    ))
}

pub(super) async fn copy_grok_generated_media_candidate(
    app: &AppHandle,
    kind: MediaGenerationKind,
    candidate: &str,
    model: &str,
) -> Result<Option<GeneratedMediaFile>, String> {
    let candidate_path = Path::new(candidate);
    // Grok's native tools return an absolute artifact path. Rejecting relative
    // values prevents an unexpected ACP payload from making Taomni copy a
    // workspace file merely because its name happens to match a media type.
    if !candidate_path.is_absolute() {
        return Ok(None);
    }
    let Ok(source) = std::fs::canonicalize(candidate_path) else {
        return Ok(None);
    };
    let Ok(metadata) = tokio::fs::metadata(&source).await else {
        return Ok(None);
    };
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > GROK_GENERATED_MEDIA_MAX_BYTES
    {
        return Ok(None);
    }
    let Some(mime) = grok_generated_media_mime(&source, kind).await else {
        return Ok(None);
    };
    let target =
        generation_output_path(app, kind.as_str(), extension_for_mime(&mime, kind.as_str()))?;
    tokio::fs::copy(&source, &target)
        .await
        .map_err(|_| "Could not copy Grok-generated media into Taomni storage.".to_string())?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_else(|| {
            if kind == MediaGenerationKind::Image {
                "generated-image.png"
            } else {
                "generated-video.mp4"
            }
        })
        .to_string();
    Ok(Some(GeneratedMediaFile {
        path: target,
        name,
        size: metadata.len(),
        mime,
        remote_url: None,
        video_id: None,
        model: model.to_string(),
    }))
}

pub(super) async fn grok_generated_media_mime(
    path: &Path,
    kind: MediaGenerationKind,
) -> Option<String> {
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut header = [0_u8; 16];
    let bytes_read = file.read(&mut header).await.ok()?;
    let header = &header[..bytes_read];
    match kind {
        MediaGenerationKind::Image => infer_image_mime(header),
        MediaGenerationKind::Video if header.get(4..8) == Some(b"ftyp") => Some("video/mp4".into()),
        MediaGenerationKind::Video if header.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) => {
            Some("video/webm".into())
        }
        MediaGenerationKind::Video => match path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref()
        {
            Some("mp4") => Some("video/mp4".into()),
            Some("webm") => Some("video/webm".into()),
            _ => None,
        },
    }
}
