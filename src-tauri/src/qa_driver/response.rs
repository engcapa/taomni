use axum::Json;
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;
use serde_json::json;

pub(super) fn ok(value: Value) -> Response {
    (StatusCode::OK, Json(json!({"value": value}))).into_response()
}

pub(super) fn error(message: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "value": {
                "error": "unknown error",
                "message": message.into(),
            }
        })),
    )
        .into_response()
}

pub(super) fn json_text(payload: &Value) -> Result<String, String> {
    payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            payload
                .get("value")
                .and_then(Value::as_array)
                .map(|values| values.iter().filter_map(Value::as_str).collect::<String>())
        })
        .ok_or_else(|| "element value requires a text string".to_string())
}
use axum::response::IntoResponse;
