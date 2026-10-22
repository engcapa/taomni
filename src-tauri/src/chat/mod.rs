mod attachments;
pub use attachments::*;
mod thread_commands;
pub use thread_commands::*;
mod media;
pub use media::*;
mod stream;
pub use stream::*;
mod presentation;
use presentation::*;
mod context;
use context::*;

mod acp;
pub mod inline_qq;
pub mod redact;
pub mod run;
pub mod store;

use crate::ai::config::{AiConfig, default_ai_config_path};
use crate::llm::router::provider_group_id_from_route;
use crate::llm::{
    ChatContentPart, ChatMessage as LlmMessage, ChatRequest, ChatStreamEvent, ChatTool,
    ChatToolCall, Llm, TaskKind,
};
use crate::state::AppState;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
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
    /// it is bridged *per turn* and stored into `AppState.agent_db_bindings` so the
    /// DB MCP handlers can resolve their bound connection. `None` for non-DB
    /// threads or a DB tab that isn't connected.
    #[serde(default)]
    pub bound_db_connection_id: Option<String>,
    /// Current objects selected in the bound DB tab's object tree. Bridged per
    /// turn so SQL MCP tools can answer prompts containing "selected tables".
    #[serde(default)]
    pub bound_db_selected_objects: Vec<crate::agent::context::AgentDbSelectedObject>,
    /// Backward-compatible single-table field accepted from older frontends.
    #[serde(default)]
    pub bound_db_selected_table: Option<crate::agent::context::AgentDbSelectedObject>,
    /// Current code-workspace editor context for local repo agent turns.
    #[serde(default)]
    pub code_workspace: Option<crate::agent::context::AgentCodeWorkspace>,
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
    /// Reference attachments for providers that support image-guided media
    /// generation. The Grok CLI adapter receives image attachments as local
    /// ACP resource links.
    #[serde(default)]
    pub attachments: Vec<store::ChatAttachment>,
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

/// Preferred scalar keys when summarizing a tool call for the chat transcript.
/// Ordered by usefulness for humans scanning a collapsed tool card.
const TOOL_ARG_SUMMARY_KEYS: &[&str] = &[
    "command",
    "cmd",
    "query",
    "pattern",
    "file_path",
    "target_file",
    "notebook_path",
    "path",
    "url",
    "uri",
    "prompt",
    "description",
    "glob",
    "directory",
    "cwd",
    "working_directory",
    "name",
    "tool",
    "tool_name",
    "toolName",
    "server",
    "server_name",
    "message",
    "content",
    "old_string",
    "new_string",
    "text",
    "search",
    "replace",
];

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
    fn summarizes_query_and_nested_tool_args() {
        let search =
            format_cc_tool_use("search_tool", &json!({ "query": "welcome recent folders" }));
        assert!(search.contains("search_tool"));
        assert!(search.contains("welcome recent folders"));

        let nested = format_cc_tool_use(
            "use_tool",
            &json!({
                "tool_name": "web_search",
                "arguments": { "query": "taomni acp" },
            }),
        );
        assert!(nested.contains("web_search"));
        assert!(nested.contains("taomni acp"));

        // Secrets must never appear in the transcript summary.
        let secret = format_cc_tool_use(
            "auth",
            &json!({ "token": "super-secret", "path": "/tmp/ok" }),
        );
        assert!(secret.contains("/tmp/ok"));
        assert!(!secret.contains("super-secret"));
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
            preview_url: None,
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
            preview_url: None,
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
                preview_url: None,
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
    fn clipboard_rgba_image_becomes_pasted_image_attachment() {
        let rgba = [255_u8, 0, 0, 255];
        let att = clipboard_image_attachment_from_rgba(1, 1, &rgba).unwrap();

        assert_eq!(att.kind, "image");
        assert_eq!(att.name, "Pasted image");
        assert_eq!(att.mime.as_deref(), Some("image/png"));
        assert!(att.path.ends_with(".png"));
        assert!(std::path::Path::new(&att.path).exists());

        let _ = std::fs::remove_file(&att.path);
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
