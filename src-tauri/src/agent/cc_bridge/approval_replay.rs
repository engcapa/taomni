//! Replay of pending Claude Code approvals for a freshly mounted renderer.
//!
//! Approvals are delivered as Tauri events addressed to the window that started
//! the chat turn (issue #869), and Tauri does not queue events. A renderer reload
//! or crash therefore drops the listener while the backend still waits for a
//! decision, and the prompt would only fail after its timeout. The bridge calls
//! [`cc_pending_permission_prompts`] when it mounts and re-enqueues whatever it
//! missed; dedupe by call id keeps a prompt that was already received from being
//! shown twice.
//!
//! Only prompts that were addressed to a specific window are replayed. A
//! broadcast fallback (the owning window was gone) has no `windowLabel` and is
//! already visible in every live window, so replaying it would duplicate cards.

use crate::state::AppState;
use tauri::State;
use tauri::WebviewWindow;

/// Pending CC permission prompts addressed to the calling window, ordered by
/// call id so a replay is deterministic.
#[tauri::command]
pub async fn cc_pending_permission_prompts(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let payloads = state
        .agent
        .cc_pending_prompt_payloads
        .lock()
        .map_err(|e| e.to_string())?;
    let mut prompts = public_prompts_for_window(payloads.values(), window.label());
    prompts.sort_by(|left, right| {
        left["callId"]
            .as_str()
            .unwrap_or_default()
            .cmp(right["callId"].as_str().unwrap_or_default())
    });
    Ok(prompts)
}

/// Prompts addressed to `label`.
fn public_prompts_for_window<'a>(
    payloads: impl Iterator<Item = &'a serde_json::Value>,
    label: &str,
) -> Vec<serde_json::Value> {
    payloads
        .filter(|payload| payload["windowLabel"].as_str() == Some(label))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::public_prompts_for_window;
    use serde_json::json;

    #[test]
    fn replays_only_prompts_addressed_to_the_calling_window() {
        let payloads = vec![
            json!({ "callId": "a", "threadId": "t1", "windowLabel": "main" }),
            json!({ "callId": "b", "threadId": "t1", "windowLabel": "terminal-abc" }),
            // A broadcast fallback has no label and is already visible everywhere.
            json!({ "callId": "c", "threadId": "t1" }),
            json!({ "callId": "d", "threadId": "t2", "windowLabel": "main" }),
        ];

        let main = public_prompts_for_window(payloads.iter(), "main");
        let ids: Vec<_> = main.iter().map(|value| value["callId"].clone()).collect();
        assert_eq!(ids, vec![json!("a"), json!("d")]);
        assert!(
            main.iter()
                .all(|value| value["windowLabel"].as_str() == Some("main"))
        );

        assert!(public_prompts_for_window(payloads.iter(), "terminal-gone").is_empty());
    }
}
