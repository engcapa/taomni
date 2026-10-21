use super::*;

pub(super) struct WorkspaceSymbolsAggregation {
    pub(super) symbols: Vec<LspWorkspaceSymbol>,
    pub(super) session_count: u32,
    pub(super) provider_count: u32,
    pub(super) skipped_provider_count: u32,
    pub(super) failed_provider_count: u32,
    pub(super) complete: bool,
    pub(super) truncated: bool,
    pub(super) diagnostics: Vec<String>,
}

pub(super) fn aggregate_workspace_symbol_responses(
    responses: Vec<(String, String, bool, Result<Value, String>)>,
    session_count: u32,
    provider_count: u32,
    skipped_provider_count: u32,
    provider_limit_reached: bool,
) -> WorkspaceSymbolsAggregation {
    let mut diagnostics = Vec::new();
    let mut failed_provider_count = 0u32;
    let mut symbols = Vec::new();
    let mut seen = HashSet::new();
    let mut truncated = provider_limit_reached;

    for (provider, provider_session_key, supports_resolve, response) in responses {
        let value = match response {
            Ok(value) => value,
            Err(error) => {
                failed_provider_count += 1;
                push_workspace_symbol_diagnostic(&mut diagnostics, format!("{provider}: {error}"));
                continue;
            }
        };
        if value.is_null() {
            continue;
        }
        let Some(items) = value.as_array() else {
            failed_provider_count += 1;
            push_workspace_symbol_diagnostic(
                &mut diagnostics,
                format!("{provider}: invalid workspace/symbol response"),
            );
            continue;
        };
        let mut provider_malformed = false;
        let mut provider_unresolvable = false;
        for item in items {
            let Some(mut symbol) = parse_workspace_symbol(item) else {
                provider_malformed = true;
                continue;
            };
            let key = format_workspace_symbol_key(&symbol);
            if !seen.insert(key) {
                continue;
            }
            if symbols.len() >= MAX_WORKSPACE_SYMBOLS {
                truncated = true;
                continue;
            }
            if !symbol.resolved {
                if supports_resolve {
                    symbol.raw = Some(item.clone());
                    symbol.provider_session_key = Some(provider_session_key.clone());
                } else {
                    provider_unresolvable = true;
                }
            }
            symbols.push(symbol);
        }
        if provider_malformed || provider_unresolvable {
            failed_provider_count += 1;
        }
        if provider_malformed {
            push_workspace_symbol_diagnostic(
                &mut diagnostics,
                format!("{provider}: ignored malformed symbol"),
            );
        }
        if provider_unresolvable {
            push_workspace_symbol_diagnostic(
                &mut diagnostics,
                format!(
                    "{provider}: returned URI-only symbols without advertising workspaceSymbol/resolve"
                ),
            );
        }
    }
    if truncated && !provider_limit_reached {
        push_workspace_symbol_diagnostic(
            &mut diagnostics,
            format!("Workspace symbol results limited to {MAX_WORKSPACE_SYMBOLS} entries"),
        );
    } else if provider_limit_reached {
        push_workspace_symbol_diagnostic(
            &mut diagnostics,
            format!("Workspace symbol query limited to {MAX_WORKSPACE_SYMBOL_PROVIDERS} providers"),
        );
    }
    if provider_count == 0 {
        push_workspace_symbol_diagnostic(
            &mut diagnostics,
            "No active language server advertises workspace/symbol".into(),
        );
    }
    symbols.sort_by(|left, right| {
        left.path
            .as_deref()
            .unwrap_or(left.uri.as_str())
            .cmp(right.path.as_deref().unwrap_or(right.uri.as_str()))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| {
                left.selection_range
                    .start
                    .line
                    .cmp(&right.selection_range.start.line)
            })
            .then_with(|| {
                left.selection_range
                    .start
                    .character
                    .cmp(&right.selection_range.start.character)
            })
    });
    let complete = session_count > 0
        && provider_count > 0
        && skipped_provider_count == 0
        && failed_provider_count == 0
        && diagnostics.is_empty()
        && !truncated;
    WorkspaceSymbolsAggregation {
        symbols,
        session_count,
        provider_count,
        skipped_provider_count,
        failed_provider_count,
        complete,
        truncated,
        diagnostics,
    }
}

pub(super) fn push_workspace_symbol_diagnostic(diagnostics: &mut Vec<String>, message: String) {
    if diagnostics.len() < MAX_WORKSPACE_SYMBOL_DIAGNOSTICS {
        diagnostics.push(message);
    }
}

// ---------------------------------------------------------------------------
// §8.18.6 reference-request cancellation registry. Keyed by
// `<workspaceId>|<fileKey>` so a new caret/hover cancels the previous
// in-flight provider request through `$/cancelRequest`, and an explicit
// cancel command covers popup-close without a replacement request.
// ---------------------------------------------------------------------------

pub(super) fn reference_cancellations()
-> &'static std::sync::Mutex<HashMap<String, (u64, CancellationToken)>> {
    static REGISTRY: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, (u64, CancellationToken)>>,
    > = std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub(super) fn begin_reference_request(cancel_key: &str, request_seq: u64) -> CancellationToken {
    let mut guard = reference_cancellations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let cancellation = tokio_util::sync::CancellationToken::new();
    if let Some((previous_seq, previous)) = guard.get(cancel_key) {
        if *previous_seq >= request_seq {
            // A late renderer invocation must not replace a newer request.
            // Return an already-cancelled token so it cannot reach the provider.
            cancellation.cancel();
            return cancellation;
        }
        previous.cancel();
    }
    guard.insert(cancel_key.to_string(), (request_seq, cancellation.clone()));
    cancellation
}

pub(super) fn finish_reference_request(cancel_key: Option<&str>, request_seq: Option<u64>) {
    let (Some(cancel_key), Some(request_seq)) = (cancel_key, request_seq) else {
        return;
    };
    let mut guard = reference_cancellations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard
        .get(cancel_key)
        .is_some_and(|(current_seq, _)| *current_seq == request_seq)
    {
        guard.remove(cancel_key);
    }
}

pub(super) fn cancel_reference_request(cancel_key: &str, request_seq: Option<u64>) -> bool {
    let mut guard = reference_cancellations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let should_remove = match (guard.get(cancel_key), request_seq) {
        (Some((current_seq, _)), Some(request_seq)) => *current_seq == request_seq,
        (Some(_), None) => true,
        (None, _) => false,
    };
    if !should_remove {
        return false;
    }
    match guard.remove(cancel_key) {
        Some((_, cancellation)) => {
            cancellation.cancel();
            true
        }
        None => false,
    }
}

pub(super) fn begin_workspace_symbol_query(
    queries: &mut HashMap<String, (u64, CancellationToken)>,
    workspace_id: &str,
    query_id: u64,
) -> CancellationToken {
    let cancellation = CancellationToken::new();
    if let Some((_, previous)) =
        queries.insert(workspace_id.to_string(), (query_id, cancellation.clone()))
    {
        previous.cancel();
    }
    cancellation
}

pub(super) fn parse_workspace_symbol_resolve_token(token: &str) -> Result<(&str, &str), String> {
    let (batch_id, entry_id) = token
        .split_once(':')
        .ok_or_else(|| "Workspace symbol resolve token is invalid".to_string())?;
    if batch_id.len() != 32
        || !batch_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        || entry_id.is_empty()
        || !entry_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("Workspace symbol resolve token is invalid".into());
    }
    Ok((batch_id, entry_id))
}

pub(super) fn prune_workspace_symbol_resolution_batches(
    batches: &mut HashMap<String, WorkspaceSymbolResolutionBatch>,
    now: Instant,
) {
    batches.retain(|_, batch| {
        now.saturating_duration_since(batch.created_at) <= WORKSPACE_SYMBOL_RESOLUTION_TTL
    });
    while batches.len() > MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCHES
        || batches.values().map(|batch| batch.bytes).sum::<usize>()
            > MAX_WORKSPACE_SYMBOL_RESOLUTION_CACHE_BYTES
    {
        let Some(oldest) = batches
            .iter()
            .min_by_key(|(_, batch)| batch.created_at)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        batches.remove(&oldest);
    }
}

pub(super) fn merge_workspace_symbol_values(original: &Value, resolved: &Value) -> Value {
    let mut merged = merge_code_action_values(original, resolved);
    let Some(original_location) = original.get("location").and_then(Value::as_object) else {
        return merged;
    };
    let Some(resolved_location) = resolved.get("location").and_then(Value::as_object) else {
        return merged;
    };
    let Some(merged_object) = merged.as_object_mut() else {
        return merged;
    };
    let mut location = original_location.clone();
    location.extend(resolved_location.clone());
    merged_object.insert("location".into(), Value::Object(location));
    merged
}

pub(super) fn format_workspace_symbol_key(symbol: &LspWorkspaceSymbol) -> String {
    format!(
        "{}\u{0}{}\u{0}{}:{}:{}:{}:{}",
        symbol.uri,
        symbol.name,
        symbol.container_name.as_deref().unwrap_or_default(),
        symbol.selection_range.start.line,
        symbol.selection_range.start.character,
        symbol.selection_range.end.line,
        symbol.selection_range.end.character,
    )
}
