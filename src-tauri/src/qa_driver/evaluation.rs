use super::model::DriverState;
use super::model::ElementRef;
use serde_json::Value;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Runtime;
use tokio::sync::oneshot;

/// Shared DOM lookup helpers for every locator-consuming endpoint.
///
/// `__qaLookupAll` mirrors the CSS/xpath/text= `>>` chain used by the
/// element endpoints and returns every match; `__qaLookup` is the
/// single-element convenience used by the first-match endpoints.
pub(super) fn lookup_helper() -> &'static str {
    r#"
        const __qaText = (part) => {
          let text = part.slice(5).trim();
          if ((text.startsWith('"') && text.endsWith('"')) ||
              (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1);
          return text;
        };
        const __qaDescendants = (root, part) => {
          const scope = root === document ? document : root;
          if (part.startsWith('text=')) {
            const needle = __qaText(part);
            const nodes = Array.from(scope.querySelectorAll('*'));
            return nodes.filter((node) => (node.textContent || '').includes(needle));
          }
          try { return Array.from(scope.querySelectorAll(part)); } catch (_) { return []; }
        };
        const __qaLookupAll = (using, selector) => {
          if (using === 'xpath') {
            const found = document.evaluate(
              selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            const nodes = [];
            for (let i = 0; i < found.snapshotLength; i++) nodes.push(found.snapshotItem(i));
            return nodes;
          }
          const parts = selector.split(/\s*>>\s*/);
          let roots = [document];
          for (const part of parts) {
            roots = roots.flatMap((root) => __qaDescendants(root, part));
            if (!roots.length) return [];
          }
          return roots;
        };
        const __qaLookup = (using, selector) => __qaLookupAll(using, selector)[0] || null;
        "#
}

/// Locator prelude that binds `el` to the referenced match (index-aware).
pub(super) fn element_lookup(reference: &ElementRef) -> String {
    let using =
        serde_json::to_string(&reference.using).unwrap_or_else(|_| "\"css selector\"".into());
    let selector = serde_json::to_string(&reference.selector).unwrap_or_else(|_| "\"\"".into());
    let index = reference.index;
    format!(
        "{helper}\nconst el = __qaLookupAll({using}, {selector})[{index}] || null;\n",
        helper = lookup_helper()
    )
}

pub(super) fn element_id_of(value: &Value) -> Option<&str> {
    value
        .get("element-6066-11e4-a52e-4f735466cecf")
        .or_else(|| value.get("ELEMENT"))
        .and_then(Value::as_str)
}

pub(super) async fn eval_js<R: Runtime>(
    state: &DriverState<R>,
    body: String,
) -> Result<Value, String> {
    let started = Instant::now();
    let requested_epoch_ms = epoch_ms();
    let script = format!(
        r#"(() => {{
          const startedEpochMs = Date.now();
          const value = (() => {{
            try {{
              {body}
            }} catch (error) {{
              return {{ __qaError: String(error), __qaStack: error && error.stack ? error.stack : null }};
            }}
          }})();
          return {{ __qaEvaluationTiming: {{ startedEpochMs, finishedEpochMs: Date.now() }}, value }};
        }})()"#
    );
    let (sender, receiver) = oneshot::channel::<(String, u128)>();
    let sender = Arc::new(StdMutex::new(Some(sender)));
    let callback_sender = sender.clone();
    state
        .current_window()?
        .eval_with_callback(script, move |result| {
            if let Ok(mut sender) = callback_sender.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send((result, epoch_ms()));
                }
            }
        })
        .map_err(|e| format!("failed to evaluate JavaScript: {e}"))?;
    let (raw, callback_epoch_ms) = tokio::time::timeout(Duration::from_secs(30), receiver)
        .await
        .map_err(|_| "WebView JavaScript evaluation timed out".to_string())?
        .map_err(|_| "WebView JavaScript callback was dropped".to_string())?;
    let (value, timing) = decode_evaluation(&raw)?;
    if started.elapsed() >= Duration::from_millis(100) {
        // Only the opt-in QA bridge calls this evaluator. Do not log scripts,
        // selectors or results; timestamps distinguish a busy renderer from
        // main-thread scheduling and delayed WKWebView completion callbacks.
        eprintln!(
            "qa-webview-evaluation {}",
            serde_json::json!({
                "requestedEpochMs": requested_epoch_ms,
                "renderer": timing,
                "callbackEpochMs": callback_epoch_ms,
                "durationMs": started.elapsed().as_secs_f64() * 1000.0,
            })
        );
    }
    if let Some(message) = value.get("__qaError").and_then(Value::as_str) {
        return Err(format!("JavaScript error: {message}"));
    }
    Ok(value)
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn decode_evaluation(raw: &str) -> Result<(Value, Value), String> {
    let mut envelope: Value = serde_json::from_str(raw)
        .map_err(|e| format!("WebView returned invalid JSON {raw:?}: {e}"))?;
    let fields = envelope
        .as_object_mut()
        .ok_or("WebView evaluation timing envelope is missing")?;
    let timing = fields
        .remove("__qaEvaluationTiming")
        .ok_or("WebView evaluation timing is missing")?;
    // JSON serialization omits undefined properties. A script with no return
    // still follows the WebDriver null-result contract.
    Ok((fields.remove("value").unwrap_or(Value::Null), timing))
}

/// Locator prelude for a not-yet-registered locator (first match).
pub(super) fn element_lookup_from_parts(using: &str, selector: &str) -> String {
    let using = serde_json::to_string(using).unwrap_or_else(|_| "\"css selector\"".into());
    let selector = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
    format!(
        "{helper}\nconst el = __qaLookup({using}, {selector});\n",
        helper = lookup_helper()
    )
}

#[cfg(test)]
mod tests {
    use super::decode_evaluation;
    use serde_json::{Value, json};

    #[test]
    fn evaluator_preserves_arbitrary_script_values() {
        for value in [
            Value::Null,
            json!(true),
            json!(42),
            json!("text"),
            json!([1]),
            json!({"value": 2, "__qaEvaluationTiming": "user value"}),
        ] {
            let raw = json!({"__qaEvaluationTiming": {"startedEpochMs": 1, "finishedEpochMs": 2}, "value": value}).to_string();
            let (decoded, timing) = decode_evaluation(&raw).unwrap();
            assert_eq!(decoded, value);
            assert_eq!(timing["finishedEpochMs"], 2);
        }
    }

    #[test]
    fn undefined_scripts_return_null_and_errors_retain_their_message() {
        assert_eq!(
            decode_evaluation(r#"{"__qaEvaluationTiming":{}}"#)
                .unwrap()
                .0,
            Value::Null
        );
        let raw = json!({"__qaEvaluationTiming": {}, "value": {"__qaError": "original error", "__qaStack": "original stack"}}).to_string();
        let (value, _) = decode_evaluation(&raw).unwrap();
        assert_eq!(value["__qaError"], "original error");
        assert_eq!(value["__qaStack"], "original stack");
    }

    #[test]
    fn incomplete_evaluation_is_an_error() {
        for raw in ["", "null", "{}", "{broken"] {
            assert!(decode_evaluation(raw).is_err());
        }
    }
}
