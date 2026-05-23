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

