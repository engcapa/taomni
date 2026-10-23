use crate::lsp::JSON_RPC_INTERNAL_ERROR;
use crate::lsp::JSON_RPC_INVALID_PARAMS;
use crate::lsp::JSON_RPC_METHOD_NOT_FOUND;
use crate::lsp::LSP_REQUEST_CANCELLED;
use crate::lsp::LspDiagnosticsRefreshEvent;
use crate::lsp::LspSession;
use crate::lsp::LspShowMessageEvent;
use crate::lsp::capabilities::parse_dynamic_capability_registrations_checked;
use crate::lsp::capabilities::parse_dynamic_capability_unregistrations_checked;
use crate::lsp::client_requests::json_rpc_id_key;
use crate::lsp::client_requests::language_status_is_service_ready;
use crate::lsp::client_requests::parse_show_message_notification;
use crate::lsp::client_requests::parse_show_message_request;
use crate::lsp::diagnostics;
use crate::lsp::diagnostics::parse_diagnostic;
use crate::lsp::diagnostics::store_diagnostics;
use crate::lsp::java_runtime::command_is_jdtls;
use crate::lsp::protocol::response_error_details;
use crate::lsp::protocol::response_error_message;
use crate::lsp::session;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::Ordering;

impl LspSession {
    pub(in crate::lsp) async fn handle_message(self: &Arc<Self>, message: Value) {
        if let Some(response_id) = message.get("id").cloned() {
            // Response to one of our requests.
            if message.get("method").is_none() {
                let pending_id = response_id
                    .as_u64()
                    .or_else(|| response_id.as_str().and_then(|id| id.parse::<u64>().ok()));
                let pending = if let Some(id) = pending_id {
                    self.pending.lock().await.remove(&id)
                } else {
                    None
                };
                if let Some(pending) = pending {
                    let response = if let Some(error) = message.get("error") {
                        log::warn!(
                            "lsp:{}: request {response_id} failed: {}",
                            self.command.command,
                            response_error_details(error)
                        );
                        Err(response_error_message(
                            error,
                            command_is_jdtls(&self.command),
                        ))
                    } else {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = pending.sender.send(response);
                }
                return;
            }

            let method = message.get("method").and_then(Value::as_str).unwrap_or("");
            let params = message.get("params").cloned();
            match method {
                "workspace/applyEdit" => {
                    let session = Arc::clone(self);
                    tokio::spawn(async move {
                        let result = session.apply_server_workspace_edit(params.as_ref()).await;
                        session.send_server_result(response_id, result).await;
                    });
                }
                "window/showMessageRequest" => {
                    let Some(request) = parse_show_message_request(params.as_ref()) else {
                        self.send_server_error(
                            response_id,
                            JSON_RPC_INVALID_PARAMS,
                            "window/showMessageRequest has invalid params",
                        )
                        .await;
                        return;
                    };
                    let Some(server_id) = json_rpc_id_key(&response_id) else {
                        self.send_server_error(
                            response_id,
                            -32600,
                            "Server request id must be a string or number",
                        )
                        .await;
                        return;
                    };
                    let (frontend_id, receiver) =
                        match self.client_bridge.start_show_message_request(
                            &self.key.workspace_id,
                            &self.preset.display_name,
                            request.message_type,
                            request.message,
                            request.actions,
                        ) {
                            Ok(value) => value,
                            Err(error) => {
                                self.send_server_error(response_id, JSON_RPC_INTERNAL_ERROR, error)
                                    .await;
                                return;
                            }
                        };
                    let duplicate = self
                        .incoming_show_message_requests
                        .lock()
                        .await
                        .insert(server_id.clone(), frontend_id.clone());
                    if duplicate.is_some() {
                        self.client_bridge
                            .cancel_show_message(&frontend_id, "Duplicate server request id");
                        self.send_server_error(
                            response_id,
                            -32600,
                            "A server request with this id is already pending",
                        )
                        .await;
                        return;
                    }
                    let session = Arc::clone(self);
                    tokio::spawn(async move {
                        let result = session
                            .client_bridge
                            .wait_for_show_message(&frontend_id, receiver)
                            .await;
                        let owns_request = session
                            .incoming_show_message_requests
                            .lock()
                            .await
                            .remove(&server_id)
                            .is_some_and(|id| id == frontend_id);
                        if !owns_request {
                            return;
                        }
                        match result {
                            Ok(value) => {
                                session
                                    .send_server_result(response_id, value.unwrap_or(Value::Null))
                                    .await
                            }
                            Err(error) => {
                                session
                                    .send_server_error(response_id, LSP_REQUEST_CANCELLED, error)
                                    .await
                            }
                        }
                    });
                }
                "client/registerCapability" => {
                    let result =
                        match parse_dynamic_capability_registrations_checked(params.as_ref()) {
                            Ok(registrations) => {
                                self.register_capability_values(registrations).await;
                                Ok(Value::Null)
                            }
                            Err(error) => Err(error),
                        };
                    match result {
                        Ok(value) => self.send_server_result(response_id, value).await,
                        Err(error) => {
                            self.send_server_error(response_id, JSON_RPC_INVALID_PARAMS, error)
                                .await
                        }
                    }
                }
                "client/unregisterCapability" => {
                    match parse_dynamic_capability_unregistrations_checked(params.as_ref()) {
                        Ok(ids) => {
                            self.unregister_capability_ids(ids).await;
                            self.send_server_result(response_id, Value::Null).await;
                        }
                        Err(error) => {
                            self.send_server_error(response_id, JSON_RPC_INVALID_PARAMS, error)
                                .await;
                        }
                    }
                }
                "workspace/configuration" => {
                    match self.configuration_response(params.as_ref()).await {
                        Ok(value) => self.send_server_result(response_id, value).await,
                        Err(error) => {
                            self.send_server_error(response_id, JSON_RPC_INVALID_PARAMS, error)
                                .await
                        }
                    }
                }
                "workspace/workspaceFolders" => {
                    self.send_server_result(
                        response_id,
                        json!([{ "uri": self.root_uri, "name": self.root_name }]),
                    )
                    .await;
                }
                "window/workDoneProgress/create" => {
                    match self.register_work_done_progress(params.as_ref()).await {
                        Ok(value) => self.send_server_result(response_id, value).await,
                        Err(error) => {
                            self.send_server_error(response_id, JSON_RPC_INVALID_PARAMS, error)
                                .await
                        }
                    }
                }
                "workspace/diagnostic/refresh" => {
                    self.client_bridge
                        .emit_diagnostics_refresh(LspDiagnosticsRefreshEvent {
                            workspace_id: self.key.workspace_id.clone(),
                            preset_id: self.key.preset_id.clone(),
                            root_uri: self.root_uri.clone(),
                        });
                    self.send_server_result(response_id, Value::Null).await;
                }
                "workspace/semanticTokens/refresh"
                | "workspace/inlayHint/refresh"
                | "workspace/codeLens/refresh"
                | "workspace/foldingRange/refresh"
                | "workspace/inlineValue/refresh" => {
                    self.send_server_result(response_id, Value::Null).await;
                }
                _ => {
                    self.send_server_error(
                        response_id,
                        JSON_RPC_METHOD_NOT_FOUND,
                        format!("Unsupported language server request: {method}"),
                    )
                    .await;
                }
            }
            return;
        }

        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return;
        };
        let params = message.get("params");
        if method == "$/cancelRequest" {
            let Some(cancel_id) = params.and_then(|value| value.get("id")).cloned() else {
                return;
            };
            let Some(server_id) = json_rpc_id_key(&cancel_id) else {
                return;
            };
            let frontend_id = self
                .incoming_show_message_requests
                .lock()
                .await
                .remove(&server_id);
            if let Some(frontend_id) = frontend_id {
                self.client_bridge
                    .cancel_show_message(&frontend_id, "Cancelled by the language server");
                self.send_server_error(cancel_id, LSP_REQUEST_CANCELLED, "Request cancelled")
                    .await;
            }
            return;
        }
        if method == "$/progress" {
            self.handle_progress_notification(params).await;
            return;
        }
        if method == "language/status" {
            if command_is_jdtls(&self.command)
                && language_status_is_service_ready(params)
                && !self.semantic_ready.swap(true, Ordering::SeqCst)
            {
                // The existing refresh channel re-queries open documents and
                // carries the updated provider status back to the renderer.
                self.client_bridge
                    .emit_diagnostics_refresh(LspDiagnosticsRefreshEvent {
                        workspace_id: self.key.workspace_id.clone(),
                        preset_id: self.key.preset_id.clone(),
                        root_uri: self.root_uri.clone(),
                    });
            }
            return;
        }
        if method == "window/showMessage" {
            if let Some(notification) = parse_show_message_notification(params) {
                self.client_bridge.emit_show_message(LspShowMessageEvent {
                    workspace_id: self.key.workspace_id.clone(),
                    server_label: self.preset.display_name.clone(),
                    message_type: notification.message_type,
                    message: notification.message,
                });
            }
            return;
        }
        if method == "textDocument/publishDiagnostics" {
            let Some(params) = params else {
                return;
            };
            let Some(uri) = params.get("uri").and_then(Value::as_str) else {
                return;
            };
            let diagnostics = params
                .get("diagnostics")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(parse_diagnostic).collect())
                .unwrap_or_default();
            let changed = {
                let mut stored = self.diagnostics.write().await;
                store_diagnostics(&mut stored, uri, diagnostics)
            };
            if changed {
                // Push-style servers never send `workspace/diagnostic/refresh`,
                // and the frontend only re-pulls on that event, a document
                // edit, or a fresh open. A publish that lands after the
                // post-open poll (cold Maven/Gradle import, workspace sweep)
                // would otherwise never reach the open editor's gutter or the
                // Problems panel, so mirror the pull-refresh signal here.
                self.client_bridge
                    .emit_diagnostics_refresh(LspDiagnosticsRefreshEvent {
                        workspace_id: self.key.workspace_id.clone(),
                        preset_id: self.key.preset_id.clone(),
                        root_uri: self.root_uri.clone(),
                    });
            }
        }
    }
}
