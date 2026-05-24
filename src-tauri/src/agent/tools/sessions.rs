use super::{Tool, ToolDescriptor, ToolResult};
use async_trait::async_trait;
use rusqlite::Connection;
use std::sync::{Arc, Mutex};

/// List all saved SSH/terminal sessions.
pub struct ListSessionsTool {
    pub db: Arc<Mutex<Connection>>,
}

#[async_trait]
impl Tool for ListSessionsTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "list_sessions",
            description: "列出所有已保存的 SSH/终端会话",
            params: "query?: string",
        }
    }

    async fn execute(&self, args: &serde_json::Value) -> ToolResult {
        let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        let db = self.db.lock().unwrap();
        match crate::session::db::list_sessions(&db, None) {
            Ok(sessions) => {
                let filtered: Vec<_> = sessions.iter()
                    .filter(|s| query.is_empty() || s.name.to_lowercase().contains(&query) || s.host.to_lowercase().contains(&query))
                    .map(|s| format!("{}: {} ({}@{}:{})", s.id, s.name, s.username.as_deref().unwrap_or(""), s.host, s.port))
                    .collect();
                ToolResult::ok("list_sessions", filtered.join("\n"))
            }
            Err(e) => ToolResult::err("list_sessions", e.to_string()),
        }
    }
}

/// Switch to a session/tab by name or id. The actual UI side-effect is
/// emitted as an event the frontend listens for; the tool returns the chosen
/// session id so the agent can confirm.
pub struct SwitchTabTool {
    pub app: tauri::AppHandle,
    pub db: Arc<Mutex<Connection>>,
}

#[async_trait]
impl Tool for SwitchTabTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "switch_tab",
            description: "切换到指定会话/标签。query 可以是会话 id、名称或主机片段。",
            params: "query: string",
        }
    }

    fn dry_run_preview(&self, args: &serde_json::Value) -> Option<String> {
        let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
        Some(format!("切换到会话: {q}"))
    }

    async fn execute(&self, args: &serde_json::Value) -> ToolResult {
        use tauri::Emitter;
        let query = match args.get("query").and_then(|v| v.as_str()) {
            Some(q) => q.to_string(),
            None => return ToolResult::err("switch_tab", "query is required"),
        };

        // Find a matching session.
        let db = self.db.lock().unwrap();
        let sessions = match crate::session::db::list_sessions(&db, None) {
            Ok(s) => s,
            Err(e) => return ToolResult::err("switch_tab", e.to_string()),
        };
        drop(db);

        let q = query.to_lowercase();
        let chosen = sessions.iter().find(|s| {
            s.id == query
                || s.name.to_lowercase().contains(&q)
                || s.host.to_lowercase().contains(&q)
        });

        match chosen {
            Some(s) => {
                let _ = self.app.emit("agent-switch-tab", serde_json::json!({
                    "session_id": s.id,
                    "name": s.name,
                }));
                ToolResult::ok("switch_tab", format!("Requested switch to '{}' ({})", s.name, s.id))
            }
            None => ToolResult::err("switch_tab", format!("No session matched '{query}'")),
        }
    }
}

/// Open the new-session editor with optional pre-filled fields.
pub struct OpenSessionEditorTool {
    pub app: tauri::AppHandle,
}

#[async_trait]
impl Tool for OpenSessionEditorTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "open_session_editor",
            description: "打开新会话编辑器，可预填 name/host/username。",
            params: "name?: string, host?: string, username?: string",
        }
    }

    fn dry_run_preview(&self, args: &serde_json::Value) -> Option<String> {
        Some(format!("Open new-session editor with: {}", args))
    }

    async fn execute(&self, args: &serde_json::Value) -> ToolResult {
        use tauri::Emitter;
        let _ = self.app.emit("agent-open-session-editor", args);
        ToolResult::ok("open_session_editor", "Editor opened")
    }
}
