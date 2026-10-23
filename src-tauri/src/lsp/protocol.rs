use super::*;

pub(super) fn response_error_message(error: &Value, is_jdtls: bool) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| error.to_string());
    let data = error.get("data").and_then(Value::as_str).unwrap_or("");
    if is_jdtls
        && error.get("code").and_then(Value::as_i64) == Some(-32603)
        && data.contains("org.eclipse.core.runtime.OperationCanceledException")
        && data.contains("org.eclipse.jdt.internal.codeassist.CompletionEngine.")
    {
        return format!("Java code assist was cancelled by the language server: {message}");
    }
    message
}

/// Keep provider exception details in the application log without putting a
/// stack trace in the status bar or allowing an unbounded log entry.
pub(super) fn response_error_details(error: &Value) -> String {
    let mut details = error.to_string();
    const MAX_BYTES: usize = 8_192;
    if details.len() > MAX_BYTES {
        details.truncate(details.floor_char_boundary(MAX_BYTES));
        details.push_str(" [truncated]");
    }
    details
}

pub(super) fn request_document_uri(params: &Value) -> Option<&str> {
    params
        .pointer("/textDocument/uri")
        .or_else(|| params.pointer("/item/uri"))
        .and_then(Value::as_str)
}

pub(super) fn take_pending_for_document(
    pending: &mut HashMap<u64, PendingResponse>,
    uri: &str,
) -> Vec<(u64, PendingResponse)> {
    let ids = pending
        .iter()
        .filter_map(|(id, response)| (response.document_uri.as_deref() == Some(uri)).then_some(*id))
        .collect::<Vec<_>>();
    ids.into_iter()
        .filter_map(|id| pending.remove(&id).map(|response| (id, response)))
        .collect()
}

pub(super) fn parse_position(value: &Value) -> Option<LspPosition> {
    Some(LspPosition {
        line: value.get("line")?.as_u64()?.try_into().ok()?,
        character: value.get("character")?.as_u64()?.try_into().ok()?,
    })
}

pub(super) fn parse_range(value: &Value) -> Option<LspRange> {
    Some(LspRange {
        start: parse_position(value.get("start")?)?,
        end: parse_position(value.get("end")?)?,
    })
}
