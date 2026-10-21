use super::model::DriverState;
use super::model::ElementRef;
use serde_json::Value;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;
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
    let script = format!(
        r#"(() => {{
          try {{
            {body}
          }} catch (error) {{
            return {{ __qaError: String(error), __qaStack: error && error.stack ? error.stack : null }};
          }}
        }})()"#
    );
    let (sender, receiver) = oneshot::channel::<String>();
    let sender = Arc::new(StdMutex::new(Some(sender)));
    let callback_sender = sender.clone();
    state
        .window
        .eval_with_callback(script, move |result| {
            if let Ok(mut sender) = callback_sender.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(result);
                }
            }
        })
        .map_err(|e| format!("failed to evaluate JavaScript: {e}"))?;
    let raw = tokio::time::timeout(Duration::from_secs(30), receiver)
        .await
        .map_err(|_| "WebView JavaScript evaluation timed out".to_string())?
        .map_err(|_| "WebView JavaScript callback was dropped".to_string())?;
    if raw.trim().is_empty() {
        return Ok(Value::Null);
    }
    let value: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("WebView returned invalid JSON {raw:?}: {e}"))?;
    if let Some(message) = value.get("__qaError").and_then(Value::as_str) {
        return Err(format!("JavaScript error: {message}"));
    }
    Ok(value)
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
