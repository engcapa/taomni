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

#[test]
fn identifies_jdtls_code_assist_cancellation_without_exposing_the_stack() {
    let error = json!({
        "code": -32603,
        "message": "Internal error.",
        "data": "java.util.concurrent.CompletionException: org.eclipse.core.runtime.OperationCanceledException\n\tat org.eclipse.jdt.internal.codeassist.CompletionEngine.checkCancel(CompletionEngine.java:1826)"
    });
    assert_eq!(
        response_error_message(&error, true),
        "Java code assist was cancelled by the language server: Internal error."
    );
    assert_eq!(response_error_message(&error, false), "Internal error.");
    for replacement in [
        json!(
            "java.lang.NullPointerException\n\tat org.eclipse.jdt.internal.codeassist.CompletionEngine.complete"
        ),
        json!("org.eclipse.core.runtime.OperationCanceledException\n\tat provider.Rename.apply"),
        Value::Null,
    ] {
        let mut other = error.clone();
        other["data"] = replacement;
        assert_eq!(response_error_message(&other, true), "Internal error.");
    }
    let mut other_code = error;
    other_code["code"] = json!(-32800);
    assert_eq!(response_error_message(&other_code, true), "Internal error.");
}
