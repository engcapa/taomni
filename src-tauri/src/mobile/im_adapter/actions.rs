use super::{cards, commands, config::Config};
use crate::mobile::{Core, agent_view, file_view, session_view};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use rusqlite::OptionalExtension;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;

pub use cards::{bounded, confirmation_card};

pub struct Request {
    pub key: String,
    pub chat: String,
    pub open_id: String,
    pub command: String,
    /// Verbatim text after the action word (terminal input keeps spacing).
    pub raw_action: String,
    /// Verbatim text after the action and target words.
    pub raw_target: String,
    pub private_chat: bool,
    /// Card buttons already carry a full id; never retarget a stale button
    /// through prefix resolution after its original session disappears.
    exact_session: bool,
}
/// Command reply: plain text (help, errors, acknowledgements) or an
/// interactive card (list/show). Terminal cards additionally request a short
/// in-place refresh window so output can be followed from the chat.
pub enum Reply {
    Text(String),
    Card(Value),
    Terminal { card: Value, term: String },
}
#[cfg(test)]
impl Reply {
    /// Text as sent, or the serialized card JSON.
    pub fn text(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Card(card) | Self::Terminal { card, .. } => card.to_string(),
        }
    }
}
pub fn key(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
/// No webhook ingress is exposed. The authenticated, TLS-verified long connection
/// owns this input; verify application and identity again before any action.
pub fn authorize(config: &Config, value: &Value) -> Result<Option<Request>, String> {
    if value["header"]["app_id"] != config.app_id {
        return Err("feishu_application_mismatch".into());
    }
    let header = &value["header"];
    let timestamp = header["create_time"]
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        .ok_or("feishu_event_time_missing")?;
    let timestamp = if timestamp > 100_000_000_000_000 {
        timestamp / 1000
    } else {
        timestamp
    };
    let now = chrono::Utc::now().timestamp_millis();
    if timestamp < now - 600_000 || timestamp > now + 60_000 {
        return Err("feishu_stale_event".into());
    }
    let event = &value["event"];
    let (open, chat, id, command, raw_action, raw_target, private_chat) = match header["event_type"]
        .as_str()
    {
        Some("im.message.receive_v1") => {
            if event["sender"]["sender_type"] != "user"
                || event["message"]["message_type"] != "text"
            {
                return Ok(None);
            }
            let content: Value =
                serde_json::from_str(event["message"]["content"].as_str().unwrap_or(""))
                    .map_err(|_| "feishu_invalid_text")?;
            let private_chat = event["message"]["chat_type"] == "p2p";
            let text = content["text"].as_str().unwrap_or("");
            let Some(invocation) = commands::parse(text, private_chat) else {
                return Ok(None);
            };
            (
                event["sender"]["sender_id"]["open_id"].as_str(),
                event["message"]["chat_id"].as_str(),
                event["message"]["message_id"].as_str(),
                invocation.command,
                invocation.after_action,
                invocation.after_target,
                private_chat,
            )
        }
        Some("card.action.trigger") if event["action"]["value"].get("action").is_some() => {
            let chat = event["context"]["open_chat_id"].as_str();
            let (command, private_chat) = cards::callback_command(&event["action"]["value"], chat)?;
            (
                event["operator"]["open_id"].as_str(),
                chat,
                header["event_id"].as_str(),
                command,
                String::new(),
                String::new(),
                private_chat,
            )
        }
        Some("card.action.trigger") => {
            let action = &event["action"]["value"];
            let decision = action["decision"].as_str().ok_or("invalid_decision")?;
            if !matches!(decision, "approve" | "reject") {
                return Err("invalid_decision".into());
            }
            let thread = action["task_id"].as_str().ok_or("invalid_task")?;
            let confirmation = action["confirmation_id"]
                .as_str()
                .ok_or("invalid_confirmation")?;
            if thread.split_whitespace().count() != 1
                || confirmation.split_whitespace().count() != 1
            {
                return Err("invalid_confirmation".into());
            }
            (
                event["operator"]["open_id"].as_str(),
                event["context"]["open_chat_id"].as_str(),
                header["event_id"].as_str(),
                format!("{decision} {thread} {confirmation}"),
                String::new(),
                String::new(),
                false,
            )
        }
        _ => return Ok(None),
    };
    let (open, chat, id) = (
        open.ok_or("feishu_identity_missing")?,
        chat.ok_or("feishu_chat_missing")?,
        id.ok_or("feishu_event_id_missing")?,
    );
    if !config.allows(open, chat) {
        return Err("feishu_identity_denied".into());
    }
    if id.is_empty() || id.len() > 256 {
        return Err("feishu_command_too_large".into());
    }
    Ok(Some(Request {
        key: key(&format!("{}:{id}", config.app_id)),
        chat: chat.into(),
        open_id: open.into(),
        command,
        raw_action,
        raw_target,
        private_chat,
        exact_session: header["event_type"] == "card.action.trigger",
    }))
}
pub fn prepare(core: &Core) -> Result<(), String> {
    core.state().db.lock().map_err(|_| "database_unavailable")?.execute_batch(
        "CREATE TABLE IF NOT EXISTS mobile_feishu_events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);"
    ).map_err(|_| "feishu_ledger_failed".into())
}
pub fn claim(core: &Core, key: &str) -> Result<bool, String> {
    let state = core.state();
    let mut db = state.db.lock().map_err(|_| "database_unavailable")?;
    let tx = db.transaction().map_err(|_| "feishu_ledger_failed")?;
    let now = chrono::Utc::now().timestamp();
    tx.execute(
        "DELETE FROM mobile_feishu_events WHERE created_at < ?1",
        [now - 86400],
    )
    .map_err(|_| "feishu_ledger_failed")?;
    let count: i64 = tx
        .query_row("SELECT count(*) FROM mobile_feishu_events", [], |r| {
            r.get(0)
        })
        .map_err(|_| "feishu_ledger_failed")?;
    if count >= 10_000 {
        return Err("feishu_daily_command_limit".into());
    }
    let inserted = tx
        .execute(
            "INSERT OR IGNORE INTO mobile_feishu_events (id,created_at) VALUES (?1,?2)",
            rusqlite::params![key, now],
        )
        .map_err(|_| "feishu_ledger_failed")?;
    tx.commit().map_err(|_| "feishu_ledger_failed")?;
    Ok(inserted == 1)
}
pub fn link(config: &Config) -> String {
    if config.mobile_endpoint.is_empty() {
        String::new()
    } else {
        format!("\nMobile Web：{}", config.mobile_endpoint)
    }
}
pub async fn execute_request(core: &Core, config: &Config, request: &Request) -> Reply {
    if request.command.len() > 8192 {
        return Reply::Text("操作失败：指令不能超过 8192 UTF-8 字节。".into());
    }
    let action = request.command.split_whitespace().next().unwrap_or("");
    if matches!(
        action,
        "show" | "file" | "term" | "term-refresh" | "input" | "key" | "saved" | "open" | "new"
    ) && !request.private_chat
    {
        return Reply::Text("操作失败：终端输出、输入与内容查询仅允许已绑定的私聊。".into());
    }
    let p2p_chat = request.private_chat.then_some(request.chat.as_str());
    run(
        core,
        config,
        &request.command,
        p2p_chat,
        request.exact_session,
        Some(request),
    )
    .await
}
/// Executes a canonical command outside any chat, so cards carry no
/// private-chat buttons.
#[cfg(test)]
pub async fn execute(core: &Core, config: &Config, command: &str) -> Reply {
    run(core, config, command, None, false, None).await
}
/// Request shape for tests that need chat identity or privacy checks.
#[cfg(test)]
pub fn request(command: &str, private_chat: bool) -> Request {
    let after_action = command
        .split_once(' ')
        .map(|(_, rest)| rest.trim())
        .unwrap_or("")
        .to_owned();
    let after_target = command
        .splitn(3, ' ')
        .nth(2)
        .unwrap_or("")
        .trim()
        .to_owned();
    Request {
        key: "test-key".into(),
        chat: "oc_allowed".into(),
        open_id: "ou_allowed".into(),
        command: command.into(),
        raw_action: after_action,
        raw_target: after_target,
        private_chat,
        exact_session: false,
    }
}
async fn run(
    core: &Core,
    config: &Config,
    command: &str,
    p2p_chat: Option<&str>,
    exact_session: bool,
    request: Option<&Request>,
) -> Reply {
    let result = if command.starts_with("file ") && !config.allow_file_content {
        Err("file_content_disabled".into())
    } else {
        dispatch(core, config, command, p2p_chat, exact_session, request).await
    };
    let text = match result {
        Ok(Reply::Text(text)) => text,
        Ok(card) => return card,
        Err(code) => format!("操作失败：{code}"),
    };
    Reply::Text(format!("{}{}", bounded(&text), link(config)))
}
fn focus(request: Option<&Request>) -> Option<String> {
    request.map(|r| format!("{}:{}", r.open_id, r.chat))
}
async fn dispatch(
    core: &Core,
    config: &Config,
    command: &str,
    p2p_chat: Option<&str>,
    exact_session: bool,
    request: Option<&Request>,
) -> Result<Reply, String> {
    let mut parts = command.splitn(3, ' ');
    let action = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("").trim();
    match action {
        "help" => return Ok(Reply::Text(commands::HELP.into())),
        "list" | "term" | "term-refresh" | "term-unfollow" | "show" | "file" | "input" | "key"
        | "saved" | "open" | "new" | "send" | "stop" | "approve" | "reject" => {}
        _ => return Ok(Reply::Text(commands::UNKNOWN.into())),
    }
    if action == "term-unfollow" {
        return Ok(Reply::Text("已停止跟随该终端。".into()));
    }
    if action == "new" {
        return open_terminal(core, config, request, action, "").await;
    }
    let listed = session_view::list(&core.state()).await?;
    if action == "saved" {
        let saved = listed["saved_sessions"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        return Ok(Reply::Card(cards::saved(config, saved, p2p_chat)));
    }
    if action == "open" {
        let saved = listed["saved_sessions"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        if target.is_empty() {
            return Ok(Reply::Card(cards::saved(config, saved, p2p_chat)));
        }
        let id = commands::resolve_saved(saved, target)
            .or_else(|_| commands::resolve_saved(saved, &format!("{target} {rest}")))?;
        return open_terminal(core, config, request, action, &id).await;
    }
    let sessions = listed["sessions"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    if action == "list" {
        return Ok(Reply::Card(cards::list(config, sessions, p2p_chat)));
    }
    if action == "input" || action == "key" {
        return terminal_input(core, config, sessions, action, target, rest, request).await;
    }
    if target.is_empty() {
        // Terminal view falls back to the terminal this user opened last.
        if matches!(action, "term" | "term-refresh" | "show")
            && let Some(selected) =
                focus(request).and_then(|key| core.state().mobile.im.focus_get(&key))
        {
            return terminal_reply(core, config, &selected, p2p_chat, request, action == "term")
                .await;
        }
        return Err(commands::usage(action));
    }
    if exact_session && !sessions.iter().any(|session| session["id"] == target) {
        return Err("未找到该会话；卡片可能已过期，请发送“列表”刷新。".into());
    }
    let task = commands::resolve(sessions, target)?;
    let task = task.as_str();
    if matches!(action, "term" | "term-refresh" | "show") && task.starts_with("term:") {
        return terminal_reply(core, config, task, p2p_chat, request, action == "term").await;
    }
    if matches!(action, "term" | "term-refresh") {
        return Err("该 id 不是终端。发送“列表”查看终端短 id。".into());
    }
    match action {
        "show" => {
            let detail = session_view::detail(&core.state(), task).await?;
            let body = show_text(core, &detail)?;
            let short = commands::short_id(task);
            Ok(Reply::Card(cards::show(
                config, &detail, &short, &body, p2p_chat,
            )))
        }
        "file" => {
            let value = file_view::file(&core.state(), task, rest).await?;
            Ok(Reply::Text(format!(
                "{}\n{}{}",
                rest,
                value["content"].as_str().unwrap_or(""),
                if value["truncated"] == true {
                    "\n[文件已截断]"
                } else {
                    ""
                }
            )))
        }
        // Applied after resolution: a short id may name a terminal.
        _ if !task.starts_with("thread:") => Err("agent_only_no_pty_input".into()),
        "send" => {
            agent_view::message(core.clone(), task, rest).await?;
            Ok(Reply::Text(
                "已提交 Agent 后续指令；未带桌面上下文。".into(),
            ))
        }
        "stop" => {
            agent_view::stop(core, task).await?;
            Ok(Reply::Text("已请求停止当前轮次。".into()))
        }
        _ => {
            agent_view::confirm(&core.state(), task, rest, action)?;
            Ok(Reply::Text("确认已处理。".into()))
        }
    }
}
/// Terminal tail plus the buttons that keep it current. `follow` starts the
/// bounded in-place refresh; manual refreshes rebuild the card without it.
async fn terminal_reply(
    core: &Core,
    config: &Config,
    id: &str,
    p2p_chat: Option<&str>,
    request: Option<&Request>,
    follow: bool,
) -> Result<Reply, String> {
    if !id.starts_with("term:") {
        return Err("agent_only_no_pty_input".into());
    }
    let (title, status, tail) = terminal_snapshot(core, id)?;
    if let (Some(request), Some(chat)) = (request, p2p_chat) {
        core.state()
            .mobile
            .im
            .focus_set(&format!("{}:{}", request.open_id, chat), id);
    }
    let card = cards::terminal(config, id, &title, &status, &tail, follow, p2p_chat);
    if follow {
        Ok(Reply::Terminal {
            card,
            term: id.into(),
        })
    } else {
        Ok(Reply::Card(card))
    }
}
pub(super) fn terminal_snapshot(core: &Core, id: &str) -> Result<(String, String, String), String> {
    let raw = id.strip_prefix("term:").ok_or("terminal_not_found")?;
    let state = core.state();
    let terminals = state
        .mobile
        .broker
        .terminals
        .lock()
        .map_err(|_| "broker_unavailable")?;
    let terminal = terminals.get(raw).ok_or("terminal_not_found")?;
    Ok((
        terminal
            .title
            .clone()
            .unwrap_or_else(|| commands::short_id(id)),
        if terminal.running {
            "running".into()
        } else {
            "exited".into()
        },
        terminal.tail(18, 1100),
    ))
}
async fn terminal_input(
    core: &Core,
    config: &Config,
    sessions: &[Value],
    action: &str,
    target: &str,
    rest: &str,
    request: Option<&Request>,
) -> Result<Reply, String> {
    let focus_key = focus(request);
    let focus_id = focus_key
        .as_deref()
        .and_then(|key| core.state().mobile.im.focus_get(key));
    let mut selected = None;
    let text;
    if action == "input" {
        let raw_action = request.map(|r| r.raw_action.as_str()).unwrap_or("");
        let raw_target = request.map(|r| r.raw_target.as_str()).unwrap_or("");
        if target.is_empty() {
            if raw_action.is_empty() {
                return Err(commands::usage(action));
            }
            text = raw_action.to_owned();
        } else if let Ok(id) = commands::resolve(sessions, target) {
            if !id.starts_with("term:") {
                return Err("agent_only_no_pty_input".into());
            }
            selected = Some(id);
            text = raw_target.to_owned();
        } else if focus_id.is_some() {
            // The first word is input text, not a terminal id.
            text = raw_action.to_owned();
        } else {
            return Err("未指定终端。先发送“终端 <短id>”。".into());
        }
    } else {
        // `key <按键>` uses the focused terminal; `key <id> <按键>` is explicit.
        if target.is_empty() {
            return Err(commands::usage(action));
        }
        if rest.is_empty() {
            text = target.to_owned();
        } else {
            selected = Some(commands::resolve(sessions, target)?);
            text = rest.to_owned();
        }
    }
    let id = selected
        .or(focus_id)
        .ok_or_else(|| "未指定终端。先发送“终端”或“终端 <短id>”。".to_owned())?;
    if !id.starts_with("term:") {
        return Err("agent_only_no_pty_input".into());
    }
    if action == "input" {
        if text.is_empty() {
            return Err("输入内容不能为空。".into());
        }
        write_terminal(core, &id, text.as_bytes(), false).await?;
    } else {
        let bytes = commands::key_bytes(&text).ok_or("unknown_key")?;
        write_terminal(core, &id, bytes, true).await?;
    }
    if let Some(request) = request {
        core.state()
            .mobile
            .im
            .focus_set(&format!("{}:{}", request.open_id, request.chat), &id);
    }
    let (title, status, tail) = terminal_snapshot(core, &id)?;
    let chat = request.map(|r| r.chat.as_str());
    let card = cards::terminal(config, &id, &title, &status, &tail, true, chat);
    Ok(Reply::Terminal { card, term: id })
}
async fn write_terminal(core: &Core, id: &str, bytes: &[u8], raw: bool) -> Result<(), String> {
    let raw_id = id.strip_prefix("term:").ok_or("terminal_not_found")?;
    if bytes.len() > 4096 {
        return Err("input_too_large".into());
    }
    let state = core.state();
    let broker = &state.mobile.broker;
    let gate = broker.gate(raw_id)?;
    let guard = gate.lock().await;
    let connection = uuid::Uuid::new_v4().to_string();
    broker.control(raw_id, "feishu", &connection, true)?;
    let mut data = bytes.to_vec();
    if !raw && !data.ends_with(b"\n") && !data.ends_with(b"\r") {
        data.push(b'\r');
    }
    let encoded = B64.encode(&data);
    let written = crate::terminal::write_terminal_inner(&state, raw_id, &encoded).await;
    let restored = broker.control(raw_id, "feishu", &connection, false);
    drop(guard);
    written?;
    if let Ok(Some((cols, rows))) = restored {
        let _ = crate::terminal::resize_terminal_inner(&state, raw_id, cols, rows).await;
    }
    Ok(())
}
/// Opens a saved session or a new local terminal through the same desktop
/// flow the phone uses, then returns the resulting terminal card.
async fn open_terminal(
    core: &Core,
    config: &Config,
    request: Option<&Request>,
    action: &str,
    saved: &str,
) -> Result<Reply, String> {
    let open_id = request.map(|r| r.open_id.as_str()).unwrap_or("unknown");
    let device = format!("feishu:{open_id}");
    let body = if action == "new" {
        serde_json::json!({"kind":"local"})
    } else {
        serde_json::json!({"kind":"saved","saved_session_id":saved})
    };
    let state = core.state();
    let started = crate::mobile::session_open::start_im(core, &state.mobile, &device, &body)?;
    let request_id = started["request_id"]
        .as_str()
        .ok_or("open_failed")?
        .to_owned();
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let status = state.mobile.open_requests.poll(&device, &request_id)?;
        match status["status"].as_str() {
            Some("opened") => {
                let id = status["session_id"].as_str().ok_or("open_failed")?;
                let chat = request.map(|r| r.chat.as_str());
                return terminal_reply(core, config, id, chat, request, true).await;
            }
            Some("failed") => {
                let code = status["error"].as_str().unwrap_or("open_failed");
                return Err(format!("桌面打开失败：{code}"));
            }
            _ => {}
        }
    }
    Ok(Reply::Text(
        "已请求桌面打开该会话，仍在等待认证；完成后发送“终端”查看新终端。".into(),
    ))
}
fn show_text(core: &Core, detail: &Value) -> Result<String, String> {
    let status = detail["status"].as_str().unwrap_or("");
    let mut text = format!(
        "{} · {}",
        detail["title"].as_str().unwrap_or(""),
        cards::status_text(status)
    );
    let summary = detail["summary"].as_str().unwrap_or("");
    if !summary.is_empty() {
        text.push('\n');
        text.push_str(summary);
    }
    for c in detail["confirmations"].as_array().into_iter().flatten() {
        text.push_str(&format!(
            "\n确认 {}：{}（{}）",
            c["id"].as_str().unwrap_or(""),
            c["tool"].as_str().unwrap_or(""),
            if c["supported"] == true {
                "可批准/拒绝"
            } else {
                "需在桌面确认"
            }
        ));
    }
    if let Some(tid) = detail["id"]
        .as_str()
        .and_then(|id| id.strip_prefix("thread:"))
    {
        let result = core.state().db.lock().map_err(|_| "database_unavailable")?.query_row(
            "SELECT CASE WHEN redacted = 0 THEN substr(content,1,1201) ELSE '[内容已隐藏]' END FROM ai_chat_messages WHERE thread_id = ?1 AND role = 'assistant' ORDER BY created_at DESC,rowid DESC LIMIT 1",
            [tid], |r| r.get::<_, String>(0)).optional().map_err(|_| "database_unavailable")?.unwrap_or_default();
        text.push_str("\n最近结果：\n");
        text.push_str(&result);
    }
    Ok(text)
}
