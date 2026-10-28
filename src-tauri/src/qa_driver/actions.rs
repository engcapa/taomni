use super::evaluation::element_id_of;
use super::evaluation::eval_js;
use super::evaluation::lookup_helper;
use super::model::DriverState;
use super::response::error;
use super::response::ok;
use super::session::session_is_valid;
use axum::Json;
use axum::extract::Path;
use axum::extract::State;
use axum::response::Response;
use serde_json::Value;
use serde_json::json;
use std::time::Duration;
use std::time::Instant;
use tauri::Runtime;

pub(super) async fn actions_script<R: Runtime>(
    state: &DriverState<R>,
    payload: &Value,
    key: &str,
) -> Result<String, String> {
    let actions = payload
        .get("actions")
        .ok_or_else(|| "actions payload is missing actions".to_string())?;
    // Replace element-reference origins with an internal selector descriptor
    // so the browser-side origin resolver can read the element's rect.
    let mut actions = actions.clone();
    if let Some(sources) = actions.as_array_mut() {
        for source in sources.iter_mut() {
            let Some(list) = source.get_mut("actions").and_then(Value::as_array_mut) else {
                continue;
            };
            for action in list.iter_mut() {
                let Some(origin) = action.get_mut("origin") else {
                    continue;
                };
                let Some(id) = element_id_of(origin).map(str::to_string) else {
                    continue;
                };
                let reference = state
                    .elements
                    .lock()
                    .await
                    .get(&id)
                    .cloned()
                    .ok_or_else(|| format!("unknown WebDriver element: {id}"))?;
                *origin = json!({"__qaElement": {
                    "using": reference.using,
                    "selector": reference.selector,
                    "index": reference.index,
                }});
            }
        }
    }
    let encoded = serde_json::to_string(&actions).map_err(|e| e.to_string())?;
    Ok(format!(
        r#"const __qaActions = {encoded};
        {helper}
        const __qaActive = document.activeElement || document.body;
        const __qaModifiers = {{Control:false,Shift:false,Alt:false,Meta:false}};
        {keyboard_script}
        const __qaButtonKey = createQaButtonKeyboard();
        const __qaKey = normalizeQaWebDriverKey;
        // Legacy keyCode/which. Constructed KeyboardEvents always report 0
        // for both, but xterm.js v6 switches on ev.keyCode for every named
        // key (Escape 27, Tab 9, arrows 37-40, Home/End, F-keys) and drops
        // anything it cannot classify - Escape/:q!/:wq silently never
        // reached the remote shell. Mirror real US-layout key codes so the
        // packaged terminal classifies keys exactly like a physical
        // keyboard; printable punctuation uses its OEM virtual key (e.g.
        // '.' is 190, not the char code 46 which is the Delete key).
        const __qaCharKey = (ch) => {{
          const lower = ch.toLowerCase();
          if (lower >= 'a' && lower <= 'z') return ['Key' + lower.toUpperCase(), lower.toUpperCase().charCodeAt(0)];
          return {{
            '0':['Digit0',48],'1':['Digit1',49],'2':['Digit2',50],'3':['Digit3',51],'4':['Digit4',52],
            '5':['Digit5',53],'6':['Digit6',54],'7':['Digit7',55],'8':['Digit8',56],'9':['Digit9',57],
            ')':['Digit0',48],'!':['Digit1',49],'@':['Digit2',50],'#':['Digit3',51],'$':['Digit4',52],
            '%':['Digit5',53],'^':['Digit6',54],'&':['Digit7',55],'*':['Digit8',56],'(':['Digit9',57],
            ' ':['Space',32],
            '-':['Minus',189],'_':['Minus',189],'=':['Equal',187],'+':['Equal',187],
            '[':['BracketLeft',219],'{{':['BracketLeft',219],']':['BracketRight',221],'}}':['BracketRight',221],
            '\\':['Backslash',220],'|':['Backslash',220],
            ';':['Semicolon',186],':':['Semicolon',186],"'":['Quote',222],'"':['Quote',222],
            ',':['Comma',188],'<':['Comma',188],'.':['Period',190],'>':['Period',190],
            '/':['Slash',191],'?':['Slash',191],'`':['Backquote',192],'~':['Backquote',192]
          }}[ch] || null;
        }};
        const __qaNamedKeyCode = (key) => {{
          const named = {{
            'Backspace':8,'Tab':9,'Enter':13,'Shift':16,'Control':17,'Alt':18,
            'CapsLock':20,'Escape':27,'PageUp':33,'PageDown':34,'End':35,
            'Home':36,'ArrowLeft':37,'ArrowUp':38,'ArrowRight':39,'ArrowDown':40,
            'Insert':45,'Delete':46,'Meta':91
          }}[key];
          if (named !== undefined) return named;
          if (/^F([1-9]|1[0-2])$/.test(key)) return 111 + Number(key.slice(1));
          return 0;
        }};
        const __qaEmitKey = (type, raw) => {{
          const key = __qaKey(raw);
          const domType = type === 'keyDown' ? 'keydown' : 'keyup';
          const modifier = key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta';
          if (modifier) __qaModifiers[key] = domType === 'keydown';
          const charKey = key.length === 1 ? __qaCharKey(key) : null;
          const code = charKey ? charKey[0] : key;
          const event = new KeyboardEvent(domType, {{key, code,
            bubbles:true, cancelable:true, ctrlKey:__qaModifiers.Control, shiftKey:__qaModifiers.Shift,
            altKey:__qaModifiers.Alt, metaKey:__qaModifiers.Meta}});
          const keyCode = charKey ? charKey[1] : __qaNamedKeyCode(key);
          if (keyCode) {{
            try {{
              Object.defineProperty(event, 'keyCode', {{ get: () => keyCode }});
              Object.defineProperty(event, 'which', {{ get: () => keyCode }});
            }} catch (_) {{}}
          }}
          __qaActive.dispatchEvent(event);
          __qaButtonKey(__qaActive, domType, key, event, __qaModifiers);
          if (domType === 'keydown') {{
            dispatchQaKeyDefault(__qaActive, key, event, __qaModifiers);
          }}
        }};
        const __qaPoint = (x, y) => document.elementFromPoint(Number(x) || 0, Number(y) || 0) || document.body;
        // Pointer origins: viewport (default), the live pointer position, or
        // an element reference. Per W3C the element origin is its in-view
        // centre point, so x/y offset from the centre (not the top-left,
        // which can fall on a border/overlay and miss the target).
        let lastX = 0, lastY = 0;
        const __qaOrigin = (origin, ox, oy) => {{
          if (origin && origin.__qaElement) {{
            const ref = origin.__qaElement;
            const el = __qaLookupAll(ref.using, ref.selector)[ref.index] || null;
            if (!el) return [ox, oy];
            const rect = el.getBoundingClientRect();
            const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth);
            const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight);
            return [cx + ox, cy + oy];
          }}
          if (origin === 'pointer') return [lastX + ox, lastY + oy];
          return [ox, oy];
        }};
        {pointer_script}
        const task = {{done: false}};
        window[{key}] = task;
        dispatchQaActions(__qaActions, __qaEmitKey, __qaModifiers, (origin, ox, oy) => {{
          [lastX, lastY] = __qaOrigin(origin, ox, oy);
          return [lastX, lastY];
        }}, __qaPoint, () => window[{key}] !== task).then(
          () => Object.assign(task, {{done: true}}),
          error => Object.assign(task, {{done: true, error: String(error)}}));
        return true;"#,
        helper = lookup_helper(),
        pointer_script = include_str!("../qa_driver_pointer.js"),
        keyboard_script = include_str!("../qa_driver_keyboard.js")
    ))
}

pub(super) async fn actions<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let key = json!(format!("__qaActions_{}", uuid::Uuid::new_v4().simple())).to_string();
    let script = match actions_script(&state, &payload, &key).await {
        Ok(script) => script,
        Err(message) => return error(message),
    };
    // WKWebView serializes a pending Promise as an empty object. Own the
    // asynchronous action sequence until it finishes, and cancel its later
    // ticks on timeout instead of returning success before pointer-up.
    let result: Result<Value, String> = async {
        eval_js(&state, script).await?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let task = eval_js(&state, format!("return window[{key}] || null;")).await?;
            if task.get("done").and_then(Value::as_bool) == Some(true) {
                if let Some(message) = task.get("error").and_then(Value::as_str) {
                    return Err(message.to_string());
                }
                return Ok(Value::Bool(true));
            }
            if Instant::now() >= deadline {
                return Err("WebView actions timed out".into());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    .await;
    let _ = eval_js(&state, format!("delete window[{key}]; return true;")).await;
    match result {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}

pub(super) async fn release_actions(Path(session_id): Path<String>) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    ok(Value::Null)
}

pub(super) async fn execute_sync<R: Runtime>(
    State(state): State<DriverState<R>>,
    Path(session_id): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if !session_is_valid(&session_id) {
        return error("unknown WebDriver session");
    }
    let script = match payload.get("script").and_then(Value::as_str) {
        Some(script) => script,
        None => return error("execute/sync requires script"),
    };
    // W3C execute/sync accepts element references as arguments; the real
    // drivers substitute live nodes. Resolve each reference to the stored
    // locator so scripts like `arguments[0].focus()` see a DOM element.
    let args = payload.get("args").cloned().unwrap_or_else(|| json!([]));
    let mut resolved: Vec<String> = Vec::new();
    for arg in args.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        if let Some(id) = element_id_of(arg) {
            let reference = match state.elements.lock().await.get(id).cloned() {
                Some(reference) => reference,
                None => return error(format!("unknown WebDriver element: {id}")),
            };
            let using = serde_json::to_string(&reference.using)
                .unwrap_or_else(|_| "\"css selector\"".into());
            let selector =
                serde_json::to_string(&reference.selector).unwrap_or_else(|_| "\"\"".into());
            resolved.push(format!(
                "__qaLookupAll({using}, {selector})[{}] || null",
                reference.index
            ));
        } else {
            resolved.push(arg.to_string());
        }
    }
    let args_json = format!("[{}]", resolved.join(", "));
    let body = format!(
        "{helper}\nconst arguments = {args_json};\n{script}",
        helper = lookup_helper()
    );
    match eval_js(&state, body).await {
        Ok(value) => ok(value),
        Err(message) => error(message),
    }
}
