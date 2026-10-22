use super::*;

impl LspClientRequestBridge {
    pub(super) fn new() -> Self {
        Self {
            app: OnceLock::new(),
            pending_workspace_edits: StdMutex::new(HashMap::new()),
            pending_show_messages: StdMutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
        }
    }

    pub(super) fn attach_app(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    pub(super) async fn apply_workspace_edit(
        &self,
        workspace_id: &str,
        label: Option<String>,
        edit: LspWorkspaceEdit,
    ) -> LspWorkspaceApplyEditResponse {
        let Some(app) = self.app.get().cloned() else {
            return LspWorkspaceApplyEditResponse::failed(
                "Code Workspace frontend is unavailable to apply the edit",
            );
        };
        let request_id = format!(
            "{}:{}",
            workspace_id,
            self.next_request_id.fetch_add(1, Ordering::SeqCst)
        );
        let (sender, receiver) = oneshot::channel();
        self.pending_workspace_edits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                request_id.clone(),
                PendingWorkspaceApplyEdit {
                    workspace_id: workspace_id.to_string(),
                    sender,
                },
            );
        let payload = LspWorkspaceApplyEditRequest {
            request_id: request_id.clone(),
            workspace_id: workspace_id.to_string(),
            label,
            edit,
        };
        if let Err(error) = app.emit(WORKSPACE_APPLY_EDIT_EVENT, payload) {
            self.pending_workspace_edits
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&request_id);
            return LspWorkspaceApplyEditResponse::failed(format!(
                "Cannot dispatch WorkspaceEdit to the editor: {error}"
            ));
        }
        match tokio::time::timeout(
            Duration::from_secs(WORKSPACE_APPLY_EDIT_TIMEOUT_SECS),
            receiver,
        )
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => LspWorkspaceApplyEditResponse::failed(
                "Code Workspace closed before applying the edit",
            ),
            Err(_) => {
                self.pending_workspace_edits
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&request_id);
                LspWorkspaceApplyEditResponse::failed("WorkspaceEdit application timed out")
            }
        }
    }

    pub(super) fn resolve_workspace_edit(
        &self,
        request_id: &str,
        workspace_id: &str,
        response: LspWorkspaceApplyEditResponse,
    ) -> Result<(), String> {
        let mut pending = self
            .pending_workspace_edits
            .lock()
            .map_err(|error| error.to_string())?;
        let Some(entry) = pending.remove(request_id) else {
            return Err(format!(
                "no pending LSP WorkspaceEdit request '{request_id}'"
            ));
        };
        if entry.workspace_id != workspace_id {
            pending.insert(request_id.to_string(), entry);
            return Err("WorkspaceEdit response does not match the target workspace".into());
        }
        let _ = entry.sender.send(response);
        Ok(())
    }

    pub(super) fn start_show_message_request(
        &self,
        workspace_id: &str,
        server_label: &str,
        message_type: u32,
        message: String,
        actions: Vec<Value>,
    ) -> Result<(String, oneshot::Receiver<Option<Value>>), String> {
        let app = self.app.get().cloned().ok_or_else(|| {
            "Code Workspace frontend is unavailable to show the message".to_string()
        })?;
        let request_id = format!(
            "{}:message:{}",
            workspace_id,
            self.next_request_id.fetch_add(1, Ordering::SeqCst)
        );
        let (sender, receiver) = oneshot::channel();
        self.pending_show_messages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                request_id.clone(),
                PendingShowMessageRequest {
                    workspace_id: workspace_id.to_string(),
                    actions: actions.clone(),
                    sender,
                },
            );
        let payload = LspShowMessageRequestEvent {
            request_id: request_id.clone(),
            workspace_id: workspace_id.to_string(),
            server_label: server_label.to_string(),
            message_type,
            message,
            actions,
        };
        if let Err(error) = app.emit(SHOW_MESSAGE_REQUEST_EVENT, payload) {
            self.pending_show_messages
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&request_id);
            return Err(format!(
                "Cannot dispatch language server message to the editor: {error}"
            ));
        }
        Ok((request_id, receiver))
    }

    pub(super) async fn wait_for_show_message(
        &self,
        request_id: &str,
        receiver: oneshot::Receiver<Option<Value>>,
    ) -> Result<Option<Value>, String> {
        match tokio::time::timeout(
            Duration::from_secs(SHOW_MESSAGE_REQUEST_TIMEOUT_SECS),
            receiver,
        )
        .await
        {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err("Language server message request was cancelled".into()),
            Err(_) => {
                self.cancel_show_message(request_id, "Message request timed out");
                Err("Language server message request timed out waiting for user input".into())
            }
        }
    }

    pub(super) fn resolve_show_message(
        &self,
        request_id: &str,
        workspace_id: &str,
        action_index: Option<u32>,
    ) -> Result<(), String> {
        let mut pending = self
            .pending_show_messages
            .lock()
            .map_err(|error| error.to_string())?;
        let Some(entry) = pending.remove(request_id) else {
            return Err(format!("no pending LSP message request '{request_id}'"));
        };
        if entry.workspace_id != workspace_id {
            pending.insert(request_id.to_string(), entry);
            return Err(
                "Language server message response does not match the target workspace".into(),
            );
        }
        let selected = match action_index {
            Some(index) => match entry.actions.get(index as usize).cloned() {
                Some(action) => Some(action),
                None => {
                    pending.insert(request_id.to_string(), entry);
                    return Err(format!(
                        "Language server message action {index} is out of range"
                    ));
                }
            },
            None => None,
        };
        let _ = entry.sender.send(selected);
        Ok(())
    }

    pub(super) fn cancel_show_message(&self, request_id: &str, reason: &str) -> bool {
        let entry = self
            .pending_show_messages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(request_id);
        let Some(entry) = entry else {
            return false;
        };
        if let Some(app) = self.app.get() {
            let _ = app.emit(
                SHOW_MESSAGE_CANCELLED_EVENT,
                LspShowMessageCancelledEvent {
                    request_id: request_id.to_string(),
                    workspace_id: entry.workspace_id,
                    reason: reason.to_string(),
                },
            );
        }
        true
    }

    pub(super) fn emit_show_message(&self, payload: LspShowMessageEvent) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(SHOW_MESSAGE_EVENT, payload);
        }
    }

    pub(super) fn emit_work_done_progress(&self, payload: LspWorkDoneProgressEvent) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(WORK_DONE_PROGRESS_EVENT, payload);
        }
    }

    pub(super) fn emit_diagnostics_refresh(&self, payload: LspDiagnosticsRefreshEvent) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(DIAGNOSTICS_REFRESH_EVENT, payload);
        }
    }

    pub(super) fn emit_external_file_change(&self, payload: LspExternalFileChangeEvent) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(EXTERNAL_FILE_CHANGE_EVENT, payload);
        }
    }
}

pub(super) struct ParsedShowMessage {
    pub(super) message_type: u32,
    pub(super) message: String,
    pub(super) actions: Vec<Value>,
}

pub(super) fn parse_show_message_request(params: Option<&Value>) -> Option<ParsedShowMessage> {
    let params = params?;
    let message_type = params.get("type").and_then(Value::as_u64)?;
    if !(1..=4).contains(&message_type) {
        return None;
    }
    let message = params.get("message").and_then(Value::as_str)?.to_string();
    let actions = match params.get("actions") {
        None => Vec::new(),
        Some(Value::Array(actions)) => actions
            .iter()
            .filter(|action| action.get("title").and_then(Value::as_str).is_some())
            .cloned()
            .collect(),
        Some(_) => return None,
    };
    if params
        .get("actions")
        .and_then(Value::as_array)
        .is_some_and(|items| items.len() != actions.len())
    {
        return None;
    }
    Some(ParsedShowMessage {
        message_type: message_type as u32,
        message,
        actions,
    })
}

pub(super) fn language_status_is_service_ready(params: Option<&Value>) -> bool {
    params
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .is_some_and(|status| status == "ServiceReady")
}

pub(super) fn parse_show_message_notification(params: Option<&Value>) -> Option<ParsedShowMessage> {
    let mut parsed = parse_show_message_request(params)?;
    parsed.actions.clear();
    Some(parsed)
}

pub(super) fn is_progress_token(value: &Value) -> bool {
    value.is_string() || value.as_i64().is_some() || value.as_u64().is_some()
}

pub(super) fn progress_token_key(value: &Value) -> String {
    match value {
        Value::String(value) => format!("s:{value}"),
        Value::Number(value) => format!("n:{value}"),
        _ => value.to_string(),
    }
}

pub(super) fn progress_message(value: &Value) -> Option<String> {
    value
        .get("message")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

pub(super) fn progress_percentage(value: &Value) -> Option<u32> {
    value
        .get("percentage")
        .and_then(Value::as_u64)
        .map(|percentage| percentage.min(100) as u32)
}

pub(super) fn json_rpc_id_key(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(format!("s:{value}")),
        Value::Number(value) => Some(format!("n:{value}")),
        _ => None,
    }
}

pub(super) fn configuration_section_value(configuration: &Value, section: Option<&str>) -> Value {
    let Some(section) = section.map(str::trim).filter(|section| !section.is_empty()) else {
        return configuration.clone();
    };
    let mut current = configuration;
    for part in section.split('.') {
        let Some(next) = current.get(part) else {
            return Value::Null;
        };
        current = next;
    }
    current.clone()
}

pub(super) fn merge_json_value(target: &mut Value, patch: &Value) {
    if let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            match target.get_mut(key) {
                Some(existing) => merge_json_value(existing, value),
                None => {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
        return;
    }
    *target = patch.clone();
}
