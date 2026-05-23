// SFTP upload tool — frontend-driven (the actual transfer happens through
// the existing filebrowser SFTP commands). The tool emits an event that the
// frontend listens for and shows in an ActionCard before executing.

use super::{Tool, ToolDescriptor, ToolResult};
use async_trait::async_trait;
use tauri::Emitter;

pub struct SftpUploadTool {
    pub app: tauri::AppHandle,
}

#[async_trait]
impl Tool for SftpUploadTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "sftp_upload",
            description: "Upload a local file to a remote path via the SFTP session. dry_run=true returns the plan without uploading.",
            params: "session_id: string, local_path: string, remote_path: string, dry_run?: bool",
        }
    }

    fn dry_run_preview(&self, args: &serde_json::Value) -> Option<String> {
        let local = args.get("local_path").and_then(|v| v.as_str()).unwrap_or("?");
        let remote = args.get("remote_path").and_then(|v| v.as_str()).unwrap_or("?");
        Some(format!("Upload {local} → {remote}"))
    }

    async fn execute(&self, args: &serde_json::Value) -> ToolResult {
        let dry_run = args.get("dry_run").and_then(|v| v.as_bool()).unwrap_or(true);
        let local = args.get("local_path").and_then(|v| v.as_str()).unwrap_or("");
        let remote = args.get("remote_path").and_then(|v| v.as_str()).unwrap_or("");

        if local.is_empty() || remote.is_empty() {
            return ToolResult::err("sftp_upload", "local_path and remote_path required");
        }

        if dry_run {
            return ToolResult::ok(
                "sftp_upload",
                format!("[dry-run] Would upload {local} → {remote}"),
            );
        }

        // Emit a request event for the frontend to perform via the existing
        // sftp_upload_bytes / sftp_upload command after a confirmation card.
        let _ = self.app.emit("agent-sftp-upload", args);
        ToolResult::ok("sftp_upload", "Upload requested via SFTP frontend")
    }
}

/// Bundle a sequence of recently-executed commands into a Runbook for reuse.
pub struct SaveAsRunbookTool {
    pub app: tauri::AppHandle,
}

#[async_trait]
impl Tool for SaveAsRunbookTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "save_as_runbook",
            description: "把最近执行过的若干条命令保存为可复用 runbook。",
            params: "session_id: string, last_n_commands: u32, name: string",
        }
    }

    fn dry_run_preview(&self, args: &serde_json::Value) -> Option<String> {
        let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("?");
        let n = args.get("last_n_commands").and_then(|v| v.as_u64()).unwrap_or(0);
        Some(format!("Save last {n} commands as runbook '{name}'"))
    }

    async fn execute(&self, args: &serde_json::Value) -> ToolResult {
        let _ = self.app.emit("agent-save-runbook", args);
        ToolResult::ok("save_as_runbook", "Runbook save request emitted")
    }
}
