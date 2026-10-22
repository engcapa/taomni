use super::*;

/// A provider capability may be `true`, an options object, or absent/false.
pub(super) fn has_provider(capabilities: &Value, key: &str) -> bool {
    match capabilities.get(key) {
        Some(Value::Bool(enabled)) => *enabled,
        Some(Value::Object(_)) => true,
        _ => false,
    }
}

pub(super) fn workspace_diagnostic_provider_options(
    server_capabilities: &Value,
    registrations: &[DynamicCapabilityRegistration],
) -> Option<Value> {
    if let Some(registration) = registrations
        .iter()
        .filter(|registration| registration.method == "workspace/diagnostic")
        .min_by(|left, right| left.id.cmp(&right.id))
    {
        return Some(registration.register_options.clone());
    }
    let provider = server_capabilities.get("diagnosticProvider")?;
    provider
        .get("workspaceDiagnostics")
        .and_then(Value::as_bool)
        .filter(|supported| *supported)
        .map(|_| provider.clone())
}

pub(super) fn provider_strings(capabilities: &Value, key: &str, field: &str) -> Vec<String> {
    capabilities
        .get(key)
        .and_then(|provider| provider.get(field))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn file_operation_capability_key(method: &str) -> Option<&'static str> {
    match method {
        "workspace/willCreateFiles" => Some("willCreate"),
        "workspace/didCreateFiles" => Some("didCreate"),
        "workspace/willRenameFiles" => Some("willRename"),
        "workspace/didRenameFiles" => Some("didRename"),
        "workspace/willDeleteFiles" => Some("willDelete"),
        "workspace/didDeleteFiles" => Some("didDelete"),
        _ => None,
    }
}

pub(super) fn file_operation_filters_from_options(options: &Value) -> Vec<Value> {
    options
        .get("filters")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub(super) fn capability_summary_from(capabilities: &Value) -> LspCapabilitySummary {
    LspCapabilitySummary {
        text_document_sync_kind: text_document_sync_kind(capabilities),
        completion: has_provider(capabilities, "completionProvider"),
        signature_help: has_provider(capabilities, "signatureHelpProvider"),
        hover: has_provider(capabilities, "hoverProvider"),
        definition: has_provider(capabilities, "definitionProvider"),
        declaration: has_provider(capabilities, "declarationProvider"),
        type_definition: has_provider(capabilities, "typeDefinitionProvider"),
        implementation: has_provider(capabilities, "implementationProvider"),
        references: has_provider(capabilities, "referencesProvider"),
        document_symbol: has_provider(capabilities, "documentSymbolProvider"),
        workspace_symbol: has_provider(capabilities, "workspaceSymbolProvider"),
        workspace_symbol_resolve: capabilities
            .get("workspaceSymbolProvider")
            .and_then(|provider| provider.get("resolveProvider"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        rename: has_provider(capabilities, "renameProvider"),
        formatting: has_provider(capabilities, "documentFormattingProvider"),
        range_formatting: has_provider(capabilities, "documentRangeFormattingProvider"),
        code_action: has_provider(capabilities, "codeActionProvider"),
        document_highlight: has_provider(capabilities, "documentHighlightProvider"),
        call_hierarchy: has_provider(capabilities, "callHierarchyProvider"),
        type_hierarchy: has_provider(capabilities, "typeHierarchyProvider"),
        inlay_hint: has_provider(capabilities, "inlayHintProvider"),
        selection_range: has_provider(capabilities, "selectionRangeProvider"),
        semantic_tokens: has_provider(capabilities, "semanticTokensProvider"),
        workspace_diagnostics: workspace_diagnostic_provider_options(capabilities, &[]).is_some(),
        code_action_kinds: provider_strings(capabilities, "codeActionProvider", "codeActionKinds"),
        completion_trigger_characters: provider_strings(
            capabilities,
            "completionProvider",
            "triggerCharacters",
        ),
        signature_trigger_characters: provider_strings(
            capabilities,
            "signatureHelpProvider",
            "triggerCharacters",
        ),
    }
}

pub(super) fn parse_dynamic_capability_registrations(
    params: Option<&Value>,
) -> Vec<DynamicCapabilityRegistration> {
    params
        .and_then(|value| value.get("registrations"))
        .and_then(Value::as_array)
        .map(|registrations| {
            registrations
                .iter()
                .filter_map(|registration| {
                    Some(DynamicCapabilityRegistration {
                        id: registration.get("id")?.as_str()?.to_string(),
                        method: registration.get("method")?.as_str()?.to_string(),
                        register_options: registration
                            .get("registerOptions")
                            .cloned()
                            .unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Strict parser used for the JSON-RPC `client/registerCapability` request.
///
/// The permissive parser above is intentionally useful when reconstructing a
/// capability snapshot from server data, but a request must distinguish a
/// valid empty registration list from malformed parameters. Silently dropping
/// malformed entries leaves the server waiting on a capability it believes we
/// registered, so return `-32602` instead.
pub(super) fn parse_dynamic_capability_registrations_checked(
    params: Option<&Value>,
) -> Result<Vec<DynamicCapabilityRegistration>, String> {
    let params = params.ok_or_else(|| "client/registerCapability requires params".to_string())?;
    let registrations = params
        .get("registrations")
        .and_then(Value::as_array)
        .ok_or_else(|| "client/registerCapability requires a registrations array".to_string())?;
    registrations
        .iter()
        .enumerate()
        .map(|(index, registration)| {
            let object = registration.as_object().ok_or_else(|| {
                format!("client/registerCapability registration {index} must be an object")
            })?;
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    format!("client/registerCapability registration {index} has an invalid id")
                })?;
            let method = object
                .get("method")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|method| !method.is_empty())
                .ok_or_else(|| {
                    format!("client/registerCapability registration {index} has an invalid method")
                })?;
            Ok(DynamicCapabilityRegistration {
                id: id.to_string(),
                method: method.to_string(),
                register_options: object
                    .get("registerOptions")
                    .cloned()
                    .unwrap_or(Value::Null),
            })
        })
        .collect()
}

pub(super) fn parse_dynamic_capability_unregistrations(params: Option<&Value>) -> Vec<String> {
    params
        .and_then(|value| {
            value
                .get("unregisterations")
                .or_else(|| value.get("unregistrations"))
        })
        .and_then(Value::as_array)
        .map(|registrations| {
            registrations
                .iter()
                .filter_map(|registration| registration.get("id").and_then(Value::as_str))
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn parse_dynamic_capability_unregistrations_checked(
    params: Option<&Value>,
) -> Result<Vec<String>, String> {
    let params = params.ok_or_else(|| "client/unregisterCapability requires params".to_string())?;
    let registrations = params
        .get("unregisterations")
        .or_else(|| params.get("unregistrations"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "client/unregisterCapability requires an unregisterations array".to_string()
        })?;
    registrations
        .iter()
        .enumerate()
        .map(|(index, registration)| {
            let id = registration
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    format!("client/unregisterCapability registration {index} has an invalid id")
                })?;
            Ok(id.to_string())
        })
        .collect()
}

pub(super) fn option_strings(options: &Value, field: &str) -> Vec<String> {
    options
        .get(field)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn extend_unique(target: &mut Vec<String>, values: Vec<String>) {
    for value in values {
        if !target.contains(&value) {
            target.push(value);
        }
    }
}

pub(super) fn apply_dynamic_capability(
    summary: &mut LspCapabilitySummary,
    registration: &DynamicCapabilityRegistration,
) {
    match registration.method.as_str() {
        "textDocument/completion" => {
            summary.completion = true;
            extend_unique(
                &mut summary.completion_trigger_characters,
                option_strings(&registration.register_options, "triggerCharacters"),
            );
        }
        "textDocument/signatureHelp" => {
            summary.signature_help = true;
            extend_unique(
                &mut summary.signature_trigger_characters,
                option_strings(&registration.register_options, "triggerCharacters"),
            );
        }
        "textDocument/hover" => summary.hover = true,
        "textDocument/definition" => summary.definition = true,
        "textDocument/declaration" => summary.declaration = true,
        "textDocument/typeDefinition" => summary.type_definition = true,
        "textDocument/implementation" => summary.implementation = true,
        "textDocument/references" => summary.references = true,
        "textDocument/documentSymbol" => summary.document_symbol = true,
        "workspace/symbol" => {
            summary.workspace_symbol = true;
            summary.workspace_symbol_resolve |= registration
                .register_options
                .get("resolveProvider")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        }
        "textDocument/rename" => summary.rename = true,
        "textDocument/formatting" => summary.formatting = true,
        "textDocument/rangeFormatting" => summary.range_formatting = true,
        "textDocument/codeAction" => {
            summary.code_action = true;
            extend_unique(
                &mut summary.code_action_kinds,
                option_strings(&registration.register_options, "codeActionKinds"),
            );
        }
        "textDocument/documentHighlight" => summary.document_highlight = true,
        "textDocument/prepareCallHierarchy" => summary.call_hierarchy = true,
        "textDocument/prepareTypeHierarchy" => summary.type_hierarchy = true,
        "textDocument/inlayHint" => summary.inlay_hint = true,
        "textDocument/selectionRange" => summary.selection_range = true,
        "textDocument/semanticTokens" => summary.semantic_tokens = true,
        "workspace/diagnostic" => summary.workspace_diagnostics = true,
        "textDocument/didChange" => {
            summary.text_document_sync_kind = registration
                .register_options
                .get("syncKind")
                .and_then(Value::as_u64)
                .map(|kind| {
                    if kind == 2 {
                        2
                    } else if kind == 0 {
                        0
                    } else {
                        1
                    }
                })
                .unwrap_or(1);
        }
        _ => {}
    }
}

pub(super) fn capability_state_from(
    server_capabilities: &Value,
    registrations: &[DynamicCapabilityRegistration],
) -> (LspCapabilitySummary, Vec<String>, Vec<String>, bool) {
    let mut summary = capability_summary_from(server_capabilities);
    let mut semantic_provider = None;
    for registration in registrations {
        apply_dynamic_capability(&mut summary, registration);
        if registration.method == "textDocument/semanticTokens" {
            semantic_provider = Some(registration.register_options.clone());
        }
    }
    let semantic_capabilities = semantic_provider
        .map(|provider| json!({ "semanticTokensProvider": provider }))
        .unwrap_or_else(|| server_capabilities.clone());
    let (token_types, token_modifiers) = semantic_token_legend_from(&semantic_capabilities);
    let semantic_delta = semantic_token_delta_supported(&semantic_capabilities);
    (summary, token_types, token_modifiers, semantic_delta)
}

pub(super) fn text_document_sync_kind(capabilities: &Value) -> u8 {
    let sync = capabilities.get("textDocumentSync");
    let kind = match sync {
        Some(Value::Number(value)) => value.as_u64(),
        Some(Value::Object(options)) => options.get("change").and_then(Value::as_u64),
        _ => None,
    };
    match kind {
        Some(2) => 2,
        Some(0) => 0,
        _ => 1,
    }
}

pub(super) fn content_change_for_sync(
    full_text: Option<String>,
    incremental: Option<LspDocumentContentChange>,
    sync_kind: u8,
) -> Result<Value, String> {
    if sync_kind == 2
        && let Some(change) = incremental
    {
        return Ok(json!(change));
    }
    full_text
        .map(|text| json!({ "text": text }))
        .ok_or_else(|| "LSP server requires full document synchronization".into())
}
