use super::*;

#[tauri::command]
pub async fn chat_stat_attachment_paths(
    paths: Vec<String>,
) -> Result<Vec<store::ChatAttachment>, String> {
    stat_attachment_paths(paths)
}

#[tauri::command]
pub fn chat_read_clipboard_image_attachment(
    state: State<'_, AppState>,
) -> Result<store::ChatAttachment, String> {
    let (width, height, bytes) = {
        let mut guard = state
            .clipboard
            .lock()
            .map_err(|e| format!("clipboard lock: {}", e))?;
        if guard.is_none() {
            *guard = Some(arboard::Clipboard::new().map_err(|e| format!("clipboard init: {}", e))?);
        }
        let clipboard = guard
            .as_mut()
            .ok_or_else(|| "clipboard unavailable".to_string())?;
        let image = clipboard
            .get_image()
            .map_err(|_| "Clipboard does not contain an image.".to_string())?;
        (
            image.width as u32,
            image.height as u32,
            image.bytes.to_vec(),
        )
    };
    clipboard_image_attachment_from_rgba(width, height, &bytes)
}

pub(super) fn stat_attachment_paths(
    paths: Vec<String>,
) -> Result<Vec<store::ChatAttachment>, String> {
    if paths.len() > CHAT_MAX_ATTACHMENTS {
        return Err(format!("Attach up to {CHAT_MAX_ATTACHMENTS} files."));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        let clean = path.trim();
        if clean.is_empty() {
            continue;
        }
        let attachment = stat_attachment_path(clean, None)?;
        if seen.insert(attachment.path.clone()) {
            out.push(attachment);
        }
    }
    validate_attachment_limits(&out)?;
    Ok(out)
}

pub(super) fn validate_chat_attachments(
    input: &[store::ChatAttachment],
) -> Result<Vec<store::ChatAttachment>, String> {
    if input.len() > CHAT_MAX_ATTACHMENTS {
        return Err(format!("Attach up to {CHAT_MAX_ATTACHMENTS} files."));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for att in input {
        let clean = att.path.trim();
        if clean.is_empty() {
            continue;
        }
        let id = att
            .id
            .trim()
            .is_empty()
            .then(|| Uuid::new_v4().to_string())
            .unwrap_or_else(|| att.id.clone());
        let attachment = stat_attachment_path(clean, Some(id))?;
        if seen.insert(attachment.path.clone()) {
            out.push(attachment);
        }
    }
    validate_attachment_limits(&out)?;
    Ok(out)
}

pub(super) fn validate_attachment_limits(
    attachments: &[store::ChatAttachment],
) -> Result<(), String> {
    if attachments.len() > CHAT_MAX_ATTACHMENTS {
        return Err(format!("Attach up to {CHAT_MAX_ATTACHMENTS} files."));
    }
    let total = attachments
        .iter()
        .try_fold(0_u64, |sum, att| sum.checked_add(att.size))
        .ok_or_else(|| "Attached files are too large.".to_string())?;
    if total > CHAT_MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "Attached files can total at most {} MiB.",
            CHAT_MAX_ATTACHMENT_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

pub(super) fn stat_attachment_path(
    path: &str,
    id: Option<String>,
) -> Result<store::ChatAttachment, String> {
    let original = Path::new(path);
    let metadata = std::fs::metadata(original)
        .map_err(|e| format!("Cannot read attachment metadata for '{path}': {e}"))?;
    if !metadata.is_file() {
        return Err(format!("Attachment is not a file: {path}"));
    }
    let canonical = std::fs::canonicalize(original)
        .map_err(|e| format!("Cannot resolve attachment path '{path}': {e}"))?;
    let display_path = normalize_path_for_display(canonical.to_string_lossy().to_string());
    let name = canonical
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            original
                .file_name()
                .and_then(|s| s.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| display_path.clone());
    let mime = infer_mime(&name);
    let kind = if is_supported_image_mime(&mime) {
        "image"
    } else {
        "file"
    };
    Ok(store::ChatAttachment {
        id: id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        kind: kind.into(),
        path: display_path,
        name,
        size: metadata.len(),
        mime: Some(mime),
        preview_url: None,
    })
}

pub(super) fn clipboard_image_attachment_from_rgba(
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<store::ChatAttachment, String> {
    let buf =
        image::RgbaImage::from_raw(width, height, rgba.to_vec()).ok_or("invalid image buffer")?;
    let path = std::env::temp_dir().join(format!("taomni-chat-clipboard-{}.png", Uuid::new_v4()));
    buf.save(&path)
        .map_err(|e| format!("save clipboard image: {e}"))?;
    let mut attachment = stat_attachment_path(&path.to_string_lossy(), None)?;
    attachment.name = "Pasted image".into();
    attachment.mime = Some("image/png".into());
    attachment.kind = "image".into();
    Ok(attachment)
}

pub(super) fn normalize_path_for_display(path: String) -> String {
    #[cfg(windows)]
    {
        if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = path.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    path
}

pub(super) fn infer_mime(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "csv" => "text/csv",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "rs" | "ts" | "tsx" | "js" | "jsx" | "css" | "toml" | "sql" | "sh" | "ps1" | "py"
        | "go" | "java" | "kt" | "c" | "cc" | "cpp" | "h" | "hpp" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

pub(super) fn is_supported_image_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

pub(super) fn is_text_mime(mime: &str) -> bool {
    mime.starts_with("text/")
        || matches!(
            mime,
            "application/json" | "application/xml" | "application/yaml"
        )
}

pub(super) fn render_agent_attachment_prefix(attachments: &[store::ChatAttachment]) -> String {
    if attachments.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "[Attached files]\nThese files are local to this Taomni machine. Read them from the listed paths when relevant.\n",
    );
    for (idx, att) in attachments.iter().enumerate() {
        out.push_str(&format!(
            "{}. {} ({}, {} bytes)\n   path: {}\n",
            idx + 1,
            att.name,
            att.mime.as_deref().unwrap_or("application/octet-stream"),
            att.size,
            att.path
        ));
    }
    out.push('\n');
    out
}

pub(super) fn build_llm_attachment_message(
    attachments: &[store::ChatAttachment],
) -> Result<Option<LlmMessage>, String> {
    if attachments.is_empty() {
        return Ok(None);
    }

    let mut text = String::from(
        "[Attached files]\nLocal filesystem paths are intentionally omitted for privacy. Use the attached contents below.\n",
    );
    let mut parts = Vec::new();
    for (idx, att) in attachments.iter().enumerate() {
        let mime = att
            .mime
            .as_deref()
            .unwrap_or("application/octet-stream")
            .to_string();
        text.push_str(&format!(
            "\n{}. {} ({}, {} bytes)",
            idx + 1,
            att.name,
            mime,
            att.size
        ));
        if att.kind == "image" && is_supported_image_mime(&mime) {
            let bytes = std::fs::read(&att.path)
                .map_err(|e| format!("Cannot read image attachment '{}': {e}", att.name))?;
            let data_base64 = BASE64_STANDARD.encode(bytes);
            parts.push(ChatContentPart::Image {
                mime_type: mime,
                data_base64,
            });
            text.push_str("\n   image data is attached as a multimodal input.");
        } else if is_text_mime(&mime) {
            let (preview, truncated) = read_text_attachment_preview(&att.path)?;
            let (clean, _) = redact::redact(&preview);
            text.push_str("\n```text\n");
            text.push_str(&clean);
            if truncated {
                text.push_str("\n[truncated]");
            }
            text.push_str("\n```");
        } else {
            text.push_str("\n   binary contents were not sent to this cloud/local LLM provider.");
        }
    }
    parts.insert(0, ChatContentPart::Text { text });
    Ok(Some(LlmMessage::user_parts(parts)))
}

pub(super) fn read_text_attachment_preview(path: &str) -> Result<(String, bool), String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Cannot read text attachment '{path}': {e}"))?;
    let mut limited = file.take(TEXT_ATTACHMENT_PREVIEW_BYTES + 1);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read text attachment '{path}': {e}"))?;
    let truncated = bytes.len() as u64 > TEXT_ATTACHMENT_PREVIEW_BYTES;
    if truncated {
        bytes.truncate(TEXT_ATTACHMENT_PREVIEW_BYTES as usize);
    }
    Ok((String::from_utf8_lossy(&bytes).to_string(), truncated))
}
