use super::{cards, commands, config::Config};
use crate::mobile::{Core, agent_view, file_view, session_view};
use rusqlite::OptionalExtension;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub use cards::{bounded, confirmation_card};

pub struct Request {
    pub key: String,
    pub chat: String,
    pub command: String,
    pub private_chat: bool,
    /// Card buttons already carry a full id; never retarget a stale button
    /// through prefix resolution after its original session disappears.
    exact_session: bool,
}
/// Command reply: plain text (help, errors, acknowledgements) or an
/// interactive card (list/show).
pub enum Reply {
    Text(String),
    Card(Value),
}
#[cfg(test)]
impl Reply {
    /// Text as sent, or the serialized card JSON.
    pub fn text(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Card(card) => card.to_string(),
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
    let (open, chat, id, command, private_chat) = match header["event_type"].as_str() {
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
            let Some(command) = commands::normalize(text, private_chat) else {
                return Ok(None);
            };
            (
                event["sender"]["sender_id"]["open_id"].as_str(),
                event["message"]["chat_id"].as_str(),
                event["message"]["message_id"].as_str(),
                command,
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
        private_chat,
        command,
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
    if matches!(action, "show" | "file") && !request.private_chat {
        return Reply::Text("操作失败：内容查询仅允许已绑定的私聊。".into());
    }
    let p2p_chat = request.private_chat.then_some(request.chat.as_str());
    run(
        core,
        config,
        &request.command,
        p2p_chat,
        request.exact_session,
    )
    .await
}
/// Executes a canonical command outside any chat, so cards carry no
/// private-chat buttons.
#[cfg(test)]
pub async fn execute(core: &Core, config: &Config, command: &str) -> Reply {
    run(core, config, command, None, false).await
}
async fn run(
    core: &Core,
    config: &Config,
    command: &str,
    p2p_chat: Option<&str>,
    exact_session: bool,
) -> Reply {
    let result = if command.starts_with("file ") && !config.allow_file_content {
        Err("file_content_disabled".into())
    } else {
        dispatch(core, config, command, p2p_chat, exact_session).await
    };
    let text = match result {
        Ok(Reply::Text(text)) => text,
        Ok(card) => return card,
        Err(code) => format!("操作失败：{code}"),
    };
    Reply::Text(format!("{}{}", bounded(&text), link(config)))
}
async fn dispatch(
    core: &Core,
    config: &Config,
    command: &str,
    p2p_chat: Option<&str>,
    exact_session: bool,
) -> Result<Reply, String> {
    let mut parts = command.splitn(3, ' ');
    let action = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("").trim();
    match action {
        "help" => return Ok(Reply::Text(commands::HELP.into())),
        "list" | "show" | "file" | "send" | "stop" | "approve" | "reject" => {}
        _ => return Ok(Reply::Text(commands::UNKNOWN.into())),
    }
    let listed = session_view::list(&core.state()).await?;
    let sessions = listed["sessions"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    if action == "list" {
        return Ok(Reply::Card(cards::list(config, sessions, p2p_chat)));
    }
    if target.is_empty() {
        return Err(commands::usage(action));
    }
    if exact_session && !sessions.iter().any(|session| session["id"] == target) {
        return Err("未找到该会话；卡片可能已过期，请发送“列表”刷新。".into());
    }
    let task = commands::resolve(sessions, target)?;
    let task = task.as_str();
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
