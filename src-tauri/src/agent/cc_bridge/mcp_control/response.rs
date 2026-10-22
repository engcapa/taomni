use rmcp::ErrorData;
use rmcp::model::CallToolResult;
use rmcp::model::Content;
use serde::Serialize;

pub(super) fn text(value: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![Content::text(value.into())])
}

pub(super) fn json_text<T: Serialize>(value: &T) -> Result<CallToolResult, ErrorData> {
    serde_json::to_string_pretty(value)
        .map(text)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))
}

pub(super) fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
