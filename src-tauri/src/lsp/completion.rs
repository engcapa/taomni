use super::*;

pub(super) fn parse_completion_item(value: &Value) -> Option<LspCompletionItem> {
    let label = value.get("label")?.as_str()?.to_string();
    let edit = value.get("textEdit");
    let insert_replace_edit = match edit {
        Some(edit) if edit.get("insert").is_some() || edit.get("replace").is_some() => {
            Some(parse_completion_insert_replace_edit(edit)?)
        }
        _ => None,
    };
    Some(LspCompletionItem {
        label,
        kind: value
            .get("kind")
            .and_then(Value::as_u64)
            .and_then(|kind| u32::try_from(kind).ok()),
        detail: value
            .get("detail")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        documentation: value.get("documentation").and_then(markup_to_string),
        insert_text: value
            .get("insertText")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        insert_text_format: value
            .get("insertTextFormat")
            .and_then(Value::as_u64)
            .and_then(|format| u32::try_from(format).ok()),
        filter_text: value
            .get("filterText")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        sort_text: value
            .get("sortText")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        text_edit: value.get("textEdit").and_then(parse_text_edit),
        insert_replace_edit,
        additional_text_edits: value
            .get("additionalTextEdits")
            .and_then(Value::as_array)
            .map(|edits| edits.iter().filter_map(parse_text_edit).collect())
            .unwrap_or_default(),
        raw: value.clone(),
    })
}

/// Completion responses are either a bare `CompletionItem[]` or a
/// `CompletionList { isIncomplete, items }`.
pub(super) fn parse_completion_response(value: &Value) -> (bool, Vec<LspCompletionItem>, bool) {
    if let Some(items) = value.as_array() {
        let truncated = items.len() > MAX_COMPLETION_ITEMS;
        return (
            truncated,
            items
                .iter()
                .take(MAX_COMPLETION_ITEMS)
                .filter_map(parse_completion_item)
                .collect(),
            truncated,
        );
    }
    if let Some(items) = value.get("items").and_then(Value::as_array) {
        let truncated = items.len() > MAX_COMPLETION_ITEMS;
        let is_incomplete = value
            .get("isIncomplete")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || truncated;
        return (
            is_incomplete,
            items
                .iter()
                .take(MAX_COMPLETION_ITEMS)
                .filter_map(parse_completion_item)
                .collect(),
            truncated,
        );
    }
    (false, Vec::new(), false)
}

pub(super) fn parse_signature_parameter(
    value: &Value,
    signature_label: &str,
) -> Option<LspSignatureParameter> {
    let documentation = value.get("documentation").and_then(markup_to_string);
    match value.get("label") {
        Some(Value::String(label)) => Some(LspSignatureParameter {
            label: label.clone(),
            documentation,
            label_start: None,
            label_end: None,
        }),
        Some(Value::Array(offsets)) => {
            let start = offsets.first().and_then(Value::as_u64)?;
            let end = offsets.get(1).and_then(Value::as_u64)?;
            let label: String = signature_label
                .chars()
                .skip(usize::try_from(start).ok()?)
                .take(usize::try_from(end.saturating_sub(start)).ok()?)
                .collect();
            Some(LspSignatureParameter {
                label,
                documentation,
                label_start: u32::try_from(start).ok(),
                label_end: u32::try_from(end).ok(),
            })
        }
        _ => None,
    }
}

pub(super) fn parse_signature_help(value: &Value) -> (Vec<LspSignatureInfo>, u32, u32) {
    let signatures = value
        .get("signatures")
        .and_then(Value::as_array)
        .map(|signatures| {
            signatures
                .iter()
                .filter_map(|signature| {
                    let label = signature.get("label")?.as_str()?.to_string();
                    let parameters = signature
                        .get("parameters")
                        .and_then(Value::as_array)
                        .map(|parameters| {
                            parameters
                                .iter()
                                .filter_map(|parameter| {
                                    parse_signature_parameter(parameter, &label)
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(LspSignatureInfo {
                        documentation: signature.get("documentation").and_then(markup_to_string),
                        parameters,
                        active_parameter: signature
                            .get("activeParameter")
                            .and_then(Value::as_u64)
                            .and_then(|active| u32::try_from(active).ok()),
                        label,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let active_signature = value
        .get("activeSignature")
        .and_then(Value::as_u64)
        .and_then(|active| u32::try_from(active).ok())
        .unwrap_or(0);
    let active_parameter = value
        .get("activeParameter")
        .and_then(Value::as_u64)
        .and_then(|active| u32::try_from(active).ok())
        .unwrap_or(0);
    (signatures, active_signature, active_parameter)
}
