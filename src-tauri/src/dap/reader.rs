use super::codec::DapDecoder;
use super::codec::InboundMessage;
use super::codec::classify_message;
use super::codec::extract_error_message;
use super::session::DapManager;
use super::session::DapSession;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

/// Build the response to an adapter-initiated (reverse) request. The DAP spec
/// requires the client to answer *every* reverse request; an adapter that gets
/// no answer blocks. The kernel implements none of them (`runInTerminal` is
/// declined in `initialize`, `startDebugging` needs a child-session model), so
/// it replies with a well-formed failure rather than leaving the adapter
/// hanging. Pure — unit-tested.
pub fn reverse_response(request: &Value) -> Value {
    let command = request.get("command").and_then(Value::as_str).unwrap_or("");
    let request_seq = request.get("seq").and_then(Value::as_i64).unwrap_or(-1);
    json!({
        "type": "response",
        "request_seq": request_seq,
        "success": false,
        "command": command,
        "message": format!("`{command}` is not supported by this debug client"),
    })
}

/// Drain a stdio adapter's stderr and surface it as DAP `output` events. Without
/// this the pipe fills (a few KB) and the adapter blocks forever mid-session —
/// java-debug uses TCP so it is unaffected, but every stdio adapter (debugpy,
/// delve, js-debug…) writes diagnostics there.
pub(super) async fn run_stderr_pump(
    mut stderr: tokio::process::ChildStderr,
    session_id: String,
    emit: Arc<dyn Fn(&str, Value) + Send + Sync>,
) {
    use tokio::io::AsyncReadExt;
    let mut chunk = [0u8; 4096];
    loop {
        let read = match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let text = String::from_utf8_lossy(&chunk[..read]).to_string();
        emit(
            &format!("dap:event:{session_id}"),
            json!({
                "sessionId": session_id,
                "event": "output",
                "message": { "type": "event", "event": "output",
                    "body": { "category": "stderr", "output": text } },
            }),
        );
    }
}

/// Pump the adapter's output stream: decode frames, resolve pending responses,
/// forward events to the frontend, and answer reverse requests. `emit` is a
/// boxed closure that wraps a cloned `AppHandle` (kept out of this module's
/// types so the AppState-reachable AppHandle link that broke M7-C never forms
/// here). On EOF the session is dropped from `manager` so a dead adapter cannot
/// leak an entry even when the frontend never calls `dap_terminate`.
pub(super) async fn run_reader(
    mut reader: Box<dyn tokio::io::AsyncRead + Send + Unpin>,
    session: Arc<DapSession>,
    manager: Arc<DapManager>,
    session_id: String,
    emit: Arc<dyn Fn(&str, Value) + Send + Sync>,
) {
    use tokio::io::AsyncReadExt;
    let pending = session.pending.clone();
    let mut decoder = DapDecoder::default();
    let mut chunk = [0u8; 8192];
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) => break, // EOF: adapter exited.
            Ok(n) => n,
            Err(_) => break,
        };
        decoder.push(&chunk[..read]);
        while let Some(message) = decoder.next_message() {
            match classify_message(&message) {
                InboundMessage::Response { request_seq } => {
                    if let Some(tx) = pending.lock().await.remove(&request_seq) {
                        let ok = message
                            .get("success")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let payload = if ok {
                            Ok(message.get("body").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(extract_error_message(&message))
                        };
                        let _ = tx.send(payload);
                    }
                }
                InboundMessage::Event { event } => {
                    emit(
                        &format!("dap:event:{session_id}"),
                        json!({ "sessionId": session_id, "event": event, "message": message }),
                    );
                }
                InboundMessage::ReverseRequest { command, seq } => {
                    // Answer first (an unanswered reverse request stalls the
                    // adapter), then report it for visibility.
                    let _ = session.respond(&reverse_response(&message)).await;
                    emit(
                        &format!("dap:reverse-request:{session_id}"),
                        json!({ "sessionId": session_id, "command": command, "seq": seq, "message": message }),
                    );
                }
                InboundMessage::Unknown => {}
            }
        }
    }
    // Adapter stream ended: notify the frontend so it can tear down the UI.
    emit(
        &format!("dap:event:{session_id}"),
        json!({ "sessionId": session_id, "event": "terminated", "message": Value::Null }),
    );
    manager.remove(&session_id).await;
    // Fail any still-pending requests so callers do not hang.
    let mut guard = pending.lock().await;
    for (_, tx) in guard.drain() {
        let _ = tx.send(Err("debug adapter disconnected".to_string()));
    }
}
