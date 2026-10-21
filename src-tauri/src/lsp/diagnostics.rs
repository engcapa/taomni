use super::*;

/// Store a published diagnostics report and report whether the stored report
/// for `uri` actually changed. Servers republish unchanged reports after every
/// reconcile; the caller only signals the frontend when the report itself
/// moved, so identical republishes stay silent.
pub(super) fn store_diagnostics(
    stored: &mut HashMap<String, Vec<LspDiagnostic>>,
    uri: &str,
    diagnostics: Vec<LspDiagnostic>,
) -> bool {
    let changed = stored.get(uri) != Some(&diagnostics);
    stored.insert(uri.to_string(), diagnostics);
    changed
}

pub(super) fn parse_diagnostic(value: &Value) -> Option<LspDiagnostic> {
    Some(LspDiagnostic {
        range: parse_range(value.get("range")?)?,
        severity: value
            .get("severity")
            .and_then(Value::as_u64)
            .and_then(|severity| severity.try_into().ok()),
        code: value.get("code").and_then(|code| {
            code.as_str()
                .map(ToString::to_string)
                .or_else(|| code.as_i64().map(|number| number.to_string()))
        }),
        source: value
            .get("source")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        message: value.get("message")?.as_str()?.to_string(),
        tags: value
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(Value::as_u64)
                    .filter_map(|tag| u8::try_from(tag).ok())
                    .filter(|tag| matches!(tag, 1 | 2))
                    .collect()
            })
            .unwrap_or_default(),
        related_information: value
            .get("relatedInformation")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .take(64)
                    .filter_map(|item| {
                        Some(LspDiagnosticRelatedInformation {
                            location: parse_location(item.get("location")?)?,
                            message: item.get("message")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        code_description: value
            .pointer("/codeDescription/href")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        data: value.get("data").and_then(bounded_diagnostic_data),
    })
}

pub(super) fn bounded_diagnostic_data(value: &Value) -> Option<Value> {
    serde_json::to_vec(value)
        .ok()
        .filter(|encoded| encoded.len() <= 64 * 1024)
        .map(|_| value.clone())
}

pub(super) fn code_action_context(diagnostics: Vec<Value>, only: Option<Vec<String>>) -> Value {
    let mut context = json!({
        "diagnostics": diagnostics,
        "triggerKind": 1,
    });
    let kinds = only
        .unwrap_or_default()
        .into_iter()
        .map(|kind| kind.trim().to_string())
        .filter(|kind| !kind.is_empty())
        .collect::<Vec<_>>();
    if !kinds.is_empty() {
        context["only"] = json!(kinds);
    }
    context
}

pub(super) fn hover_contents(value: &Value) -> Option<String> {
    let contents = value.get("contents")?;
    markup_to_string(contents)
}

pub(super) fn markup_to_string(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(array) = value.as_array() {
        let parts = array
            .iter()
            .filter_map(markup_to_string)
            .collect::<Vec<_>>();
        return if parts.is_empty() {
            None
        } else {
            Some(parts.join("\n\n"))
        };
    }
    if let Some(text) = value.get("value").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("language").and_then(Value::as_str) {
        let value = value.get("value").and_then(Value::as_str).unwrap_or("");
        return Some(format!("```{text}\n{value}\n```"));
    }
    None
}

pub(super) struct WorkspaceDiagnosticUpdate {
    pub(super) uri: String,
    pub(super) diagnostics: Option<Vec<LspDiagnostic>>,
    /// `None` keeps the prior id; `Some(None)` clears it; `Some(Some(id))` replaces it.
    pub(super) result_id: Option<Option<String>>,
}

pub(super) fn collect_workspace_diagnostic_document_report(
    uri: &str,
    report: &Value,
    updates: &mut Vec<WorkspaceDiagnosticUpdate>,
) -> Result<(), String> {
    let kind = report.get("kind").and_then(Value::as_str).unwrap_or("full");
    let diagnostics = match kind {
        "full" => {
            let items = report
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    format!("workspace/diagnostic full report for '{uri}' is missing items")
                })?
                .iter()
                .filter_map(parse_diagnostic)
                .collect();
            Some(items)
        }
        "unchanged" => None,
        _ => {
            return Err(format!(
                "workspace/diagnostic returned an unsupported report kind '{kind}'"
            ));
        }
    };
    let result_id = if let Some(result_id) = report.get("resultId").and_then(Value::as_str) {
        Some(Some(result_id.to_string()))
    } else if kind == "full" {
        Some(None)
    } else {
        None
    };
    updates.push(WorkspaceDiagnosticUpdate {
        uri: uri.to_string(),
        diagnostics,
        result_id,
    });

    if let Some(related_documents) = report.get("relatedDocuments").and_then(Value::as_object) {
        for (related_uri, related_report) in related_documents {
            collect_workspace_diagnostic_document_report(related_uri, related_report, updates)?;
        }
    }
    Ok(())
}

/// Combine zero or more `$/progress` partial diagnostic chunks with the final
/// `workspace/diagnostic` response. The protocol permits the server to send
/// partial chunks before the final report; applying them only after validation
/// keeps a malformed final response from partially replacing cached diagnostics.
pub(super) fn merge_workspace_diagnostic_partial_results(
    mut response: Value,
    partial_items: Vec<Value>,
) -> Result<Value, String> {
    if partial_items.is_empty() {
        return Ok(response);
    }
    let object = response
        .as_object_mut()
        .ok_or_else(|| "workspace/diagnostic final response must be an object".to_string())?;
    let final_items = object
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            "workspace/diagnostic final response is missing an items array".to_string()
        })?;
    let mut merged = partial_items;
    merged.append(final_items);
    *final_items = merged;
    Ok(response)
}

pub(super) fn apply_workspace_diagnostic_report(
    response: &Value,
    diagnostics: &mut HashMap<String, Vec<LspDiagnostic>>,
    result_ids: &mut HashMap<String, String>,
) -> Result<(), String> {
    let items = response
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "workspace/diagnostic response is missing an items array".to_string())?;
    let mut updates = Vec::new();
    for (index, report) in items.iter().enumerate() {
        let uri = report.get("uri").and_then(Value::as_str).ok_or_else(|| {
            format!("workspace/diagnostic item {index} is missing a document URI")
        })?;
        collect_workspace_diagnostic_document_report(uri, report, &mut updates)?;
    }
    if let Some(related_documents) = response.get("relatedDocuments").and_then(Value::as_object) {
        for (related_uri, related_report) in related_documents {
            collect_workspace_diagnostic_document_report(
                related_uri,
                related_report,
                &mut updates,
            )?;
        }
    }
    for update in updates {
        if let Some(next) = update.diagnostics {
            diagnostics.insert(update.uri.clone(), next);
        }
        match update.result_id {
            Some(Some(result_id)) => {
                result_ids.insert(update.uri, result_id);
            }
            Some(None) => {
                result_ids.remove(&update.uri);
            }
            None => {}
        }
    }
    Ok(())
}
