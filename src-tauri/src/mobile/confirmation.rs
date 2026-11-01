//! Native frontend side-effect gates are visible to mobile but remain desktop-only.
use super::MobileRuntime;
use serde_json::json;
use std::sync::Arc;
pub struct DesktopConfirmation {
    runtime: Arc<MobileRuntime>,
    id: String,
    thread: String,
}
impl DesktopConfirmation {
    pub fn new(runtime: &Arc<MobileRuntime>, id: &str, thread: &str, tool: &str) -> Self {
        runtime
            .confirmations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id.into(),
                json!({"id":id,"thread_id":thread,"tool":tool,"supported":false}),
            );
        runtime.task_status(
            thread,
            "awaiting_confirmation",
            "desktop_confirmation_required",
        );
        Self {
            runtime: runtime.clone(),
            id: id.into(),
            thread: thread.into(),
        }
    }
}
impl Drop for DesktopConfirmation {
    fn drop(&mut self) {
        self.runtime
            .confirmations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
        self.runtime
            .task_status(&self.thread, "running", "desktop_confirmation_resolved");
    }
}
