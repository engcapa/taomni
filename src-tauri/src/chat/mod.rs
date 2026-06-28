pub mod inline_qq;
pub mod redact;
pub mod run;
pub mod store;

use crate::ai::config::{default_ai_config_path, AiConfig};
use crate::llm::{
    ChatContentPart, ChatMessage as LlmMessage, ChatRequest, ChatStreamEvent, TaskKind,
};
use crate::state::AppState;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn normalize_thread_mode(mode: Option<String>) -> Result<String, String> {
    let mode = mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("chat");
    match mode {
        "chat" | "image" | "video" => Ok(mode.to_string()),
        _ => Err(format!(
            "Invalid chat thread mode '{mode}': expected 'chat', 'image', or 'video'."
        )),
    }
}

const CHAT_MAX_ATTACHMENTS: usize = 10;
const CHAT_MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;
const TEXT_ATTACHMENT_PREVIEW_BYTES: u64 = 64 * 1024;
const AGNES_DEFAULT_IMAGE_MODEL: &str = "agnes-image-2.1-flash";
const AGNES_DEFAULT_VIDEO_MODEL: &str = "agnes-video-v2.0";
const DEFAULT_IMAGE_SIZE: &str = "1024x768";
const DEFAULT_VIDEO_WIDTH: u32 = 1152;
const DEFAULT_VIDEO_HEIGHT: u32 = 768;
const DEFAULT_VIDEO_NUM_FRAMES: u32 = 121;
const DEFAULT_VIDEO_FRAME_RATE: u32 = 24;
const VIDEO_POLL_ATTEMPTS: usize = 90;
const VIDEO_POLL_INTERVAL_SECS: u64 = 4;

#[tauri::command]
pub async fn chat_stat_attachment_paths(
    paths: Vec<String>,
) -> Result<Vec<store::ChatAttachment>, String> {
    stat_attachment_paths(paths)
}

fn stat_attachment_paths(paths: Vec<String>) -> Result<Vec<store::ChatAttachment>, String> {
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

fn validate_chat_attachments(
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

fn validate_attachment_limits(attachments: &[store::ChatAttachment]) -> Result<(), String> {
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

fn stat_attachment_path(path: &str, id: Option<String>) -> Result<store::ChatAttachment, String> {
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
    })
}

fn normalize_path_for_display(path: String) -> String {
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

fn infer_mime(name: &str) -> String {
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

fn is_supported_image_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

fn is_text_mime(mime: &str) -> bool {
    mime.starts_with("text/")
        || matches!(
            mime,
            "application/json" | "application/xml" | "application/yaml"
        )
}

fn render_agent_attachment_prefix(attachments: &[store::ChatAttachment]) -> String {
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

fn build_llm_attachment_message(
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

fn read_text_attachment_preview(path: &str) -> Result<(String, bool), String> {
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

/// Resolve the effective output format for a thread, falling back to the
/// global default. Returns one of "md" | "html" | "plain".
fn resolve_output_format(thread: &store::ChatThread, config: &AiConfig) -> String {
    let candidate = thread
        .output_format
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| config.chat_output_format.clone());
    match candidate.as_str() {
        "md" | "html" | "plain" => candidate,
        _ => "md".into(),
    }
}

/// Build the assistant system prompt. The base prompt explains the role; an
/// extra paragraph instructs the assistant to format its replies as Markdown,
/// raw HTML, or plain text — matching what the renderer is expecting.
fn build_system_prompt(format: &str) -> String {
    let base = "You are the AI assistant inside the Taomni terminal manager. \
                Help the user manage SSH sessions, analyse terminal output, and craft shell commands. \
                Reply in the same language the user writes in (default Chinese), and stay concise.";
    let format_clause = match format {
        "html" => "Render your reply as a self-contained HTML fragment. \
                   Use semantic tags such as <p>, <ul>/<ol>, <li>, <h2>/<h3>, <code>, and <pre><code class=\"language-…\"> for code blocks. \
                   Do NOT wrap the answer in <html>, <body>, <head>, <script>, <style>, or include event handlers — the host sanitises everything else.",
        "plain" => "Reply in plain text only — no Markdown syntax, no HTML tags. \
                    Keep paragraphs short and use blank lines for separation.",
        // "md" is the default.
        _ => "Format your reply as GitHub-flavoured Markdown. \
              Use ```language fenced blocks for code, `inline code` for symbols/commands, \
              tables / bullet lists / headings (##, ###) when they help readability. \
              Do NOT wrap the entire answer in a single fenced block.",
    };
    format!("{}\n\n{}", base, format_clause)
}

/// Create a new chat thread.
#[tauri::command]
pub async fn chat_new_thread(
    provider_id: Option<String>,
    linked_session_id: Option<String>,
    mode: Option<String>,
    state: State<'_, AppState>,
) -> Result<store::ChatThread, String> {
    let config = AiConfig::load(&default_ai_config_path());
    let pid = provider_id.unwrap_or_else(|| config.llm.active.clone());
    let mode = normalize_thread_mode(mode)?;
    let thread = store::ChatThread {
        id: Uuid::new_v4().to_string(),
        title: "New chat".into(),
        provider_id: pid,
        created_at: now(),
        updated_at: now(),
        linked_session_id,
        source: "drawer".into(),
        mode,
        cc_session_id: None,
        // New threads inherit the global default; the user can override per-thread later.
        output_format: None,
        cc_model: None,
    };
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::create_thread(&db, &thread).map_err(|e| e.to_string())?;
    Ok(thread)
}

/// List recent chat threads.
#[tauri::command]
pub async fn chat_list_threads(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<store::ChatThread>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::list_threads(&db, limit.unwrap_or(50)).map_err(|e| e.to_string())
}

/// List messages in a thread.
#[tauri::command]
pub async fn chat_list_messages(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<store::ChatMessage>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::list_messages(&db, &thread_id).map_err(|e| e.to_string())
}

/// Delete a thread and all its messages.
#[tauri::command]
pub async fn chat_delete_thread(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::delete_thread(&db, &thread_id).map_err(|e| e.to_string())
}

/// Change the provider (LLM) bound to an existing thread. Subsequent
/// chat_send / chat_stream calls on this thread will use the new provider.
#[tauri::command]
pub async fn chat_set_thread_provider(
    thread_id: String,
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::update_thread_provider(&db, &thread_id, &provider_id).map_err(|e| e.to_string())?;
    }
    // Switching away from a local agent provider orphans its per-thread child;
    // recycle so we don't leak the process / MCP token / temp dir.
    if provider_id != "claude-code" {
        crate::agent::cc_bridge::commands::recycle_thread_process(state.inner(), &thread_id).await;
    }
    if provider_id != "codex" {
        crate::agent::codex_bridge::commands::recycle_thread_process(state.inner(), &thread_id)
            .await;
    }
    Ok(())
}

/// Set or clear the per-thread Claude Code model override. Pass `None`/empty
/// to inherit `cc_bridge.default_model`. The model
/// is a spawn-time `--model` arg the live process can't adopt, so we recycle
/// the thread's CC process — the next message respawns it with the new model.
#[tauri::command]
pub async fn chat_set_thread_cc_model(
    thread_id: String,
    model: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::update_thread_cc_model(&db, &thread_id, model.as_deref())
            .map_err(|e| e.to_string())?;
    }
    crate::agent::cc_bridge::commands::recycle_thread_process(state.inner(), &thread_id).await;
    crate::agent::codex_bridge::commands::recycle_thread_process(state.inner(), &thread_id).await;
    Ok(())
}

/// Set or clear the per-thread output-format override ("md" | "html" | "plain").
/// Pass `None` (or an empty string) to clear and inherit `AiConfig.chat_output_format`.
#[tauri::command]
pub async fn chat_set_thread_output_format(
    thread_id: String,
    output_format: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let normalized = output_format
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    if let Some(fmt) = normalized {
        if !matches!(fmt, "md" | "html" | "plain") {
            return Err(format!(
                "Invalid output_format '{}': expected 'md', 'html', or 'plain'.",
                fmt
            ));
        }
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::update_thread_output_format(&db, &thread_id, normalized).map_err(|e| e.to_string())
}

/// Sweep retention: delete threads older than `keep_days`. Returns the number
/// of threads deleted. Frontend invokes this at startup and on a 24h timer.
#[tauri::command]
pub async fn chat_purge_old(keep_days: u32, state: State<'_, AppState>) -> Result<usize, String> {
    let cutoff = chrono::Utc::now().timestamp() - (keep_days as i64) * 86_400;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    store::delete_threads_older_than(&db, cutoff).map_err(|e| e.to_string())
}

/// Export every thread + message into a single JSON file at `out_path`.
/// We write JSON (not zip) for portability — the user can compress externally.
/// Sensitive content already passed through `redact::redact` before persistence.
#[tauri::command]
pub async fn chat_export_archive(
    out_path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    use serde_json::json;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let threads = store::list_threads(&db, 100_000).map_err(|e| e.to_string())?;
    let mut total = 0;
    let mut payload = Vec::with_capacity(threads.len());
    for t in &threads {
        let messages = store::list_messages(&db, &t.id).map_err(|e| e.to_string())?;
        total += messages.len();
        payload.push(json!({
            "thread": t,
            "messages": messages,
        }));
    }
    let json_text = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&out_path, json_text).map_err(|e| e.to_string())?;
    Ok(total)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatSendRequest {
    pub thread_id: String,
    pub content: String,
    /// Local files/images attached to this turn. The backend re-stats and
    /// canonicalizes paths before persisting or sending to providers.
    #[serde(default)]
    pub attachments: Vec<store::ChatAttachment>,
    /// Optional terminal content to attach as @terminal context.
    pub terminal_context: Option<String>,
    /// Phase 3.S — the `SessionConfig.id` of the saved session this CC thread
    /// is bound to, resolved by the frontend from the linked terminal tab's
    /// registry entry (`thread.linked_session_id` is a *tab* id, not a
    /// `SessionConfig.id`, so the backend cannot derive this on its own). Used
    /// to build the session-identity card injected into Claude Code. `None` for
    /// unbound / local / unsaved-tab threads.
    #[serde(default)]
    pub bound_session_id: Option<String>,
    /// Phase 3.3 — the bound terminal's live working directory (from the
    /// frontend's OSC-7 tracking). Unlike the session-identity card, cwd is
    /// volatile (the user `cd`s around), so it is injected *per turn* as a
    /// message prefix rather than baked into the spawn-time card. Informational
    /// only — it does not set the CC child's `current_dir` or grant `--add-dir`
    /// access (that is 3.2, deliberately out of scope). `None` when unknown.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Live local-terminal facts (platform / shell id / shell args / cwd) for
    /// Claude Code's appended system prompt. Only present for local terminal
    /// tabs; SSH/remote tabs leave this absent so their saved session card stays
    /// the source of truth.
    #[serde(default)]
    pub local_terminal_env: Option<crate::agent::cc_bridge::session_card::LocalTerminalEnv>,
    /// Phase 6 — the live `db_connections` runtime id this CC thread is bound to,
    /// for SQL/Redis DB sessions. Like `cwd`, it is volatile (the frontend
    /// regenerates it on each (re)connect and the backend can't derive it), so
    /// it is bridged *per turn* and stored into `AppState.cc_db_bindings` so the
    /// DB MCP handlers can resolve their bound connection. `None` for non-DB
    /// threads or a DB tab that isn't connected.
    #[serde(default)]
    pub bound_db_connection_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ChatSendResponse {
    pub user_message: store::ChatMessage,
    pub assistant_message: store::ChatMessage,
    pub redacted_count: usize,
}

#[derive(Debug, Deserialize)]
pub struct ChatGenerateMediaRequest {
    pub thread_id: String,
    pub prompt: String,
    /// "image" or "video". Must match the thread mode.
    pub kind: String,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub num_frames: Option<u32>,
    #[serde(default)]
    pub frame_rate: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct ChatGenerateMediaResponse {
    pub user_message: store::ChatMessage,
    pub assistant_message: store::ChatMessage,
    pub redacted_count: usize,
    pub saved_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_id: Option<String>,
    pub model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaGenerationKind {
    Image,
    Video,
}

impl MediaGenerationKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim() {
            "image" => Ok(Self::Image),
            "video" => Ok(Self::Video),
            other => Err(format!(
                "Invalid media generation kind '{other}': expected 'image' or 'video'."
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
        }
    }
}

struct GeneratedMediaFile {
    path: PathBuf,
    name: String,
    size: u64,
    mime: String,
    remote_url: Option<String>,
    video_id: Option<String>,
    model: String,
}

#[derive(Debug, Deserialize)]
struct AgnesImageResponse {
    data: Vec<AgnesImageData>,
}

#[derive(Debug, Deserialize)]
struct AgnesImageData {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    b64_json: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AgnesVideoCreateResponse {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    video_id: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AgnesVideoResultResponse {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    progress: Option<u32>,
    #[serde(default)]
    remixed_from_video_id: Option<String>,
    #[serde(default)]
    video_url: Option<String>,
    #[serde(default)]
    error: Option<Value>,
}

fn resolve_ai_api_key(
    provider_id: &str,
    api_key: &str,
    state: &AppState,
) -> Result<String, String> {
    if !api_key.starts_with(crate::vault::VAULT_REF_PREFIX) {
        if api_key.trim().is_empty() {
            return Err(format!("Provider '{provider_id}' is missing an API key."));
        }
        return Ok(api_key.to_string());
    }
    match state.vault.resolve(api_key) {
        Ok(Some(plaintext)) => Ok(plaintext.to_string()),
        Ok(None) => Ok(api_key.to_string()),
        Err(e) => {
            if e.contains(crate::vault::ERR_VAULT_LOCKED) {
                Err(format!(
                    "VAULT_LOCKED: provider '{provider_id}' needs the vault unlocked to load its API key"
                ))
            } else {
                Err(e)
            }
        }
    }
}

fn provider_api_url(provider_base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        provider_base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn provider_gateway_root(provider_base_url: &str) -> String {
    provider_base_url
        .trim_end_matches('/')
        .strip_suffix("/v1")
        .unwrap_or_else(|| provider_base_url.trim_end_matches('/'))
        .to_string()
}

fn provider_error(status: u16, body: String) -> String {
    let parsed: Result<Value, _> = serde_json::from_str(&body);
    let message = parsed
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| {
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .or_else(|| error.as_str())
                })
                .map(str::to_string)
        })
        .unwrap_or(body);
    format!("Provider error {status}: {message}")
}

fn decode_base64_image(value: &str) -> Result<(Vec<u8>, String), String> {
    let trimmed = value.trim();
    let (mime, data) = if let Some(rest) = trimmed.strip_prefix("data:") {
        let Some((mime, b64)) = rest.split_once(";base64,") else {
            return Err("Invalid Data URI image response.".into());
        };
        (mime.to_string(), b64)
    } else {
        ("image/png".to_string(), trimmed)
    };
    let bytes = BASE64_STANDARD
        .decode(data)
        .map_err(|e| format!("Decode generated image: {e}"))?;
    let inferred = infer_image_mime(&bytes).unwrap_or(mime);
    Ok((bytes, inferred))
}

fn infer_image_mime(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png".into())
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("image/jpeg".into())
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp".into())
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif".into())
    } else {
        None
    }
}

fn extension_for_mime(mime: &str, fallback: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => match fallback {
            "image" => "png",
            "video" => "mp4",
            _ => "bin",
        },
    }
}

fn generation_output_path(app: &AppHandle, kind: &str, ext: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Resolve app data dir: {e}"))?
        .join("ai-generations")
        .join(chrono::Local::now().format("%Y-%m-%d").to_string());
    std::fs::create_dir_all(&base).map_err(|e| format!("Create generation output dir: {e}"))?;
    Ok(base.join(format!(
        "{}-{}-{}.{}",
        kind,
        chrono::Local::now().format("%H%M%S"),
        Uuid::new_v4().simple(),
        ext
    )))
}

async fn save_generated_bytes(
    app: &AppHandle,
    kind: &str,
    bytes: &[u8],
    mime: &str,
) -> Result<PathBuf, String> {
    let ext = extension_for_mime(mime, kind);
    let path = generation_output_path(app, kind, ext)?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("Save generated {kind}: {e}"))?;
    Ok(path)
}

async fn download_url_to_file(
    client: &Client,
    app: &AppHandle,
    kind: &str,
    url: &str,
    default_mime: &str,
) -> Result<(PathBuf, String, u64), String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download generated {kind}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(provider_error(status.as_u16(), body));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_mime)
        .to_string();
    let ext = extension_for_mime(&mime, kind);
    let path = generation_output_path(app, kind, ext)?;
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("Create generated {kind} file: {e}"))?;
    let mut total = 0_u64;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download generated {kind}: {e}"))?;
        total = total
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| format!("Generated {kind} is too large."))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write generated {kind}: {e}"))?;
    }
    file.flush()
        .await
        .map_err(|e| format!("Flush generated {kind}: {e}"))?;
    Ok((path, mime, total))
}

async fn generate_image_file(
    client: &Client,
    app: &AppHandle,
    provider: &crate::ai::config::LlmProviderConfig,
    api_key: &str,
    prompt: &str,
    size: &str,
) -> Result<GeneratedMediaFile, String> {
    let model = provider
        .image_model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(AGNES_DEFAULT_IMAGE_MODEL)
        .to_string();
    let body = json!({
        "model": model,
        "prompt": prompt,
        "size": size,
        "return_base64": true,
    });
    let resp = client
        .post(provider_api_url(&provider.base_url, "images/generations"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Generate image: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(provider_error(status.as_u16(), body));
    }
    let api_resp: AgnesImageResponse = resp
        .json()
        .await
        .map_err(|e| format!("Parse image response: {e}"))?;
    let first = api_resp
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "Image generation returned no data.".to_string())?;
    let remote_url = first.url.clone();
    let (path, mime, size) = if let Some(b64) = first.b64_json {
        let (bytes, mime) = decode_base64_image(&b64)?;
        let path = save_generated_bytes(app, "image", &bytes, &mime).await?;
        let size = bytes.len() as u64;
        (path, mime, size)
    } else if let Some(url) = &first.url {
        download_url_to_file(client, app, "image", url, "image/png").await?
    } else {
        return Err("Image generation response contained neither b64_json nor url.".into());
    };
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("generated-image.png")
        .to_string();
    Ok(GeneratedMediaFile {
        path,
        name,
        size,
        mime,
        remote_url,
        video_id: None,
        model,
    })
}

fn validate_video_num_frames(num_frames: u32) -> Result<u32, String> {
    if num_frames == 0 || num_frames > 441 {
        return Err("num_frames must be between 1 and 441.".into());
    }
    if (num_frames + 7) % 8 != 0 {
        return Err("num_frames must follow the 8n + 1 rule, for example 81 or 121.".into());
    }
    Ok(num_frames)
}

async fn generate_video_file(
    client: &Client,
    app: &AppHandle,
    provider: &crate::ai::config::LlmProviderConfig,
    api_key: &str,
    req: &ChatGenerateMediaRequest,
    prompt: &str,
) -> Result<GeneratedMediaFile, String> {
    let model = provider
        .video_model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(AGNES_DEFAULT_VIDEO_MODEL)
        .to_string();
    let num_frames = validate_video_num_frames(req.num_frames.unwrap_or(DEFAULT_VIDEO_NUM_FRAMES))?;
    let frame_rate = req
        .frame_rate
        .unwrap_or(DEFAULT_VIDEO_FRAME_RATE)
        .clamp(1, 60);
    let body = json!({
        "model": model,
        "prompt": prompt,
        "height": req.height.unwrap_or(DEFAULT_VIDEO_HEIGHT),
        "width": req.width.unwrap_or(DEFAULT_VIDEO_WIDTH),
        "num_frames": num_frames,
        "frame_rate": frame_rate,
    });
    let resp = client
        .post(provider_api_url(&provider.base_url, "videos"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Create video task: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(provider_error(status.as_u16(), body));
    }
    let create_resp: AgnesVideoCreateResponse = resp
        .json()
        .await
        .map_err(|e| format!("Parse video task response: {e}"))?;
    let video_id = create_resp
        .video_id
        .clone()
        .or(create_resp.id.clone())
        .or(create_resp.task_id.clone())
        .ok_or_else(|| "Video task response did not include video_id or task_id.".to_string())?;
    let gateway_root = provider_gateway_root(&provider.base_url);
    let mut last_status = create_resp.status.unwrap_or_else(|| "queued".into());
    let mut last_progress = 0_u32;
    let mut final_url: Option<String> = None;
    for _ in 0..VIDEO_POLL_ATTEMPTS {
        let resp = client
            .get(format!("{gateway_root}/agnesapi"))
            .bearer_auth(api_key)
            .query(&[
                ("video_id", video_id.as_str()),
                ("model_name", model.as_str()),
            ])
            .send()
            .await
            .map_err(|e| format!("Poll video task: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(provider_error(status.as_u16(), body));
        }
        let result: AgnesVideoResultResponse = resp
            .json()
            .await
            .map_err(|e| format!("Parse video result response: {e}"))?;
        last_status = result.status.unwrap_or(last_status);
        last_progress = result.progress.unwrap_or(last_progress);
        if last_status == "completed" {
            final_url = result.remixed_from_video_id.or(result.video_url);
            break;
        }
        if last_status == "failed" {
            return Err(format!(
                "Video generation failed: {}",
                result
                    .error
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown error".into())
            ));
        }
        tokio::time::sleep(std::time::Duration::from_secs(VIDEO_POLL_INTERVAL_SECS)).await;
    }
    let Some(remote_url) = final_url else {
        return Err(format!(
            "Video generation timed out while status was '{last_status}' ({last_progress}%)."
        ));
    };
    let (path, mime, size) =
        download_url_to_file(client, app, "video", &remote_url, "video/mp4").await?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("generated-video.mp4")
        .to_string();
    Ok(GeneratedMediaFile {
        path,
        name,
        size,
        mime,
        remote_url: Some(remote_url),
        video_id: Some(video_id),
        model,
    })
}

#[tauri::command]
pub async fn chat_generate_media(
    req: ChatGenerateMediaRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ChatGenerateMediaResponse, String> {
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled {
            return Err("AI is fully disabled.".into());
        }
    }
    let kind = MediaGenerationKind::parse(&req.kind)?;
    let (thread, history) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let thread = store::get_thread(&db, &req.thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Thread '{}' not found", req.thread_id))?;
        let history = store::list_messages(&db, &req.thread_id).map_err(|e| e.to_string())?;
        (thread, history)
    };
    if thread.mode != kind.as_str() {
        return Err(format!(
            "Thread '{}' is a {} thread, not a {} generation thread.",
            thread.id,
            thread.mode,
            kind.as_str()
        ));
    }

    let ai_config = AiConfig::load(&default_ai_config_path());
    let provider = ai_config
        .llm
        .providers
        .get(&thread.provider_id)
        .cloned()
        .ok_or_else(|| format!("Provider '{}' is not configured.", thread.provider_id))?;
    let has_capability = match kind {
        MediaGenerationKind::Image => provider.capabilities.image_generation,
        MediaGenerationKind::Video => provider.capabilities.video_generation,
    };
    if !has_capability {
        return Err(format!(
            "Provider '{}' does not support {} generation.",
            thread.provider_id,
            kind.as_str()
        ));
    }
    let api_key = resolve_ai_api_key(&thread.provider_id, &provider.api_key, state.inner())?;
    let (clean_prompt, redacted_count) = redact::redact(&req.prompt);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(360))
        .build()
        .map_err(|e| format!("Create generation HTTP client: {e}"))?;
    let generated = match kind {
        MediaGenerationKind::Image => {
            let size = req
                .size
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(DEFAULT_IMAGE_SIZE);
            generate_image_file(&client, &app, &provider, &api_key, &clean_prompt, size).await?
        }
        MediaGenerationKind::Video => {
            generate_video_file(&client, &app, &provider, &api_key, &req, &clean_prompt).await?
        }
    };
    let display_path = normalize_path_for_display(generated.path.to_string_lossy().to_string());
    let mut assistant_content = match kind {
        MediaGenerationKind::Image => format!("Generated image saved to:\n{display_path}"),
        MediaGenerationKind::Video => format!("Generated video saved to:\n{display_path}"),
    };
    if let Some(remote_url) = &generated.remote_url {
        assistant_content.push_str("\n\nRemote URL:\n");
        assistant_content.push_str(remote_url);
    }
    if let Some(video_id) = &generated.video_id {
        assistant_content.push_str("\n\nVideo ID: ");
        assistant_content.push_str(video_id);
    }
    let ts = now();
    let user_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "user".into(),
        content: clean_prompt,
        created_at: ts,
        redacted: redacted_count > 0,
        attachments: Vec::new(),
    };
    let assistant_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "assistant".into(),
        content: assistant_content,
        created_at: ts + 1,
        redacted: false,
        attachments: vec![store::ChatAttachment {
            id: Uuid::new_v4().to_string(),
            kind: kind.as_str().into(),
            path: display_path.clone(),
            name: generated.name,
            size: generated.size,
            mime: Some(generated.mime),
        }],
    };
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_message(&db, &user_msg).map_err(|e| e.to_string())?;
        store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
        if history.is_empty() {
            let title = user_msg.content.chars().take(40).collect::<String>();
            store::update_thread_title(&db, &req.thread_id, &title).map_err(|e| e.to_string())?;
        }
    }

    Ok(ChatGenerateMediaResponse {
        user_message: user_msg,
        assistant_message: assistant_msg,
        redacted_count,
        saved_path: display_path,
        remote_url: generated.remote_url,
        video_id: generated.video_id,
        model: generated.model,
    })
}

/// Send a message and get a response (non-streaming for v2.4 static shell).
#[tauri::command]
pub async fn chat_send(
    req: ChatSendRequest,
    state: State<'_, AppState>,
) -> Result<ChatSendResponse, String> {
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled {
            return Err("AI is fully disabled.".into());
        }
    }
    let attachments = validate_chat_attachments(&req.attachments)?;

    // Load thread to get provider.
    let (thread, history) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let thread = store::get_thread(&db, &req.thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Thread '{}' not found", req.thread_id))?;
        let history = store::list_messages(&db, &req.thread_id).map_err(|e| e.to_string())?;
        (thread, history)
    };
    if thread.mode != "chat" {
        return Err(format!(
            "Thread '{}' is a {} generation thread; use media generation.",
            thread.id, thread.mode
        ));
    }

    // Redact user content.
    let (clean_content, redacted_count) = redact::redact(&req.content);

    // Resolve the effective output format and build the system prompt around it.
    let ai_config = AiConfig::load(&default_ai_config_path());
    let output_format = resolve_output_format(&thread, &ai_config);
    let system_prompt = build_system_prompt(&output_format);

    // Build LLM messages from history + new user message.
    let mut llm_messages: Vec<LlmMessage> = vec![LlmMessage::system(system_prompt)];

    // Add terminal context if provided.
    if let Some(ctx) = &req.terminal_context {
        let (clean_ctx, _) = redact::redact(ctx);
        llm_messages.push(LlmMessage::user(format!(
            "[Terminal context]\n```\n{}\n```",
            clean_ctx
        )));
        llm_messages.push(LlmMessage::assistant(
            "Acknowledged — I have read the terminal output.",
        ));
    }

    // Add conversation history.
    for msg in &history {
        llm_messages.push(LlmMessage {
            role: msg.role.clone(),
            content: crate::llm::ChatContent::text(msg.content.clone()),
        });
    }
    if let Some(attachment_message) = build_llm_attachment_message(&attachments)? {
        llm_messages.push(attachment_message);
    }
    llm_messages.push(LlmMessage::user(clean_content.clone()));

    // Route through LlmRouter — respects task routing + fallback + active provider.
    // The thread's provider_id picks the route: if it equals the configured
    // chat_drawer route, we go through ChatDrawer task; otherwise we ask the
    // router for that specific provider directly.
    let llm_req = ChatRequest {
        messages: llm_messages,
        max_tokens: Some(1024),
        temperature: Some(0.7),
        stream: false,
    };

    let resp = {
        let ai_ctx = state.ai_ctx.read().await;
        // Prefer the thread's pinned provider when available.
        if let Some(provider) = ai_ctx.llm.provider(&thread.provider_id) {
            provider.chat(llm_req).await.map_err(|e| e.to_string())?
        } else if ai_ctx.llm.needs_vault_unlock(&thread.provider_id) {
            // Pinned provider is blocked on a locked vault. Fail closed with
            // a VAULT_LOCKED error so the frontend can prompt for unlock
            // instead of routing the request through some other provider the
            // user did not intend to use.
            return Err(format!(
                "VAULT_LOCKED: provider '{}' needs the vault unlocked to load its API key",
                thread.provider_id
            ));
        } else {
            // Fall back to the task-routed provider with timeout/fallback.
            ai_ctx
                .llm
                .complete(llm_req, TaskKind::ChatDrawer)
                .await
                .map_err(|e| e.to_string())?
        }
    };

    // Persist both messages.
    let ts = now();
    let user_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "user".into(),
        content: clean_content,
        created_at: ts,
        redacted: redacted_count > 0,
        attachments,
    };
    let assistant_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "assistant".into(),
        content: resp.content,
        created_at: ts + 1,
        redacted: false,
        attachments: Vec::new(),
    };

    // Auto-title thread from first user message.
    let is_first = history.is_empty();

    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_message(&db, &user_msg).map_err(|e| e.to_string())?;
        store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
        if is_first {
            let title = user_msg.content.chars().take(40).collect::<String>();
            store::update_thread_title(&db, &req.thread_id, &title).map_err(|e| e.to_string())?;
        }
    }

    Ok(ChatSendResponse {
        user_message: user_msg,
        assistant_message: assistant_msg,
        redacted_count,
    })
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamEventOut {
    /// User message persisted; frontend can render it immediately.
    UserMessage { message: store::ChatMessage },
    /// Assistant message id allocated; tokens will follow under this id.
    AssistantStart {
        id: String,
        thread_id: String,
        created_at: i64,
    },
    /// One token (or token group) of the assistant response.
    Token { id: String, content: String },
    /// Stream ended cleanly; assistant message persisted.
    End {
        id: String,
        thread_id: String,
        content: String,
        redacted_count: usize,
    },
    /// Stream ended with an error (assistant message NOT persisted).
    Error { id: String, message: String },
    /// Claude Code tool activity for live, display-only cards (3.5). Carries NO
    /// re-executable payload — confirmation already happened via the MCP
    /// permission prompt; this is purely for rendering. The persisted message
    /// still contains the compact text transcript line (history durability), so
    /// the frontend shows these cards only while the message is streaming.
    CcToolActivity {
        /// Assistant message id these cards group under.
        id: String,
        /// CC tool_use id, pairing a "use" with its later "result".
        call_id: String,
        /// "use" | "result".
        phase: String,
        tool: String,
        detail: String,
    },
    /// Claude Code token/cost/timing rollup for the assistant message footer
    /// (3.5). Live-only (not persisted), emitted once on the final result.
    Usage {
        id: String,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
    },
}

/// The one-line argument summary for a CC tool call ("ls -la", "/tmp/x.rs", …).
fn cc_tool_arg_summary(input: &serde_json::Value) -> Option<&str> {
    input
        .get("command")
        .and_then(|v| v.as_str())
        .or_else(|| input.get("file_path").and_then(|v| v.as_str()))
        .or_else(|| input.get("notebook_path").and_then(|v| v.as_str()))
        .or_else(|| input.get("path").and_then(|v| v.as_str()))
}

/// Render a CC tool-use event as a compact, human-readable transcript line.
///
/// This is *not* a `[TOOL_CALL]` marker — it carries no machine-parseable JSON,
/// so MessageBubble never turns it into an ActionCard or re-executes it. It
/// exists purely so the chat keeps a record of what Claude Code did (the real
/// confirmation happens live via the in-app MCP server's permission prompt).
fn format_cc_tool_use(name: &str, input: &serde_json::Value) -> String {
    match cc_tool_arg_summary(input) {
        Some(s) => format!("\n> 🔧 `{}` — {}\n", name, s),
        None => format!("\n> 🔧 `{}`\n", name),
    }
}

/// A short, single-line preview of a CC tool result for the transcript /
/// display card (collapses whitespace, truncates).
fn cc_tool_result_preview(content: &str) -> String {
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 200 {
        let truncated: String = flat.chars().take(200).collect();
        format!("{truncated}…")
    } else {
        flat
    }
}

#[tauri::command]
pub async fn chat_stop_stream(thread_id: String, state: State<'_, AppState>) -> Result<(), String> {
    // Stop the in-flight turn regardless of provider/runtime. Claude Code also
    // and Codex keep persistent per-thread process registries for reuse; remove
    // those entries on explicit stop so the next turn starts from clean bridge
    // processes.
    let run = { state.chat_runs.lock().await.remove(&thread_id) };
    let cc_process = { state.cc_processes.lock().await.remove(&thread_id) };
    let codex_process = { state.codex_processes.lock().await.remove(&thread_id) };

    if let Some(run) = run {
        run.stop().await;
    }
    if let Some(process) = cc_process {
        if !process.is_stopped() {
            process.stop().await;
        }
    }
    if let Some(process) = codex_process {
        process.stop().await;
    }
    Ok(())
}

/// Streaming variant of `chat_send`. Emits events on
/// `chat-stream:{thread_id}` and resolves once the stream finishes (or errors).
#[tauri::command]
pub async fn chat_stream(
    req: ChatSendRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled {
            return Err("AI is fully disabled.".into());
        }
    }

    let event_name = format!("chat-stream:{}", req.thread_id);
    let emit = |evt: &StreamEventOut| {
        let _ = app.emit(&event_name, evt.clone());
    };
    let attachments = validate_chat_attachments(&req.attachments)?;

    // Load thread + history.
    let (thread, history) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let thread = store::get_thread(&db, &req.thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Thread '{}' not found", req.thread_id))?;
        let history = store::list_messages(&db, &req.thread_id).map_err(|e| e.to_string())?;
        (thread, history)
    };
    if thread.mode != "chat" {
        return Err(format!(
            "Thread '{}' is a {} generation thread; use media generation.",
            thread.id, thread.mode
        ));
    }

    let (clean_content, redacted_count) = redact::redact(&req.content);

    // Persist user message immediately.
    let ts = now();
    let user_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "user".into(),
        content: clean_content.clone(),
        created_at: ts,
        redacted: redacted_count > 0,
        attachments: attachments.clone(),
    };
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_message(&db, &user_msg).map_err(|e| e.to_string())?;
    }
    emit(&StreamEventOut::UserMessage {
        message: user_msg.clone(),
    });
    if thread.provider_id == "claude-code" {
        // Allocate the assistant message id and begin streaming.
        let assistant_id = Uuid::new_v4().to_string();
        let assistant_ts = now() + 1;
        emit(&StreamEventOut::AssistantStart {
            id: assistant_id.clone(),
            thread_id: req.thread_id.clone(),
            created_at: assistant_ts,
        });

        // 1. Verify Claude Code is enabled
        let ai_config = AiConfig::load(&default_ai_config_path());
        if !ai_config.cc_bridge.enabled || ai_config.fully_disabled || ai_config.full_local_mode {
            emit(&StreamEventOut::Error {
                id: assistant_id,
                message:
                    "Claude Code is unavailable in full-local / fully-disabled mode or is disabled."
                        .into(),
            });
            return Ok(());
        }

        // 2. Find Claude Code CLI binary path
        let binary = if ai_config.cc_bridge.binary == "auto" {
            crate::agent::cc_bridge::find_claude_binary().ok_or("Claude Code CLI not found")?
        } else {
            ai_config.cc_bridge.binary.clone()
        };

        // 3. Resolve session id for --resume continuity.
        let resume_session = thread.cc_session_id.clone();

        // 4. Get or create the per-thread CC process. Only a *new* process
        //    materialises temp config files — a reused process keeps the
        //    obscure settings file it was launched with (and which is scrubbed
        //    when the session stops).
        let existing = { state.cc_processes.lock().await.get(&req.thread_id).cloned() };
        let process = match existing {
            Some(p) => p,
            None => {
                // Phase 6 — pick the MCP flavor from the bound session's type so
                // the thread loads *only* the right tool surface: a SQL DB
                // session (MySQL/PG/SQL Server/ClickHouse/Presto) gets the SQL tools, Redis
                // gets the Redis tools, everything else (SSH/local/unbound) gets
                // the shell tools. Resolve in a tight scope so the db lock is
                // dropped before the async provision call.
                let flavor = {
                    use crate::agent::cc_bridge::mcp_http::Flavor;
                    let session_type = req
                        .bound_session_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .and_then(|sid| {
                            let db = state.db.lock().ok()?;
                            crate::session::db::get_session(&db, sid).ok()
                        })
                        .map(|sc| sc.session_type);
                    Flavor::for_session_type(session_type.as_ref())
                };

                // Provision the in-app rmcp MCP server + a per-thread scoped
                // token (trust inferred from whether the thread is linked to a
                // remote session). Injected into the thread's .mcp.json.
                let (cc_server_url, cc_token) =
                    match crate::agent::cc_bridge::mcp_http::provision_for_thread(
                        &app,
                        &req.thread_id,
                        thread.linked_session_id.clone(),
                        req.bound_session_id.clone(),
                        flavor,
                        ai_config.cc_bridge.confirm_readonly,
                    )
                    .await
                    {
                        Ok(v) => v,
                        Err(e) => {
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                    };
                let control_server_url =
                    match crate::agent::cc_bridge::mcp_http::control_server_url() {
                        Ok(v) => v,
                        Err(e) => {
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                    };
                // Resolve the user's custom settings.json from the vault (when
                // configured). A locked vault means we can't read the token, so
                // surface it as a stream error and let the UI prompt to unlock.
                let custom = match crate::agent::cc_bridge::config::resolve_custom_settings(
                    &ai_config.cc_bridge,
                    &state.vault,
                ) {
                    Ok(c) => c,
                    Err(e) => {
                        emit(&StreamEventOut::Error {
                            id: assistant_id.clone(),
                            message: e,
                        });
                        return Ok(());
                    }
                };
                let files = match crate::agent::cc_bridge::config::create_session_files(
                    custom.as_deref(),
                    flavor.server_name(),
                    &cc_server_url,
                    &cc_token,
                    &control_server_url,
                ) {
                    Ok(f) => f,
                    Err(e) => {
                        emit(&StreamEventOut::Error {
                            id: assistant_id.clone(),
                            message: e,
                        });
                        return Ok(());
                    }
                };

                // Phase 3.S — assemble the session-identity card so CC knows
                // which saved session this thread is bound to, then inject it
                // as CC's appended system prompt. Written into the process temp
                // dir (scrubbed on stop/drop) and passed via the *file* flag so
                // the bound host/user never appear in argv (which other local
                // users can read via `ps`).
                let session_card = {
                    let db = state.db.lock().map_err(|e| e.to_string())?;
                    let session = req
                        .bound_session_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .and_then(|sid| crate::session::db::get_session(&db, sid).ok());
                    let recent = session
                        .as_ref()
                        .map(|sc| {
                            crate::history::db_list_recent(
                                &db,
                                &crate::agent::cc_bridge::session_card::host_key_for(sc),
                                crate::agent::cc_bridge::session_card::HISTORY_LIMIT,
                            )
                            .unwrap_or_default()
                        })
                        .unwrap_or_default();
                    let raw = crate::agent::cc_bridge::session_card::render_card(
                        session.as_ref(),
                        &req.thread_id,
                        thread.linked_session_id.is_some(),
                        &recent,
                        req.local_terminal_env.as_ref(),
                    );
                    redact::redact(&raw).0
                };
                let card_path = files.dir.join("system-prompt.txt");
                let card_file: Option<String> = match std::fs::write(&card_path, &session_card) {
                    Ok(()) => Some(card_path.to_string_lossy().to_string()),
                    Err(e) => {
                        eprintln!("[cc] session card write failed, continuing without it: {e}");
                        None
                    }
                };

                // Build extra args. The model is per-thread (3.4) when set,
                // else the configured default. Baked into argv at spawn, so a
                // model change recycles the process (chat_set_thread_cc_model).
                let model = thread
                    .cc_model
                    .clone()
                    .filter(|m| !m.trim().is_empty())
                    .unwrap_or_else(|| ai_config.cc_bridge.default_model.clone());
                let mut extra_args = vec![
                    "--model".into(),
                    model,
                    "--max-turns".into(),
                    ai_config.cc_bridge.max_turns.to_string(),
                    "--settings".into(),
                    files.settings_path.to_string_lossy().to_string(),
                    "--mcp-config".into(),
                    files.mcp_path.to_string_lossy().to_string(),
                    // Use *only* our MCP config; ignore any user ~/.claude MCP
                    // that could bypass the permission pipeline.
                    "--strict-mcp-config".into(),
                    "--permission-prompt-tool".into(),
                    flavor.permission_prompt_tool().into(),
                ];
                // Phase 3.S — inject the session-identity card (file variant
                // keeps host/user out of argv).
                if let Some(path) = card_file {
                    extra_args.push("--append-system-prompt-file".into());
                    extra_args.push(path);
                }
                if let Some(sid) = &resume_session {
                    extra_args.push("--resume".into());
                    extra_args.push(sid.clone());
                }

                let p = std::sync::Arc::new(
                    crate::agent::cc_bridge::process::CcProcess::new(
                        &binary,
                        extra_args,
                        Some(files.dir),
                    )
                    .with_token(cc_token.clone()),
                );
                // Re-check under the lock in case a concurrent send for the
                // same thread created one first; if so, our `p` is dropped and
                // its temp dir cleaned by the Drop impl.
                let mut registry = state.cc_processes.lock().await;
                match registry.get(&req.thread_id) {
                    Some(existing) => existing.clone(),
                    None => {
                        registry.insert(req.thread_id.clone(), p.clone());
                        p
                    }
                }
            }
        };

        // Start the liveness watchdog on the chosen Arc (idempotent). It holds
        // only a Weak<CcProcess>, so it exits cleanly once the registry drops
        // the process (provider switch / model change → recycle_thread_process).
        process.start_watchdog();
        state.chat_runs.lock().await.insert(
            req.thread_id.clone(),
            run::ChatRunHandle::bridge_process("claude-code", process.clone()),
        );

        // 7. Run process with callback to stream
        let assistant_id_clone = assistant_id.clone();
        let app_clone = app.clone();
        let event_name_clone = event_name.clone();
        // Stash the live cwd for this thread so backend-side tools invoked
        // mid-turn (run_captured → B executor) can bridge it (`cd <cwd> && …`);
        // an MCP tool call has no per-turn cwd of its own. Volatile, so refresh
        // every turn.
        if let Some(cwd) = req.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            state
                .cc_thread_cwd
                .lock()
                .unwrap()
                .insert(req.thread_id.clone(), cwd.to_string());
        }

        // Phase 6 — stash the live DB connection id this thread is bound to so
        // the SQL/Redis MCP handlers can resolve their target connection (the
        // runtime `db_connections` key is frontend-generated and not derivable
        // here). Volatile (regenerated on reconnect), so refreshed every turn;
        // cleared when absent so a stale, disconnected id never lingers.
        {
            let conn = req
                .bound_db_connection_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let mut bindings = state.cc_db_bindings.write().await;
            match conn {
                Some(c) => {
                    bindings.insert(req.thread_id.clone(), c.to_string());
                }
                None => {
                    bindings.remove(&req.thread_id);
                }
            }
        }

        // Build the per-turn context prefix CC sees: the live working
        // directory (3.3 — volatile, so injected each turn rather than in the
        // spawn-time identity card) followed by any attached terminal context,
        // mirroring how the native LLM path injects context as a leading user
        // turn. Both are redacted. Without this the CC branch silently dropped
        // fields the frontend already sends.
        let cc_message = {
            let mut prefix = String::new();
            if let Some(cwd) = req.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let (clean_cwd, _) = redact::redact(cwd);
                prefix.push_str(&format!("当前工作目录：{}\n\n", clean_cwd));
            }
            if let Some(ctx) = req
                .terminal_context
                .as_deref()
                .filter(|s| !s.trim().is_empty())
            {
                let (clean_ctx, _) = redact::redact(ctx);
                prefix.push_str(&format!("[Terminal context]\n```\n{}\n```\n\n", clean_ctx));
            }
            prefix.push_str(&render_agent_attachment_prefix(&attachments));
            format!("{}{}", prefix, clean_content)
        };
        let events = process
            .send_with_callback(&cc_message, move |evt| {
                use crate::agent::cc_bridge::protocol::CcEvent;
                match evt {
                    CcEvent::Partial { content } => {
                        let _ = app_clone.emit(
                            &event_name_clone,
                            StreamEventOut::Token {
                                id: assistant_id_clone.clone(),
                                content: content.clone(),
                            },
                        );
                    }
                    // 3.5 — emit a structured, display-only card for tool use. It
                    // carries no machine-parseable payload, so the frontend never
                    // re-executes it (confirmation already happened live via the
                    // MCP permission prompt). The compact text record is persisted
                    // separately below, so reload still shows the activity as text.
                    CcEvent::ToolUse { id, name, input } => {
                        let _ = app_clone.emit(
                            &event_name_clone,
                            StreamEventOut::CcToolActivity {
                                id: assistant_id_clone.clone(),
                                call_id: id.clone(),
                                phase: "use".into(),
                                tool: name.clone(),
                                detail: cc_tool_arg_summary(input).unwrap_or("").to_string(),
                            },
                        );
                    }
                    CcEvent::ToolResult {
                        tool_use_id,
                        content,
                    } => {
                        let _ = app_clone.emit(
                            &event_name_clone,
                            StreamEventOut::CcToolActivity {
                                id: assistant_id_clone.clone(),
                                call_id: tool_use_id.clone(),
                                phase: "result".into(),
                                tool: String::new(),
                                detail: cc_tool_result_preview(content),
                            },
                        );
                    }
                    CcEvent::Done { usage: Some(u) } => {
                        let _ = app_clone.emit(
                            &event_name_clone,
                            StreamEventOut::Usage {
                                id: assistant_id_clone.clone(),
                                input_tokens: u.input_tokens,
                                output_tokens: u.output_tokens,
                                cost_usd: u.total_cost_usd,
                                duration_ms: u.duration_ms,
                            },
                        );
                    }
                    _ => {}
                }
            })
            .await;
        state.chat_runs.lock().await.remove(&req.thread_id);

        let events = match events {
            Ok(ev) => ev,
            Err(e) => {
                let msg = if process.is_stopped() {
                    "Stream stopped by user".to_string()
                } else {
                    e
                };
                emit(&StreamEventOut::Error {
                    id: assistant_id,
                    message: msg,
                });
                return Ok(());
            }
        };

        // 8. Extract final answer and persist. The persisted content keeps a
        // compact *text* transcript of tool activity (history durability); the
        // live structured cards (above) are ephemeral, so on reload the message
        // still shows what CC did, as text.
        let mut final_content = String::new();
        for event in &events {
            use crate::agent::cc_bridge::protocol::CcEvent;
            match event {
                CcEvent::AssistantMessage { content } => {
                    final_content.push_str(content);
                }
                CcEvent::ToolUse { name, input, .. } => {
                    final_content.push_str(&format_cc_tool_use(name, input));
                }
                CcEvent::ToolResult { content, .. } => {
                    let preview = cc_tool_result_preview(content);
                    if !preview.is_empty() {
                        final_content.push_str(&format!("> ↳ {}\n", preview));
                    }
                }
                _ => {}
            }
        }

        let session_id =
            crate::agent::cc_bridge::protocol::extract_session_id(&events).or(resume_session);
        if let Some(sid) = &session_id {
            if let Ok(db) = state.db.lock() {
                let _ = crate::chat::store::set_cc_session_id(&db, &req.thread_id, sid);
            }
        }

        let assistant_msg = store::ChatMessage {
            id: assistant_id.clone(),
            thread_id: req.thread_id.clone(),
            role: "assistant".into(),
            content: final_content.clone(),
            created_at: assistant_ts,
            redacted: false,
            attachments: Vec::new(),
        };

        let is_first = history.is_empty();
        {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
            if is_first {
                let title = user_msg.content.chars().take(40).collect::<String>();
                store::update_thread_title(&db, &req.thread_id, &title)
                    .map_err(|e| e.to_string())?;
            }
        }

        emit(&StreamEventOut::End {
            id: assistant_id,
            thread_id: req.thread_id,
            content: final_content,
            redacted_count,
        });

        return Ok(());
    }

    if thread.provider_id == "codex" {
        let assistant_id = Uuid::new_v4().to_string();
        let assistant_ts = now() + 1;
        emit(&StreamEventOut::AssistantStart {
            id: assistant_id.clone(),
            thread_id: req.thread_id.clone(),
            created_at: assistant_ts,
        });

        let ai_config = AiConfig::load(&default_ai_config_path());
        if !ai_config.codex_bridge.enabled || ai_config.fully_disabled || ai_config.full_local_mode
        {
            emit(&StreamEventOut::Error {
                id: assistant_id,
                message: "Codex is unavailable in full-local / fully-disabled mode or is disabled."
                    .into(),
            });
            return Ok(());
        }

        let binary = if ai_config.codex_bridge.binary == "auto" {
            crate::agent::codex_bridge::find_codex_binary().ok_or("Codex CLI not found")?
        } else {
            ai_config.codex_bridge.binary.clone()
        };
        let resume_session = thread.cc_session_id.clone();
        let runtime = match crate::agent::codex_bridge::config::resolve_custom_runtime(
            &ai_config.codex_bridge,
            &state.vault,
        ) {
            Ok(c) => c,
            Err(e) => {
                emit(&StreamEventOut::Error {
                    id: assistant_id.clone(),
                    message: e,
                });
                return Ok(());
            }
        };

        let existing = {
            state
                .codex_processes
                .lock()
                .await
                .get(&req.thread_id)
                .cloned()
        };
        let process = match existing {
            Some(p) => p,
            None => {
                let flavor = {
                    use crate::agent::cc_bridge::mcp_http::Flavor;
                    let session_type = req
                        .bound_session_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .and_then(|sid| {
                            let db = state.db.lock().ok()?;
                            crate::session::db::get_session(&db, sid).ok()
                        })
                        .map(|sc| sc.session_type);
                    Flavor::for_session_type(session_type.as_ref())
                };

                let (server_url, token) =
                    match crate::agent::cc_bridge::mcp_http::provision_for_thread_with_inline_permission(
                        &app,
                        &req.thread_id,
                        thread.linked_session_id.clone(),
                        req.bound_session_id.clone(),
                        flavor,
                        ai_config.codex_bridge.confirm_readonly,
                        true,
                    )
                    .await
                    {
                        Ok(v) => v,
                        Err(e) => {
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                };
                let control_server_url =
                    match crate::agent::cc_bridge::mcp_http::control_server_url() {
                        Ok(v) => v,
                        Err(e) => {
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                    };

                let thread_config =
                    crate::agent::codex_bridge::config::build_thread_config_from_config(
                        runtime.config.clone(),
                        flavor.server_name(),
                        &server_url,
                        &token,
                        &control_server_url,
                    );

                let output_format = resolve_output_format(&thread, &ai_config);
                let base_instructions = format!(
                    "{}\n\nYou are connected through Codex app-server inside Taomni. Use the domain Taomni MCP tools only for the bound terminal/database session described in the developer instructions. The separate taomni_control MCP server is the UI/session/tab control plane: when the user asks to open or switch to a saved Taomni session, open the session editor, or manage tabs, call taomni_control tools instead of telling the user to do it manually.",
                    build_system_prompt(&output_format)
                );
                let developer_instructions = {
                    let db = state.db.lock().map_err(|e| e.to_string())?;
                    let session = req
                        .bound_session_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .and_then(|sid| crate::session::db::get_session(&db, sid).ok());
                    let recent = session
                        .as_ref()
                        .map(|sc| {
                            crate::history::db_list_recent(
                                &db,
                                &crate::agent::cc_bridge::session_card::host_key_for(sc),
                                crate::agent::cc_bridge::session_card::HISTORY_LIMIT,
                            )
                            .unwrap_or_default()
                        })
                        .unwrap_or_default();
                    let raw = crate::agent::cc_bridge::session_card::render_card(
                        session.as_ref(),
                        &req.thread_id,
                        thread.linked_session_id.is_some(),
                        &recent,
                        req.local_terminal_env.as_ref(),
                    );
                    redact::redact(&raw).0
                };

                let temp_dir =
                    std::env::temp_dir().join(format!(".{}", uuid::Uuid::new_v4().simple()));
                if let Err(e) = std::fs::create_dir_all(&temp_dir) {
                    crate::agent::cc_bridge::mcp_http::revoke_token(&token);
                    emit(&StreamEventOut::Error {
                        id: assistant_id.clone(),
                        message: format!("Failed to create Codex temp dir: {e}"),
                    });
                    return Ok(());
                }

                let model = thread
                    .cc_model
                    .clone()
                    .filter(|m| !m.trim().is_empty())
                    .or_else(|| {
                        if runtime.config.contains_key("model") {
                            None
                        } else {
                            Some(ai_config.codex_bridge.default_model.clone())
                        }
                    });
                let effective_proxy =
                    match crate::agent::codex_bridge::config::resolve_effective_proxy_url(
                        state.inner(),
                        &ai_config.codex_bridge,
                    ) {
                        Ok(proxy) => proxy,
                        Err(e) => {
                            crate::agent::cc_bridge::mcp_http::revoke_token(&token);
                            let _ = std::fs::remove_dir_all(&temp_dir);
                            emit(&StreamEventOut::Error {
                                id: assistant_id.clone(),
                                message: e,
                            });
                            return Ok(());
                        }
                    };
                let p = match crate::agent::codex_bridge::process::CodexAppServer::spawn(
                    &binary,
                    effective_proxy,
                    Some(temp_dir.clone()),
                    Some(token.clone()),
                    Some(runtime.env.clone()),
                    runtime.isolated_home,
                )
                .await
                {
                    Ok(p) => std::sync::Arc::new(p),
                    Err(e) => {
                        crate::agent::cc_bridge::mcp_http::revoke_token(&token);
                        let _ = std::fs::remove_dir_all(&temp_dir);
                        emit(&StreamEventOut::Error {
                            id: assistant_id.clone(),
                            message: e,
                        });
                        return Ok(());
                    }
                };

                if let Err(e) = p
                    .start_or_resume_thread(
                        crate::agent::codex_bridge::process::CodexThreadOptions {
                            resume_thread_id: resume_session.clone(),
                            model,
                            cwd: req.cwd.clone(),
                            approval_policy: ai_config.codex_bridge.approval_policy.clone(),
                            sandbox: ai_config.codex_bridge.sandbox.clone(),
                            network_access: ai_config.codex_bridge.network_access,
                            config: thread_config,
                            base_instructions: Some(base_instructions),
                            developer_instructions: Some(developer_instructions),
                            ephemeral: false,
                        },
                    )
                    .await
                {
                    emit(&StreamEventOut::Error {
                        id: assistant_id.clone(),
                        message: e,
                    });
                    p.stop().await;
                    return Ok(());
                }

                let mut registry = state.codex_processes.lock().await;
                match registry.get(&req.thread_id) {
                    Some(existing) => existing.clone(),
                    None => {
                        registry.insert(req.thread_id.clone(), p.clone());
                        p
                    }
                }
            }
        };

        if let Some(cwd) = req.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            state
                .cc_thread_cwd
                .lock()
                .unwrap()
                .insert(req.thread_id.clone(), cwd.to_string());
        }
        {
            let conn = req
                .bound_db_connection_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let mut bindings = state.cc_db_bindings.write().await;
            match conn {
                Some(c) => {
                    bindings.insert(req.thread_id.clone(), c.to_string());
                }
                None => {
                    bindings.remove(&req.thread_id);
                }
            }
        }

        let codex_message = {
            let mut prefix = String::new();
            if let Some(cwd) = req.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let (clean_cwd, _) = redact::redact(cwd);
                prefix.push_str(&format!("当前工作目录：{}\n\n", clean_cwd));
            }
            if let Some(ctx) = req
                .terminal_context
                .as_deref()
                .filter(|s| !s.trim().is_empty())
            {
                let (clean_ctx, _) = redact::redact(ctx);
                prefix.push_str(&format!("[Terminal context]\n```\n{}\n```\n\n", clean_ctx));
            }
            prefix.push_str(&render_agent_attachment_prefix(&attachments));
            format!("{}{}", prefix, clean_content)
        };

        let assistant_id_clone = assistant_id.clone();
        let app_clone = app.clone();
        let event_name_clone = event_name.clone();
        let model = thread
            .cc_model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .or_else(|| {
                if runtime.config.contains_key("model") {
                    None
                } else {
                    Some(ai_config.codex_bridge.default_model.clone())
                }
            });
        let events = process
            .send_turn_with_callback(
                &codex_message,
                crate::agent::codex_bridge::process::CodexTurnOptions {
                    cwd: req.cwd.clone(),
                    approval_policy: ai_config.codex_bridge.approval_policy.clone(),
                    sandbox: ai_config.codex_bridge.sandbox.clone(),
                    network_access: ai_config.codex_bridge.network_access,
                    model,
                },
                move |evt| {
                    use crate::agent::codex_bridge::protocol::CodexEvent;
                    match evt {
                        CodexEvent::Partial { content } => {
                            let _ = app_clone.emit(
                                &event_name_clone,
                                StreamEventOut::Token {
                                    id: assistant_id_clone.clone(),
                                    content: content.clone(),
                                },
                            );
                        }
                        CodexEvent::ToolUse { id, name, input } => {
                            let _ = app_clone.emit(
                                &event_name_clone,
                                StreamEventOut::CcToolActivity {
                                    id: assistant_id_clone.clone(),
                                    call_id: id.clone(),
                                    phase: "use".into(),
                                    tool: name.clone(),
                                    detail: cc_tool_arg_summary(input).unwrap_or("").to_string(),
                                },
                            );
                        }
                        CodexEvent::ToolResult {
                            tool_use_id,
                            content,
                        } => {
                            let _ = app_clone.emit(
                                &event_name_clone,
                                StreamEventOut::CcToolActivity {
                                    id: assistant_id_clone.clone(),
                                    call_id: tool_use_id.clone(),
                                    phase: "result".into(),
                                    tool: String::new(),
                                    detail: cc_tool_result_preview(content),
                                },
                            );
                        }
                        CodexEvent::Done { usage: Some(u) } => {
                            let _ = app_clone.emit(
                                &event_name_clone,
                                StreamEventOut::Usage {
                                    id: assistant_id_clone.clone(),
                                    input_tokens: u.input_tokens,
                                    output_tokens: u.output_tokens,
                                    cost_usd: None,
                                    duration_ms: u.duration_ms,
                                },
                            );
                        }
                        _ => {}
                    }
                },
            )
            .await;

        let events = match events {
            Ok(ev) => ev,
            Err(e) => {
                let msg = if process.is_stopped() {
                    "Stream stopped by user".to_string()
                } else {
                    e
                };
                emit(&StreamEventOut::Error {
                    id: assistant_id,
                    message: msg,
                });
                return Ok(());
            }
        };

        let mut final_content = String::new();
        for event in &events {
            use crate::agent::codex_bridge::protocol::CodexEvent;
            match event {
                CodexEvent::AssistantMessage { content } => {
                    final_content.push_str(content);
                }
                CodexEvent::ToolUse { name, input, .. } => {
                    final_content.push_str(&format_cc_tool_use(name, input));
                }
                CodexEvent::ToolResult { content, .. } => {
                    let preview = cc_tool_result_preview(content);
                    if !preview.is_empty() {
                        final_content.push_str(&format!("> ↳ {}\n", preview));
                    }
                }
                _ => {}
            }
        }

        let session_id = crate::agent::codex_bridge::protocol::extract_session_id(&events)
            .or_else(|| process.current_thread_id())
            .or(resume_session);
        if let Some(sid) = &session_id {
            if let Ok(db) = state.db.lock() {
                let _ = crate::chat::store::set_cc_session_id(&db, &req.thread_id, sid);
            }
        }

        let assistant_msg = store::ChatMessage {
            id: assistant_id.clone(),
            thread_id: req.thread_id.clone(),
            role: "assistant".into(),
            content: final_content.clone(),
            created_at: assistant_ts,
            redacted: false,
            attachments: Vec::new(),
        };

        let is_first = history.is_empty();
        {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
            if is_first {
                let title = user_msg.content.chars().take(40).collect::<String>();
                store::update_thread_title(&db, &req.thread_id, &title)
                    .map_err(|e| e.to_string())?;
            }
        }

        emit(&StreamEventOut::End {
            id: assistant_id,
            thread_id: req.thread_id,
            content: final_content,
            redacted_count,
        });

        return Ok(());
    }

    // Build the LLM request.
    let ai_config = AiConfig::load(&default_ai_config_path());
    let output_format = resolve_output_format(&thread, &ai_config);
    let system_prompt = build_system_prompt(&output_format);
    let mut llm_messages: Vec<LlmMessage> = vec![LlmMessage::system(system_prompt)];
    if let Some(ctx) = &req.terminal_context {
        let (clean_ctx, _) = redact::redact(ctx);
        llm_messages.push(LlmMessage::user(format!(
            "[Terminal context]\n```\n{}\n```",
            clean_ctx
        )));
        llm_messages.push(LlmMessage::assistant(
            "Acknowledged — I have read the terminal output.",
        ));
    }
    for msg in &history {
        llm_messages.push(LlmMessage {
            role: msg.role.clone(),
            content: crate::llm::ChatContent::text(msg.content.clone()),
        });
    }
    if let Some(attachment_message) = build_llm_attachment_message(&attachments)? {
        llm_messages.push(attachment_message);
    }
    llm_messages.push(LlmMessage::user(clean_content));

    let llm_req = ChatRequest {
        messages: llm_messages,
        max_tokens: Some(1024),
        temperature: Some(0.7),
        stream: true,
    };

    // Allocate the assistant message id and begin streaming.
    let assistant_id = Uuid::new_v4().to_string();
    let assistant_ts = now() + 1;
    emit(&StreamEventOut::AssistantStart {
        id: assistant_id.clone(),
        thread_id: req.thread_id.clone(),
        created_at: assistant_ts,
    });

    // Pull the provider via the router so we don't hold the read lock across
    // the long stream lifetime.
    let stream_result = {
        let ai_ctx = state.ai_ctx.read().await;
        let pinned = ai_ctx.llm.provider(&thread.provider_id);
        let pinned_blocked = pinned.is_none() && ai_ctx.llm.needs_vault_unlock(&thread.provider_id);

        let provider = pinned.or_else(|| {
            // Don't fall back when the pinned provider is just locked — the
            // user wants that specific provider, and we should prompt for
            // unlock rather than silently rerouting.
            if pinned_blocked {
                None
            } else {
                ai_ctx
                    .llm
                    .provider(&ai_ctx.llm.provider_for_task(TaskKind::ChatDrawer))
            }
        });
        match provider {
            Some(p) => p.chat_stream(llm_req).await,
            None => {
                if pinned_blocked {
                    Err(crate::llm::LlmError::VaultLocked {
                        provider: thread.provider_id.clone(),
                    })
                } else {
                    Err(crate::llm::LlmError::Provider {
                        status: 0,
                        message: "No provider available".into(),
                    })
                }
            }
        }
    };

    let mut stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            emit(&StreamEventOut::Error {
                id: assistant_id,
                message: e.to_string(),
            });
            return Ok(());
        }
    };

    // Create a provider-agnostic cancellation handle for this in-flight turn.
    let cancel_token = tokio_util::sync::CancellationToken::new();
    state.chat_runs.lock().await.insert(
        req.thread_id.clone(),
        run::ChatRunHandle::direct_llm(cancel_token.clone()),
    );

    let mut accumulated = String::new();
    let mut is_cancelled = false;
    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                is_cancelled = true;
                break;
            }
            evt_opt = stream.next() => {
                match evt_opt {
                    Some(evt) => {
                        match evt {
                            Ok(ChatStreamEvent::Token { content }) => {
                                accumulated.push_str(&content);
                                emit(&StreamEventOut::Token {
                                    id: assistant_id.clone(),
                                    content,
                                });
                            }
                            Ok(ChatStreamEvent::End { .. }) => break,
                            Ok(ChatStreamEvent::Error { message }) => {
                                emit(&StreamEventOut::Error {
                                    id: assistant_id,
                                    message,
                                });
                                state.chat_runs.lock().await.remove(&req.thread_id);
                                return Ok(());
                            }
                            Err(e) => {
                                emit(&StreamEventOut::Error {
                                    id: assistant_id,
                                    message: e.to_string(),
                                });
                                state.chat_runs.lock().await.remove(&req.thread_id);
                                return Ok(());
                            }
                        }
                    }
                    None => break,
                }
            }
        }
    }

    state.chat_runs.lock().await.remove(&req.thread_id);

    if is_cancelled {
        emit(&StreamEventOut::Error {
            id: assistant_id,
            message: "Stream stopped by user".into(),
        });
        return Ok(());
    }

    // Persist the assistant message and auto-title on first turn.
    let assistant_msg = store::ChatMessage {
        id: assistant_id.clone(),
        thread_id: req.thread_id.clone(),
        role: "assistant".into(),
        content: accumulated.clone(),
        created_at: assistant_ts,
        redacted: false,
        attachments: Vec::new(),
    };

    let is_first = history.is_empty();
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
        if is_first {
            let title = user_msg.content.chars().take(40).collect::<String>();
            store::update_thread_title(&db, &req.thread_id, &title).map_err(|e| e.to_string())?;
        }
    }

    emit(&StreamEventOut::End {
        id: assistant_id,
        thread_id: req.thread_id,
        content: accumulated,
        redacted_count,
    });

    Ok(())
}

#[cfg(test)]
mod cc_tool_use_tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn renders_command_without_tool_call_marker() {
        let line = format_cc_tool_use("run_in_terminal", &json!({ "command": "ls -la" }));
        assert!(line.contains("run_in_terminal"));
        assert!(line.contains("ls -la"));
        // Must NOT be a parseable marker (would trigger native re-execution).
        assert!(!line.contains("[TOOL_CALL]"));
    }

    #[test]
    fn renders_file_path_and_bare_tool() {
        let edit = format_cc_tool_use("Edit", &json!({ "file_path": "/tmp/x.rs" }));
        assert!(edit.contains("/tmp/x.rs"));
        assert!(!edit.contains("[TOOL_CALL]"));
        let bare = format_cc_tool_use("list_sessions", &json!({}));
        assert!(bare.contains("list_sessions"));
        assert!(!bare.contains("[TOOL_CALL]"));
    }

    #[test]
    fn cloud_attachment_message_omits_local_path_but_includes_text_preview() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        std::fs::write(&path, "hello from attachment").unwrap();
        let att = stat_attachment_path(path.to_str().unwrap(), None).unwrap();

        let message = build_llm_attachment_message(&[att.clone()])
            .unwrap()
            .unwrap();
        let text = message.content.as_text_lossy();

        assert!(text.contains("notes.txt"));
        assert!(text.contains("hello from attachment"));
        assert!(!text.contains(&att.path));
    }

    #[test]
    fn agent_attachment_prefix_includes_readable_path() {
        let att = store::ChatAttachment {
            id: "a1".into(),
            kind: "file".into(),
            path: "/tmp/notes.txt".into(),
            name: "notes.txt".into(),
            size: 12,
            mime: Some("text/plain".into()),
        };

        let prefix = render_agent_attachment_prefix(&[att]);

        assert!(prefix.contains("notes.txt"));
        assert!(prefix.contains("path: /tmp/notes.txt"));
    }

    #[test]
    fn validates_attachment_count_and_total_size() {
        let oversized = store::ChatAttachment {
            id: "a1".into(),
            kind: "file".into(),
            path: "/tmp/large.bin".into(),
            name: "large.bin".into(),
            size: CHAT_MAX_ATTACHMENT_BYTES + 1,
            mime: Some("application/octet-stream".into()),
        };
        assert!(validate_attachment_limits(&[oversized]).is_err());

        let many: Vec<_> = (0..=CHAT_MAX_ATTACHMENTS)
            .map(|i| store::ChatAttachment {
                id: format!("a{i}"),
                kind: "file".into(),
                path: format!("/tmp/{i}.txt"),
                name: format!("{i}.txt"),
                size: 1,
                mime: Some("text/plain".into()),
            })
            .collect();
        assert!(validate_attachment_limits(&many).is_err());
    }

    #[test]
    fn image_attachment_message_contains_multimodal_part() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pixel.png");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(&[137, 80, 78, 71]).unwrap();
        let att = stat_attachment_path(path.to_str().unwrap(), None).unwrap();

        let message = build_llm_attachment_message(&[att]).unwrap().unwrap();
        match message.content {
            crate::llm::ChatContent::Parts(parts) => {
                assert!(parts.iter().any(|part| matches!(
                    part,
                    ChatContentPart::Image {
                        mime_type,
                        data_base64
                    } if mime_type == "image/png" && !data_base64.is_empty()
                )));
            }
            _ => panic!("expected multimodal content parts"),
        }
    }

    #[test]
    fn decodes_base64_image_data_uri() {
        let data = "data:image/png;base64,iVBORw0KGgo=";
        let (bytes, mime) = decode_base64_image(data).unwrap();

        assert_eq!(mime, "image/png");
        assert_eq!(bytes, vec![137, 80, 78, 71, 13, 10, 26, 10]);
    }

    #[test]
    fn validates_video_num_frames_rule() {
        assert_eq!(validate_video_num_frames(121).unwrap(), 121);
        assert!(validate_video_num_frames(120).is_err());
        assert!(validate_video_num_frames(442).is_err());
    }
}
