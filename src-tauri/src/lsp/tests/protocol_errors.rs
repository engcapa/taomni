use super::*;

#[test]
fn retains_provider_error_code_and_exception_data_for_diagnosis() {
    let error = json!({
        "code": -32603,
        "message": "Internal error.",
        "data": "java.lang.NullPointerException\n\tat provider.CodeActions.getActions(CodeActions.java:42)"
    });
    assert_eq!(
        serde_json::from_str::<Value>(&response_error_details(&error)).unwrap(),
        error
    );
}

#[test]
fn bounds_exception_logs_at_a_utf8_boundary() {
    let details = response_error_details(&json!({ "data": "错".repeat(10_000) }));
    assert!(details.ends_with(" [truncated]"));
    assert!(details.len() <= 8_192 + " [truncated]".len());
}
