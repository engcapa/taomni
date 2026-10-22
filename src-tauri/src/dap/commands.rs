use super::reader::run_reader;
use super::reader::run_stderr_pump;
use super::session::DapSession;
use super::session::INITIALIZE_TIMEOUT;
use super::session::TERMINATE_GRACE;
use super::transport::connect_transport;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicI64;
use tokio::sync::Mutex;

/// Start a debug session: resolve the adapter, connect its transport, run the
/// reader pump, and send `initialize`. `app` is a **command parameter** cloned
/// into the reader closure — never stored in `AppState` (M7-C safeguard).
/// Returns the new `sessionId`. D1 ships an empty registry, so this reports
/// "no adapter" until the Java adapter (D2) is registered.
/// Result of starting a session: the id + adapter capabilities + the resolved
/// launch/attach payload. The frontend (D3) drives the rest of the DAP handshake
/// — send `request`/`arguments`, then on the `initialized` event set breakpoints
/// and `configurationDone` — so breakpoints land before the debuggee runs.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapStartResult {
    pub session_id: String,
    pub capabilities: Value,
    /// `"launch"` or `"attach"` — the request the frontend should send next.
    pub request: String,
    pub arguments: Value,
}

#[tauri::command]
pub async fn dap_start_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    adapter_id: String,
    launch_config: Value,
) -> Result<DapStartResult, String> {
    let adapter = state
        .workspace
        .dap
        .registry
        .get(&adapter_id)
        .ok_or_else(|| format!("No debug adapter registered for `{adapter_id}`"))?;
    let plan = adapter.resolve(&launch_config).await.inspect_err(|error| {
        log::warn!("dap: `{adapter_id}` could not resolve a launch plan: {error}");
    })?;
    let (reader, writer, child) = connect_transport(&plan.transport)
        .await
        .inspect_err(|error| log::warn!("dap: transport connect failed: {error}"))?;
    let (child, stderr) = match child {
        Some((child, stderr)) => (Some(child), stderr),
        None => (None, None),
    };

    let session_id = uuid::Uuid::new_v4().to_string();
    let session = Arc::new(DapSession {
        next_seq: AtomicI64::new(1),
        pending: Arc::new(Mutex::new(HashMap::new())),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        capabilities: Mutex::new(Value::Null),
    });

    // Clone the AppHandle into the reader task's emitter closure only.
    let emit_app = app.clone();
    let emit: Arc<dyn Fn(&str, Value) + Send + Sync> =
        Arc::new(move |event: &str, payload: Value| {
            use tauri::Emitter;
            let _ = emit_app.emit(event, payload);
        });
    tokio::spawn(run_reader(
        reader,
        session.clone(),
        state.workspace.dap.clone(),
        session_id.clone(),
        emit.clone(),
    ));
    if let Some(stderr) = stderr {
        tokio::spawn(run_stderr_pump(stderr, session_id.clone(), emit));
    }

    // DAP handshake: initialize, then hand the launch/attach config to the adapter.
    // `supportsConfigurationDoneRequest: true` is REQUIRED — without it, adapters
    // (java-debug) do not wait for `configurationDone` and resume the debuggee
    // immediately after launch, so breakpoints set after the `initialized` event
    // are armed too late and never hit. `supportsRunInTerminalRequest: false`:
    // we do not implement the `runInTerminal` reverse request, so adapters must
    // launch the debuggee themselves (console: internalConsole).
    //
    // Bounded: a wedged adapter that connects but never answers would otherwise
    // leave this command pending forever and the UI stuck at "starting".
    let init = tokio::time::timeout(
        INITIALIZE_TIMEOUT,
        session.request(
            "initialize",
            json!({
                "clientID": "taomni",
                "clientName": "Taomni",
                "adapterID": adapter_id,
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "pathFormat": "path",
                "supportsConfigurationDoneRequest": true,
                "supportsRunInTerminalRequest": false,
                // Ask adapters to include `type` on variables/evaluate results
                // (the variables view shows it as a tooltip).
                "supportsVariableType": true,
            }),
        ),
    )
    .await
    .map_err(|_| {
        format!(
            "debug adapter `{adapter_id}` did not answer `initialize` within {}s",
            INITIALIZE_TIMEOUT.as_secs()
        )
    })?
    .inspect_err(|error| log::warn!("dap: `{adapter_id}` rejected `initialize`: {error}"))?;
    *session.capabilities.lock().await = init.clone();
    log::info!(
        "dap: session {session_id} ready on `{adapter_id}` ({} request pending)",
        plan.request
    );

    state
        .workspace
        .dap
        .insert(session_id.clone(), session)
        .await;
    Ok(DapStartResult {
        session_id,
        capabilities: init,
        request: plan.request,
        arguments: plan.arguments,
    })
}

/// Send an arbitrary DAP request on a session and return its response body.
/// (D3–D5 wrap this with typed helpers: setBreakpoints, continue, stackTrace…)
#[tauri::command]
pub async fn dap_send_request(
    state: tauri::State<'_, crate::state::AppState>,
    session_id: String,
    command: String,
    arguments: Option<Value>,
) -> Result<Value, String> {
    let session = state
        .workspace
        .dap
        .get(&session_id)
        .await
        .ok_or_else(|| format!("No debug session `{session_id}`"))?;
    session
        .request(&command, arguments.unwrap_or(Value::Null))
        .await
}

/// Fire a DAP request without awaiting its response. Needed for the launch
/// handshake: `launch`'s response does not arrive until after `configurationDone`,
/// so the frontend fires `launch`, reacts to the `initialized` event
/// (setBreakpoints…), then fires `configurationDone` — awaiting `launch` would
/// deadlock that sequence.
#[tauri::command]
pub async fn dap_send(
    state: tauri::State<'_, crate::state::AppState>,
    session_id: String,
    command: String,
    arguments: Option<Value>,
) -> Result<(), String> {
    let session = state
        .workspace
        .dap
        .get(&session_id)
        .await
        .ok_or_else(|| format!("No debug session `{session_id}`"))?;
    session
        .notify(&command, arguments.unwrap_or(Value::Null))
        .await
}

/// Terminate a session. Prefers the graceful `terminate` request when the
/// adapter advertises it (the debuggee gets to run shutdown hooks — IDEA's and
/// VS Code's Stop both do this), then always falls back to `disconnect` and
/// kills a spawned stdio adapter.
#[tauri::command]
pub async fn dap_terminate(
    state: tauri::State<'_, crate::state::AppState>,
    session_id: String,
) -> Result<(), String> {
    if let Some(session) = state.workspace.dap.remove(&session_id).await {
        let graceful = session
            .capabilities
            .lock()
            .await
            .get("supportsTerminateRequest")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if graceful {
            // Bounded: a stuck adapter must not block the Stop button.
            let _ = tokio::time::timeout(
                TERMINATE_GRACE,
                session.request("terminate", json!({ "restart": false })),
            )
            .await;
        }
        let _ = session
            .notify("disconnect", json!({ "terminateDebuggee": true }))
            .await;
        if let Some(mut child) = session.child.lock().await.take() {
            let _ = child.start_kill();
        }
    }
    Ok(())
}
