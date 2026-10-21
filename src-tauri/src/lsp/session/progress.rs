use crate::lsp::LspSession;
use crate::lsp::LspWorkDoneProgressEvent;
use crate::lsp::WorkDoneProgressState;
use crate::lsp::client_requests::is_progress_token;
use crate::lsp::client_requests::progress_message;
use crate::lsp::client_requests::progress_percentage;
use crate::lsp::client_requests::progress_token_key;
use serde_json::Value;
use serde_json::json;

impl LspSession {
    pub(in crate::lsp) async fn register_work_done_progress(
        &self,
        params: Option<&Value>,
    ) -> Result<Value, String> {
        let token = params
            .and_then(|value| value.get("token"))
            .filter(|token| is_progress_token(token))
            .cloned()
            .ok_or_else(|| {
                "window/workDoneProgress/create requires a string or integer token".to_string()
            })?;
        let key = progress_token_key(&token);
        let mut progress = self.work_done_progress.write().await;
        if progress.contains_key(&key) {
            return Err(format!(
                "work-done progress token '{key}' is already registered"
            ));
        }
        progress.insert(
            key,
            WorkDoneProgressState {
                token,
                cancellable: false,
                title: None,
            },
        );
        Ok(Value::Null)
    }

    pub(in crate::lsp) async fn handle_progress_notification(&self, params: Option<&Value>) {
        let Some(params) = params else {
            return;
        };
        let Some(token) = params
            .get("token")
            .filter(|token| is_progress_token(token))
            .cloned()
        else {
            return;
        };
        let Some(value) = params.get("value") else {
            return;
        };
        let key = progress_token_key(&token);
        if let Some(items) = value.get("items").and_then(Value::as_array) {
            let mut partial_results = self.diagnostic_partial_results.lock().await;
            if let Some(collected) = partial_results.get_mut(&key) {
                collected.extend(items.iter().cloned());
                return;
            }
        }
        let Some(kind) = value.get("kind").and_then(Value::as_str) else {
            return;
        };
        if !matches!(kind, "begin" | "report" | "end") {
            return;
        }
        let mut progress = self.work_done_progress.write().await;
        let (title, message, percentage, cancellable) = match kind {
            "begin" => {
                let title = value
                    .get("title")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                let cancellable = value
                    .get("cancellable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                progress.insert(
                    key.clone(),
                    WorkDoneProgressState {
                        token: token.clone(),
                        cancellable,
                        title: title.clone(),
                    },
                );
                (
                    title,
                    progress_message(value),
                    progress_percentage(value),
                    cancellable,
                )
            }
            "report" => {
                let state = progress
                    .entry(key.clone())
                    .or_insert_with(|| WorkDoneProgressState {
                        token: token.clone(),
                        cancellable: false,
                        title: None,
                    });
                if let Some(cancellable_value) = value.get("cancellable").and_then(Value::as_bool) {
                    state.cancellable = cancellable_value;
                }
                let title = state.title.clone();
                (
                    title,
                    progress_message(value),
                    progress_percentage(value),
                    state.cancellable,
                )
            }
            "end" => {
                let state = progress.remove(&key);
                (
                    state.as_ref().and_then(|state| state.title.clone()),
                    progress_message(value),
                    progress_percentage(value),
                    state
                        .as_ref()
                        .map(|state| state.cancellable)
                        .unwrap_or(false),
                )
            }
            _ => return,
        };
        drop(progress);
        self.client_bridge
            .emit_work_done_progress(LspWorkDoneProgressEvent {
                workspace_id: self.key.workspace_id.clone(),
                preset_id: self.key.preset_id.clone(),
                server_label: self.preset.display_name.clone(),
                root_uri: self.root_uri.clone(),
                token,
                kind: kind.to_string(),
                title,
                message,
                percentage,
                cancellable,
            });
    }

    pub(in crate::lsp) async fn cancel_work_done_progress(
        &self,
        token: &Value,
    ) -> Result<bool, String> {
        let key = progress_token_key(token);
        let mut progress = self.work_done_progress.write().await;
        let Some(state) = progress.get_mut(&key) else {
            return Ok(false);
        };
        if !state.cancellable {
            return Ok(false);
        }
        state.cancellable = false;
        let token = state.token.clone();
        drop(progress);
        self.notify("window/workDoneProgress/cancel", json!({ "token": token }))
            .await?;
        Ok(true)
    }
}
