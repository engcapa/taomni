use super::diagnostics::sanitize_diagnostic;
use super::model::AcpRuntimeError;
use super::model::AcpRuntimeEvent;
use super::permissions::ClosedPermissionSessions;
use super::permissions::PendingPermissionMap;
use super::permissions::clear_pending_permissions;
use super::permissions::lock_unpoisoned;
use super::permissions::spawn_permission_response;
use super::requests::PendingMap;
use super::requests::SharedStdin;
use super::requests::fail_pending;
use super::requests::write_message;
use crate::agent::acp_bridge::protocol;
use crate::agent::acp_bridge::protocol::AcpIncomingMessage;
use crate::agent::acp_bridge::protocol::METHOD_SESSION_REQUEST_PERMISSION;
use crate::agent::acp_bridge::protocol::METHOD_SESSION_UPDATE;
use crate::agent::acp_bridge::protocol::parse_incoming_line;
use crate::agent::acp_bridge::protocol::parse_permission_request;
use crate::agent::acp_bridge::protocol::parse_session_update;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::BufReader;
use tokio::sync::Mutex;
use tokio::sync::broadcast;

pub(super) fn spawn_stdout_reader(
    stdout: tokio::process::ChildStdout,
    stdin: SharedStdin,
    pending: PendingMap,
    pending_permissions: PendingPermissionMap,
    permission_registration: Arc<Mutex<()>>,
    closed_permission_sessions: ClosedPermissionSessions,
    accepts_permissions: Arc<AtomicBool>,
    events: broadcast::Sender<AcpRuntimeEvent>,
    stopped: Arc<AtomicBool>,
    unknown_notifications: Arc<AtomicU64>,
    permission_timeout: Duration,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match parse_incoming_line(line.trim()) {
                        Ok(AcpIncomingMessage::Response { id, result }) => {
                            if let Some(request) = lock_unpoisoned(&pending).remove(&id) {
                                let _ = request.sender.send(Ok(result));
                            }
                        }
                        Ok(AcpIncomingMessage::ErrorResponse { id, error }) => {
                            let runtime_error = AcpRuntimeError::Rpc {
                                code: error.code,
                                message: sanitize_diagnostic(&error.message),
                            };
                            if let Some(id) = id {
                                if let Some(request) = lock_unpoisoned(&pending).remove(&id) {
                                    let _ = request.sender.send(Err(runtime_error));
                                }
                            } else {
                                let _ = events.send(AcpRuntimeEvent::ProtocolWarning {
                                    message: runtime_error.to_string(),
                                });
                            }
                        }
                        Ok(AcpIncomingMessage::Notification { method, params }) => {
                            if method == METHOD_SESSION_UPDATE {
                                if let Some(update) = parse_session_update(&params) {
                                    let _ = events.send(AcpRuntimeEvent::SessionUpdate(update));
                                } else {
                                    let _ = events.send(AcpRuntimeEvent::ProtocolWarning {
                                        message: "ignored malformed ACP session/update".into(),
                                    });
                                }
                            } else {
                                unknown_notifications.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                        Ok(AcpIncomingMessage::Request { id, method, params }) => {
                            if method == METHOD_SESSION_REQUEST_PERMISSION {
                                match parse_permission_request(&params) {
                                    Ok(request) => {
                                        spawn_permission_response(
                                            id,
                                            request,
                                            stdin.clone(),
                                            pending_permissions.clone(),
                                            permission_registration.clone(),
                                            closed_permission_sessions.clone(),
                                            accepts_permissions.clone(),
                                            events.clone(),
                                            stopped.clone(),
                                            permission_timeout,
                                        )
                                        .await;
                                    }
                                    Err(_) => {
                                        let response = json!({
                                            "jsonrpc": protocol::JSON_RPC_VERSION,
                                            "id": id,
                                            "error": {
                                                "code": -32602,
                                                "message": "Invalid ACP permission request",
                                            },
                                        });
                                        let _ = write_message(&stdin, &response, &stopped).await;
                                        let _ = events.send(AcpRuntimeEvent::ProtocolWarning {
                                            message: "ignored invalid ACP permission request"
                                                .into(),
                                        });
                                    }
                                }
                            } else {
                                let response = json!({
                                    "jsonrpc": protocol::JSON_RPC_VERSION,
                                    "id": id,
                                    "error": {
                                        "code": -32601,
                                        "message": "Method not supported by Taomni ACP client",
                                    },
                                });
                                let _ = write_message(&stdin, &response, &stopped).await;
                            }
                        }
                        Err(error) => {
                            let _ = events.send(AcpRuntimeEvent::ProtocolWarning {
                                message: error.to_string(),
                            });
                        }
                    }
                }
                Ok(None) | Err(_) => {
                    stopped.store(true, Ordering::SeqCst);
                    fail_pending(&pending, AcpRuntimeError::ProcessExited);
                    clear_pending_permissions(&pending_permissions);
                    let _ = events.send(AcpRuntimeEvent::Closed);
                    break;
                }
            }
        }
    });
}
use tokio::io::AsyncBufReadExt;
