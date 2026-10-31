use super::Core;
use crate::state::{AppState, CcPermissionDecision};
use serde_json::{Value, json};

pub fn confirmations(state: &AppState, thread: &str) -> Vec<Value> {
    let pending = state.agent.cc_pending_permissions.lock().unwrap();
    state
        .mobile
        .confirmations
        .lock()
        .unwrap()
        .values()
        .filter(|v| {
            v["thread_id"] == thread
                && (v["supported"] == false
                    || v["id"].as_str().is_some_and(|id| pending.contains_key(id)))
        })
        .map(|v| json!({"id":v["id"],"tool":v["tool"],"supported":v["supported"]}))
        .collect()
}
pub fn confirm(state: &AppState, id: &str, cid: &str, decision: &str) -> Result<(), String> {
    let tid = id.strip_prefix("thread:").ok_or("session_not_found")?;
    let value = match decision {
        "approve" => CcPermissionDecision::Allow,
        "reject" => CcPermissionDecision::Deny,
        _ => return Err("invalid_decision".into()),
    };
    let known = state.mobile.confirmations.lock().unwrap().get(cid).cloned();
    let Some(known) = known.filter(|v| v["thread_id"] == tid) else {
        return Err("not_supported_on_mobile".into());
    };
    if known["supported"] != true {
        return Err("not_supported_on_mobile".into());
    }
    let sender = state
        .agent
        .cc_pending_permissions
        .lock()
        .unwrap()
        .remove(cid)
        .ok_or("already_resolved")?;
    sender.send(value).map_err(|_| "already_resolved")?;
    state.mobile.events.publish(json!({"type":"task_status", "task_id":id,"status":"running","summary":"confirmation_resolved"}));
    Ok(())
}
pub async fn stop(core: &Core, id: &str) -> Result<(), String> {
    let state = core.state();
    if let Some(tid) = id.strip_prefix("thread:") {
        crate::chat::stop_thread_runtime_inner(tid, core.app().as_ref(), &state).await;
        state.mobile.events.publish(
            json!({"type":"task_status","task_id":id,"status":"idle","summary":"stopped"}),
        );
    } else if let Some(tid) = id.strip_prefix("term:") {
        let gate = state.mobile.broker.gate(tid)?;
        let _guard = gate.lock().await;
        let running = state
            .mobile
            .broker
            .terminals
            .lock()
            .unwrap()
            .get(tid)
            .is_some_and(|t| t.running);
        if !running {
            return Ok(());
        }
        #[cfg(unix)]
        crate::terminal::send_terminal_signal_inner(&state, tid, "SIGINT").await?;
        #[cfg(not(unix))]
        crate::terminal::write_terminal_inner(&state, tid, "Aw==").await?; // ConPTY Ctrl-C, never kill
    } else {
        return Err("session_not_found".into());
    }
    Ok(())
}
pub async fn message(core: Core, id: &str, text: &str) -> Result<(), String> {
    let tid = id.strip_prefix("thread:").ok_or("agent_only")?.to_owned();
    if text.trim().is_empty() || text.len() > 32768 {
        return Err("invalid_message".into());
    }
    let state = core.state();
    // Shared with desktop preparation: reserve before spawn, including the
    // pre-provider phase where ChatRunRegistry otherwise has no entry yet.
    let running = state.agent.chat_runs.lock().await.contains_key(&tid);
    let mut pending = state.mobile.pending_turns.lock().unwrap();
    if pending.contains_key(&tid) || running {
        return Err("turn_in_progress".into());
    }
    let thread = {
        let db = state.db.lock().map_err(|_| "database_unavailable")?;
        crate::chat::store::get_thread(&db, &tid)
            .map_err(|_| "database_unavailable")?
            .ok_or("session_not_found")?
    };
    if core.app().is_none()
        && (matches!(thread.provider_id.as_str(), "claude-code" | "codex")
            || crate::agent::acp_bridge::profile_id_from_provider_id(&thread.provider_id).is_some())
    {
        return Err("desktop_required".into());
    }
    pending.insert(tid.clone(), tokio_util::sync::CancellationToken::new());
    drop(pending);
    let req: crate::chat::ChatSendRequest =
        serde_json::from_value(json!({"thread_id":tid,"content":text,"terminal_context":null}))
            .map_err(|_| "invalid_message")?;
    drop(state);
    tokio::spawn(async move {
        let state = core.state();
        let _result = crate::chat::chat_stream_inner(req, core.app(), &state, true).await;
    });
    Ok(())
}
