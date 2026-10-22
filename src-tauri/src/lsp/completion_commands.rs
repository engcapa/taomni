use super::*;

/// §8.19.4 repeated-Basic-call facts: validate the requested-scope tag before
/// it is recorded. Standard LSP has no scope-expansion channel, so these are
/// logged for traceability and never forwarded inside the wire request.
pub(super) fn validate_requested_scope(requested_scope: Option<&str>) -> Result<(), String> {
    match requested_scope {
        None | Some("default") | Some("expanded") => Ok(()),
        Some(other) => Err(format!(
            "invalid requestedScope `{other}`; expected `default` or `expanded`"
        )),
    }
}

#[tauri::command]
pub async fn lsp_completion(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    trigger_character: Option<String>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    // §8.19.4 repeated-Basic-call facts: the frontend's invocation ordinal
    // (>= 2 = repeated explicit call at one caret) and its requested scope.
    // Standard LSP has no scope-expansion channel, so these are recorded for
    // traceability and never forwarded inside the wire request.
    invocation_ordinal: Option<u32>,
    requested_scope: Option<String>,
) -> Result<LspCompletionResult, String> {
    validate_requested_scope(requested_scope.as_deref())?;
    match (invocation_ordinal, requested_scope.as_deref()) {
        (Some(ordinal), scope) if ordinal > 1 => {
            log::info!(
                "lsp: completion repeat ordinal={ordinal} requestedScope={} file={file_path}:{line}:{character}",
                scope.unwrap_or("default")
            );
        }
        _ => {}
    }
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .workspace
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspCompletionResult {
                status,
                is_incomplete: false,
                items: Vec::new(),
                truncated: false,
            });
        }
    };
    let context = match trigger_character.as_deref().filter(|c| !c.is_empty()) {
        Some(character) => json!({ "triggerKind": 2, "triggerCharacter": character }),
        None => json!({ "triggerKind": 1 }),
    };
    let result = session
        .request(
            "textDocument/completion",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
                "context": context,
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    let (is_incomplete, items, truncated) = parse_completion_response(&result);
    Ok(LspCompletionResult {
        status,
        is_incomplete,
        items,
        truncated,
    })
}

#[tauri::command]
pub async fn lsp_completion_resolve(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    item: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspCompletionResolveResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let Some(session) = state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    else {
        return Ok(LspCompletionResolveResult::Unavailable {
            reason: "no-active-session".into(),
        });
    };
    let supports_resolve = {
        let server_capabilities = session.server_capabilities.read().await;
        let registrations = session.dynamic_capabilities.read().await;
        completion_provider_supports_resolve(&server_capabilities, &registrations)
            || jdtls_completion_item_supports_resolve(&item)
    };
    if !supports_resolve {
        return Ok(LspCompletionResolveResult::Unavailable {
            reason: "resolve-capability-missing".into(),
        });
    }
    let response = session.request("completionItem/resolve", item).await;
    let fault = QA_COMPLETION_RESOLVE_FAULT
        .lock()
        .ok()
        .and_then(|mode| *mode);
    let observed = match fault {
        Some(QaCompletionResolveFault::Null) => Ok(Value::Null),
        Some(QaCompletionResolveFault::Error) => {
            Err("QA controlled completionItem/resolve transport error".into())
        }
        None => response,
    };
    Ok(classify_completion_resolve_response(observed))
}

pub(super) fn completion_provider_supports_resolve(
    server_capabilities: &Value,
    registrations: &HashMap<String, DynamicCapabilityRegistration>,
) -> bool {
    server_capabilities
        .get("completionProvider")
        .and_then(|provider| provider.get("resolveProvider"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || registrations.values().any(|registration| {
            registration.method == "textDocument/completion"
                && registration
                    .register_options
                    .get("resolveProvider")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
}

/// JDT LS 1.61 does not advertise `completionProvider.resolveProvider`, but
/// its completion items carry the `java.completion.onDidSelect` command and
/// opaque `data` consumed by the server's CompletionResolveHandler. Treat that
/// explicit provider contract as resolve-capable while keeping unrelated
/// providers behind the standard capability gate.
pub(super) fn jdtls_completion_item_supports_resolve(item: &Value) -> bool {
    item.get("command")
        .and_then(|command| command.get("command"))
        .and_then(Value::as_str)
        == Some("java.completion.onDidSelect")
        && item.get("data").is_some_and(Value::is_object)
}

#[tauri::command]
pub fn qa_set_completion_resolve_fault(app: AppHandle, mode: String) -> Result<(), String> {
    if !cfg!(debug_assertions) || app.config().identifier != crate::QA_APP_ID {
        return Err("completion fault control requires the isolated QA app".into());
    }
    let fault = match mode.as_str() {
        "normal" => None,
        "null" => Some(QaCompletionResolveFault::Null),
        "error" => Some(QaCompletionResolveFault::Error),
        _ => return Err("unsupported completion resolve fault mode".into()),
    };
    *QA_COMPLETION_RESOLVE_FAULT
        .lock()
        .map_err(|_| "completion resolve fault lock poisoned".to_string())? = fault;
    Ok(())
}

pub(super) fn classify_completion_resolve_response(
    response: Result<Value, String>,
) -> LspCompletionResolveResult {
    match response {
        Ok(Value::Null) => LspCompletionResolveResult::Unavailable {
            reason: "resolver-returned-null".into(),
        },
        Ok(value) => parse_completion_item(&value)
            .map(|item| LspCompletionResolveResult::Resolved { item })
            .unwrap_or_else(|| LspCompletionResolveResult::Unavailable {
                reason: "invalid-resolve-result".into(),
            }),
        Err(message) if message.to_ascii_lowercase().contains("timed out") => {
            LspCompletionResolveResult::Timeout
        }
        Err(message) => LspCompletionResolveResult::Failed { message },
    }
}

#[tauri::command]
pub async fn lsp_signature_help(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    trigger_character: Option<String>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    cancel_key: Option<String>,
    request_seq: Option<u64>,
) -> Result<LspSignatureHelpResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let cancellation = match (cancel_key.as_deref(), request_seq) {
        (Some(key), Some(seq)) => begin_reference_request(key, seq),
        _ => CancellationToken::new(),
    };
    let session = match state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .workspace
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            finish_reference_request(cancel_key.as_deref(), request_seq);
            return Ok(LspSignatureHelpResult {
                status,
                signatures: Vec::new(),
                active_signature: 0,
                active_parameter: 0,
            });
        }
    };
    let context = match trigger_character.as_deref().filter(|c| !c.is_empty()) {
        Some(character) => json!({
            "triggerKind": 2,
            "triggerCharacter": character,
            "isRetrigger": false,
        }),
        None => json!({ "triggerKind": 1, "isRetrigger": false }),
    };
    // §8.20.2 W1: same cancellation identity as lsp_hover — a newer request
    // for the same key aborts this one via `$/cancelRequest`.
    let result = session
        .request_with_cancellation(
            "textDocument/signatureHelp",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
                "context": context,
            }),
            &cancellation,
        )
        .await
        .unwrap_or(Value::Null);
    finish_reference_request(cancel_key.as_deref(), request_seq);
    let cancelled = cancellation.is_cancelled();
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    if cancelled {
        // Cancelled requests report no content; the status snapshot stays
        // fresh so the next parameter request can proceed immediately.
        return Ok(LspSignatureHelpResult {
            status,
            signatures: Vec::new(),
            active_signature: 0,
            active_parameter: 0,
        });
    }
    let (signatures, active_signature, active_parameter) = parse_signature_help(&result);
    Ok(LspSignatureHelpResult {
        status,
        signatures,
        active_signature,
        active_parameter,
    })
}
