use super::{Tool, ToolDescriptor, ToolResult};
use async_trait::async_trait;
use rusqlite::Connection;
use std::sync::{Arc, Mutex};

pub struct SearchHistoryTool {
    pub db: Arc<Mutex<Connection>>,
}

#[async_trait]
impl Tool for SearchHistoryTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "search_history",
            description: "搜索命令历史记录并返回匹配的命令列表",
            params: "query: string",
        }
    }

    async fn execute(&self, args: &serde_json::Value) -> ToolResult {
        let query = match args.get("query").and_then(|v| v.as_str()) {
            Some(q) => q.to_string(),
            None => return ToolResult::err("search_history", "query is required"),
        };
        let db = self.db.lock().unwrap();
        match crate::history::db_search(&db, &query, 20) {
            Ok(results) => ToolResult::ok("search_history", results.join("\n")),
            Err(e) => ToolResult::err("search_history", e.to_string()),
        }
    }
}
