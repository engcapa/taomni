use crate::session::models::SessionType;
use crate::state::AppState;
use serde_json::{Value, json};

/// Saved session types that open as a terminal tab (what the phone can attach to).
pub fn is_terminal_type(kind: &SessionType) -> bool {
    matches!(
        kind,
        SessionType::SSH
            | SessionType::Telnet
            | SessionType::Rlogin
            | SessionType::Mosh
            | SessionType::Serial
            | SessionType::LocalShell
            | SessionType::FTP
    )
}
pub async fn list(state: &AppState) -> Result<Value, String> {
    let mut sessions = vec![];
    {
        let terminals = state
            .mobile
            .broker
            .terminals
            .lock()
            .map_err(|_| "broker_unavailable")?;
        for (id, terminal) in terminals.iter() {
            sessions.push(json!({"id":format!("term:{id}"),"kind":"terminal", "title":terminal.title.as_deref().unwrap_or(id),
                "status":if terminal.running {"running"} else {"exited"},"last_activity_at":null,"summary":terminal.summary(), "workspace_context":null}));
        }
    }
    let (threads, saved) = {
        let db = state.db.lock().map_err(|_| "database_unavailable")?;
        let threads =
            crate::chat::store::list_threads(&db, 200).map_err(|_| "database_unavailable")?;
        let saved =
            crate::session::db::list_sessions(&db, None).map_err(|_| "database_unavailable")?;
        (threads, saved)
    };
    let runs = state.agent.chat_runs.lock().await;
    let pending = state
        .mobile
        .pending_turns
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let summaries = state
        .mobile
        .task_summaries
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    for thread in threads {
        let confirmations = super::agent_view::confirmations(state, &thread.id);
        sessions.push(json!({"id":format!("thread:{}",thread.id), "kind":"agent", "title":thread.title,
            "status":if !confirmations.is_empty() {"awaiting_confirmation"} else if runs.contains_key(&thread.id) || pending.contains_key(&thread.id) {"running"} else {"idle"},
            "last_activity_at":summaries.get(&thread.id).map(|v| &v["last_activity_at"]).cloned().unwrap_or(json!(thread.updated_at)),"summary":summaries.get(&thread.id).map(|v| &v["summary"]).cloned().unwrap_or(json!("")), "workspace_context":null}));
    }
    sessions.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let saved: Vec<_> = saved.into_iter().filter(|s| is_terminal_type(&s.session_type))
        .map(|s| json!({"id":s.id,"name":s.name,"session_type":s.session_type,"group_path":s.group_path})).collect();
    Ok(json!({
        "sessions": sessions,
        "saved_sessions": saved,
        "capabilities": {
            "open_sessions": super::session_open::available(state),
            "screen_capture": state.mobile.desktop.screen_allowed(),
            "desktop_control": state.mobile.desktop_available.load(std::sync::atomic::Ordering::Relaxed)
        }
    }))
}
pub async fn detail(state: &AppState, id: &str) -> Result<Value, String> {
    if let Some(id) = id.strip_prefix("term:") {
        let ts = state
            .mobile
            .broker
            .terminals
            .lock()
            .map_err(|_| "broker_unavailable")?;
        let t = ts.get(id).ok_or("session_not_found")?;
        return Ok(
            json!({"id":format!("term:{id}"), "kind":"terminal", "title":t.title.as_deref().unwrap_or(id),
            "status":if t.running {"running"} else {"exited"},"holder":super::pty_broker::Broker::holder(t)}),
        );
    }
    let tid = id.strip_prefix("thread:").ok_or("session_not_found")?;
    let thread = {
        let db = state.db.lock().map_err(|_| "database_unavailable")?;
        crate::chat::store::get_thread(&db, tid)
            .map_err(|_| "database_unavailable")?
            .ok_or("session_not_found")?
    };
    let running = state.agent.chat_runs.lock().await.contains_key(tid)
        || state
            .mobile
            .pending_turns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(tid);
    let summary = state
        .mobile
        .task_summaries
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(tid)
        .map(|v| v["summary"].clone())
        .unwrap_or(json!(""));
    let confirmations = super::agent_view::confirmations(state, tid);
    Ok(json!({"id":id,"kind":"agent","title":thread.title,
        "status":if !confirmations.is_empty() {"awaiting_confirmation"} else if running {"running"} else {"idle"},
        "summary":summary, "tools":state.mobile.tools.lock().unwrap_or_else(|e| e.into_inner()).get(tid).cloned().unwrap_or_default(), "confirmations":confirmations,
        "capabilities":{"message":state.mobile.desktop_available.load(std::sync::atomic::Ordering::Relaxed) || (!matches!(thread.provider_id.as_str(),"claude-code" | "codex") && crate::agent::acp_bridge::profile_id_from_provider_id(&thread.provider_id).is_none()),
            "desktop_tools":state.mobile.desktop_available.load(std::sync::atomic::Ordering::Relaxed)},
        "context_notice":if state.mobile.desktop_available.load(std::sync::atomic::Ordering::Relaxed) { "由手机发起，未带桌面上下文；消息中的 ActionCard / WebSearch 确认请在桌面处理" } else { "Headless：本轮仅提供文本回复，未提供桌面工具；依赖桌面的 provider 返回 desktop_required" }}))
}
