//! Isolated-QA approval probe (issue #869).
//!
//! A real Claude Code permission prompt needs the `claude` CLI, and a real ACP
//! permission needs a running ACP agent; native QA runners have neither. This
//! command reproduces the **delivery** half of a real prompt without stubbing it:
//!
//! * `own` / `fallback` register a genuine pending permission in
//!   `cc_pending_permissions`, emit `agent-cc-permission` through the production
//!   thread -> window targeting used by `await_permission`, block until the
//!   user's card decision arrives through the real `cc_resolve_permission`
//!   command, broadcast the resolved notification, and return the decision so a
//!   case can prove the real backend path completed instead of timing out.
//! * `acp` emits an `agent-acp-permission` card through the same targeting and
//!   `acp-dismiss` emits the production `agent-acp-permission-dismissed`
//!   broadcast, so the ACP surface can be inspected without an agent process.
//!
//! Only the initiator (CC's MCP `permission_prompt` tool or an ACP agent) is
//! synthetic; the delivery, cards, queue and commands are the shipped ones.
//!
//! `tool` reproduces the side-effect half instead: the caller becomes the chat
//! owner, then a real `agent-cc-tool` dispatch for the terminal tracked to
//! another window is delivered through the production routing, and its outcome
//! is returned. That is how the detach case proves the effect ran in the window
//! that owns the terminal rather than in the chat window.
//!
//! Every build compiles this command, but it refuses to run outside the isolated
//! QA application profile (`com.taomni.app.qa`); the renderer chord that calls it
//! is compiled out of production bundles. A production app therefore never
//! reaches it.

use crate::agent::cc_bridge::mcp_http::request_permission;
use crate::agent::cc_bridge::mcp_http::request_tool_dispatch;
use crate::state::AppState;
use crate::windowing::thread_delivery::Delivery;
use crate::windowing::thread_delivery::emit_thread_event_for_app;
use crate::windowing::thread_delivery::plan_thread_delivery;
use serde_json::json;
use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::OnceLock;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;
use tauri::WebviewWindow;
use uuid::Uuid;

const PROBE_THREAD_DEFAULT: &str = "qa-agent-approval-thread";

/// Threads with a blocking probe currently waiting for a decision.
fn probe_guard() -> &'static Mutex<HashSet<String>> {
    static GUARD: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Releases the thread's probe slot when the command finishes (decision,
/// timeout, or cancellation).
struct ProbeGuard {
    thread_id: String,
}

impl ProbeGuard {
    fn acquire(thread_id: &str) -> Option<Self> {
        let mut guard = probe_guard().lock().unwrap_or_else(|e| e.into_inner());
        if !guard.insert(thread_id.to_string()) {
            return None;
        }
        Some(Self {
            thread_id: thread_id.to_string(),
        })
    }
}

impl Drop for ProbeGuard {
    fn drop(&mut self) {
        probe_guard()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.thread_id);
    }
}

fn delivery_name(delivery: &Delivery) -> String {
    match delivery {
        Delivery::Target(label) => format!("target:{label}"),
        Delivery::Broadcast => "broadcast".to_string(),
    }
}

/// QA probe: start a pending approval for `thread_id` and block until the card
/// decision arrives.
///
/// `mode`:
/// * `own` (default) — record the calling window as the thread's approval owner,
///   exactly like `chat_stream` does for a real turn.
/// * `fallback` — keep the previously recorded owner; used to exercise the
///   closed-owner-window fallback after that window was destroyed.
/// * `stale` — record an owner label that no window has, then request: the prompt
///   must be broadcast so every live window can answer it (two cards on purpose;
///   deciding one clears the other through the resolved broadcast).
/// * `acp` — emit an ACP permission card addressed like a real one.
/// * `acp-dismiss` — emit the production ACP dismissed broadcast.
/// * `tool` — claim the thread for the calling window, then dispatch a real
///   `run_in_terminal` effect for a terminal owned by a *different* window and
///   return its outcome (proves the terminal-window routing).
#[tauri::command]
pub async fn qa_agent_approval_probe(
    window: WebviewWindow,
    thread_id: Option<String>,
    mode: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    if !crate::qa_profile_active() {
        return Err("qa_agent_approval_probe is only available in the isolated QA build".into());
    }
    let app = window.app_handle().clone();
    let thread_id = thread_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| PROBE_THREAD_DEFAULT.to_string());
    let mode = mode.unwrap_or_else(|| "own".to_string());
    // A repeated trigger must not stack approvals. The renderer chord is already
    // single-flight per document, but the stimulus can reach the backend twice
    // (observed with the WebKitGTK automation transport after a window switch),
    // and two pending prompts for one thread would later surface as two cards.
    let _guard = match mode.as_str() {
        "own" | "fallback" | "stale" => match ProbeGuard::acquire(&thread_id) {
            Some(guard) => Some(guard),
            None => {
                return Ok(json!({
                    "threadId": thread_id,
                    "mode": mode,
                    "windowLabel": window.label(),
                    "skipped": "approval probe already pending for this thread",
                }));
            }
        },
        _ => None,
    };
    match mode.as_str() {
        // `tool` claims the thread for the caller on purpose: the effect must
        // still be routed to the window that owns the terminal.
        "own" | "acp" | "tool" => state
            .agent
            .thread_windows
            .record(&thread_id, window.label()),
        // Records an owner window that does not exist, which is the state left
        // behind when a detached window is destroyed while a turn is running.
        // The prompt must therefore fall back to a broadcast that every live
        // window shows.
        "stale" => state
            .agent
            .thread_windows
            .record(&thread_id, "qa-destroyed-owner-window"),
        "fallback" | "acp-dismiss" => {}
        other => return Err(format!("unknown QA approval probe mode `{other}`")),
    }
    let planned = plan_thread_delivery(&app, &thread_id);

    if mode == "acp" {
        let call_id = Uuid::new_v4().to_string();
        emit_thread_event_for_app(
            &app,
            &thread_id,
            "agent-acp-permission",
            json!({
                "callId": call_id,
                "threadId": thread_id,
                "permissionOwnerId": "qa-approval-probe",
                "sourceLabel": "ACP QA 探针",
                "title": "写入 README.md（QA 探针）",
                "kind": "edit",
                "options": [
                    { "optionId": "allow-once", "kind": "allow_once" },
                    { "optionId": "allow-always", "kind": "allow_always" },
                    { "optionId": "reject-once", "kind": "reject_once" },
                    { "optionId": "reject-always", "kind": "reject_always" },
                ],
            }),
        );
        return Ok(json!({
            "threadId": thread_id,
            "mode": mode,
            "windowLabel": window.label(),
            "delivery": delivery_name(&planned),
            "callId": call_id,
            "decision": serde_json::Value::Null,
        }));
    }

    if mode == "tool" {
        state
            .agent
            .thread_windows
            .record(&thread_id, window.label());
        let candidate = {
            let tab_windows = state
                .agent
                .cc_tab_windows
                .lock()
                .map(|map| map.clone())
                .unwrap_or_default();
            tab_windows
                .into_iter()
                .filter(|(_, label)| label != window.label())
                .min_by_key(|(tab, _)| tab.clone())
        };
        let Some((tab_id, terminal_window)) = candidate else {
            return Err(
                "qa_agent_approval_probe tool: no terminal is tracked to another window".into(),
            );
        };
        let outcome = request_tool_dispatch(
            &app,
            &thread_id,
            "run_in_terminal",
            json!({
                "session_id": tab_id,
                "command": "echo QA_CC_TOOL_ONCE",
                "description": "QA probe side effect used to verify window-scoped dispatch (issue #869)",
            }),
        )
        .await;
        return Ok(json!({
            "threadId": thread_id,
            "mode": mode,
            "windowLabel": window.label(),
            "tabId": tab_id,
            "terminalWindow": terminal_window,
            "delivery": format!("target:{terminal_window}"),
            "outcome": outcome,
        }));
    }

    if mode == "acp-dismiss" {
        let _ = app.emit(
            "agent-acp-permission-dismissed",
            json!({ "threadId": thread_id, "permissionOwnerId": null, "callId": null }),
        );
        return Ok(json!({
            "threadId": thread_id,
            "mode": mode,
            "windowLabel": window.label(),
            "delivery": "broadcast",
            "decision": serde_json::Value::Null,
        }));
    }

    let decision = request_permission(
        &app,
        &thread_id,
        "qa__approval_probe",
        &json!({
            "command": "echo qa-agent-approval-probe",
            "description": "QA probe approval used to verify window-scoped delivery (issue #869)",
        }),
        "manual",
    )
    .await;
    Ok(json!({
        "threadId": thread_id,
        "mode": mode,
        "windowLabel": window.label(),
        "delivery": delivery_name(&planned),
        "decision": decision,
    }))
}
