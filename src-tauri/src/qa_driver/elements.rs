use super::evaluation::element_lookup;
use super::evaluation::element_lookup_from_parts;
use super::evaluation::eval_js;
use super::evaluation::lookup_helper;
use super::model::DriverState;
use super::model::ElementRef;
use super::response::error;
use super::response::json_text;
use super::response::ok;
use super::session::session_is_valid;
use axum::Json;
use axum::extract::Path;
use axum::extract::State;
use axum::response::Response;
use serde_json::Value;
use serde_json::json;
use std::sync::atomic::Ordering;
use tauri::Runtime;

pub(super) async fn find_element<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let using = payload
        .get("using")
        .and_then(Value::as_str)
        .unwrap_or("css selector");
    let selector = match payload.get("value").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value,
        _ => return error("element selector must be a non-empty string"),
    };
    let mut script = element_lookup_from_parts(using, selector);
    script.push_str("return !!el;");
    match eval_js(&state, script).await {
        Ok(Value::Bool(true)) => {
            let id = format!(
                "qa-element-{}",
                state.next_element.fetch_add(1, Ordering::Relaxed)
            );
            state.elements.lock().await.insert(
                id.clone(),
                ElementRef {
                    using: using.into(),
                    selector: selector.into(),
                    index: 0,
                },
            );
            ok(json!({"element-6066-11e4-a52e-4f735466cecf": id}))
        }
        Ok(_) => error(format!("element not found: {selector}")),
        Err(message) => error(message),
    }
}

pub(super) async fn find_elements<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let using = payload
        .get("using")
        .and_then(Value::as_str)
        .unwrap_or("css selector");
    let selector = match payload.get("value").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value,
        _ => return error("element selector must be a non-empty string"),
    };
    let script = format!(
        "{helper}\nreturn __qaLookupAll({using}, {selector}).length;\n",
        helper = lookup_helper(),
        using = serde_json::to_string(using).unwrap_or_else(|_| "\"css selector\"".into()),
        selector = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into()),
    );
    let count = match eval_js(&state, script).await {
        Ok(Value::Number(number)) => number.as_u64().unwrap_or(0),
        Ok(_) => return error(format!("invalid element list: {selector}")),
        Err(message) => return error(message),
    };
    let mut elements = Vec::with_capacity(count as usize);
    for index in 0..count {
        let id = format!(
            "qa-element-{}",
            state.next_element.fetch_add(1, Ordering::Relaxed)
        );
        state.elements.lock().await.insert(
            id.clone(),
            ElementRef {
                using: using.into(),
                selector: selector.into(),
                index: index as usize,
            },
        );
        elements.push(json!({"element-6066-11e4-a52e-4f735466cecf": id}));
    }
    ok(Value::Array(elements))
}

pub(super) async fn element_ref<R: Runtime>(
    state: &DriverState<R>,
    id: &str,
) -> Result<ElementRef, String> {
    state
        .elements
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| format!("unknown WebDriver element: {id}"))
}

pub(super) async fn element_click<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path((session_id, element_id)): Path<(String, String)>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let reference = match element_ref(&state, &element_id).await {
        Ok(reference) => reference,
        Err(message) => return error(message),
    };
    let mut script = element_lookup(&reference);
    // W3C Element Click presses the mouse at the element's in-view center,
    // so the page sees pointer events with coordinates before the mouse
    // events. Pointer-only surfaces (the VNC and RDP canvases) ignore mouse
    // events, and a cancelled pointerdown suppresses the compatibility
    // mousedown/mouseup like a real driver.
    script.push_str(include_str!("../qa_driver_pointer.js"));
    script.push_str("return dispatchQaElementClick(el);");
    match eval_js(&state, script).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}

pub(super) async fn element_rect<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path((session_id, element_id)): Path<(String, String)>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let reference = match element_ref(&state, &element_id).await {
        Ok(reference) => reference,
        Err(message) => return error(message),
    };
    let mut script = element_lookup(&reference);
    script.push_str(concat!(
        "if (!el) throw new Error('stale element'); ",
        "const r=el.getBoundingClientRect(); ",
        "return {x:r.x,y:r.y,width:r.width,height:r.height};",
    ));
    match eval_js(&state, script).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}

pub(super) async fn element_text<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path((session_id, element_id)): Path<(String, String)>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let reference = match element_ref(&state, &element_id).await {
        Ok(reference) => reference,
        Err(message) => return error(message),
    };
    let mut script = element_lookup(&reference);
    script.push_str(
        "if (!el) throw new Error('stale element'); return el.innerText ?? el.textContent ?? '';",
    );
    match eval_js(&state, script).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}

pub(super) async fn element_value<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path((session_id, element_id)): Path<(String, String)>,
    Json(payload): Json<Value>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let text = match json_text(&payload) {
        Ok(text) => text,
        Err(message) => return error(message),
    };
    let reference = match element_ref(&state, &element_id).await {
        Ok(reference) => reference,
        Err(message) => return error(message),
    };
    let mut script = element_lookup(&reference);
    let text_json = serde_json::to_string(&text).unwrap_or_else(|_| "\"\"".into());
    script.push_str(&format!(
        r#"if (!el) throw new Error('stale element');
        el.focus?.();
        const value = {text_json};
        if (el.isContentEditable) {{
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, value);
        }} else {{
          const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value')?.set ||
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, value); else el.value = value;
          el.dispatchEvent(new InputEvent('input', {{bubbles:true, inputType:'insertText', data:value}}));
          el.dispatchEvent(new Event('change', {{bubbles:true}}));
        }}
        return true;"#
    ));
    match eval_js(&state, script).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}

pub(super) async fn element_clear<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path((session_id, element_id)): Path<(String, String)>,
) -> Response {
    let payload = json!({"text": ""});
    element_value(State(state), Path((session_id, element_id)), Json(payload)).await
}
