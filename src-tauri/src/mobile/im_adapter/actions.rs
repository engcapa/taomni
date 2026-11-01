use super::config::Config;
use crate::mobile::{Core, agent_view, file_view, session_view};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub struct Request {
    pub key: String,
    pub chat: String,
    pub command: String,
    pub private_chat: bool,
}
pub fn bounded(text: &str) -> String {
    let mut chars = text.chars();
    let value: String = chars.by_ref().take(1200).collect();
    if chars.next().is_some() {
        format!("{value}\n[已截断]")
    } else {
        value
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
    let (open, chat, id, command) = match header["event_type"].as_str() {
        Some("im.message.receive_v1") => {
            if event["sender"]["sender_type"] != "user"
                || event["message"]["message_type"] != "text"
            {
                return Ok(None);
            }
            let content: Value =
                serde_json::from_str(event["message"]["content"].as_str().unwrap_or(""))
                    .map_err(|_| "feishu_invalid_text")?;
            let text = content["text"].as_str().unwrap_or("").trim();
            let Some(command) = text.strip_prefix("/taomni ") else {
                return Ok(None);
            };
            (
                event["sender"]["sender_id"]["open_id"].as_str(),
                event["message"]["chat_id"].as_str(),
                event["message"]["message_id"].as_str(),
                command.to_owned(),
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
        private_chat: event["message"]["chat_type"] == "p2p",
        command,
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
pub async fn execute_request(core: &Core, config: &Config, request: &Request) -> String {
    if request.command.len() > 8192 {
        return "操作失败：指令不能超过 8192 UTF-8 字节。".into();
    }
    let action = request.command.split_whitespace().next().unwrap_or("");
    if matches!(action, "show" | "file") && !request.private_chat {
        return "操作失败：内容查询仅允许已绑定的私聊。".into();
    }
    execute(core, config, &request.command).await
}
pub async fn execute(core: &Core, config: &Config, command: &str) -> String {
    let result = if command.starts_with("file ") && !config.allow_file_content {
        Err("file_content_disabled".into())
    } else {
        dispatch(core, command).await
    };
    let text = match result {
        Ok(text) => text,
        Err(code) => format!("操作失败：{code}"),
    };
    format!("{}{}", bounded(&text), link(config))
}
async fn dispatch(core: &Core, command: &str) -> Result<String, String> {
    let mut parts = command.splitn(3, ' ');
    let action = parts.next().unwrap_or("");
    let task = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("").trim();
    match action {
        "help" => Ok("/taomni list\n/taomni show thread:<id>\n/taomni file thread:<id> <相对路径>\n/taomni send thread:<id> 指令\n/taomni stop thread:<id>\n/taomni approve thread:<id> <确认id>\n/taomni reject thread:<id> <确认id>\n不支持 PTY 输入。".into()),
        "list" => {
            let value = session_view::list(&core.state()).await?;
            Ok(value["sessions"].as_array().unwrap().iter().take(20).map(|v| format!("{} · {} · {}",v["id"].as_str().unwrap_or(""),v["title"].as_str().unwrap_or(""),v["status"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n"))
        }
        "show" => {
            let value = session_view::detail(&core.state(), task).await?;
            let result = if let Some(tid) = task.strip_prefix("thread:") {
                core.state().db.lock().map_err(|_| "database_unavailable")?.query_row(
                    "SELECT CASE WHEN redacted = 0 THEN substr(content,1,1201) ELSE '[内容已隐藏]' END FROM ai_chat_messages WHERE thread_id = ?1 AND role = 'assistant' ORDER BY created_at DESC,rowid DESC LIMIT 1",
                    [tid], |r| r.get::<_,String>(0)).optional().map_err(|_| "database_unavailable")?.unwrap_or_default()
            } else { String::new() };
            Ok(format!("{} · {}\n{}\n{}\n最近结果：\n{}", value["title"].as_str().unwrap_or(""),value["status"].as_str().unwrap_or(""),
                value["summary"].as_str().unwrap_or(""),value["confirmations"].as_array().map(|a| a.iter().map(|c| format!("确认 {}：{}（{}）",c["id"].as_str().unwrap_or(""),c["tool"].as_str().unwrap_or(""),if c["supported"] == true {"可批准/拒绝"} else {"需在桌面确认"})).collect::<Vec<_>>().join("\n")).unwrap_or_default(), result))
        }
        "file" => {
            let value = file_view::file(&core.state(), task, rest).await?;
            Ok(format!("{}\n{}{}", rest, value["content"].as_str().unwrap_or(""),
                if value["truncated"] == true { "\n[文件已截断]" } else { "" }))
        }
        "send" | "stop" | "approve" | "reject" if !task.starts_with("thread:") => Err("agent_only_no_pty_input".into()),
        "send" => { agent_view::message(core.clone(), task, rest).await?; Ok("已提交 Agent 后续指令；未带桌面上下文。".into()) }
        "stop" => { agent_view::stop(core, task).await?; Ok("已请求停止当前轮次。".into()) }
        "approve" | "reject" => { agent_view::confirm(&core.state(), task, rest, action)?; Ok("确认已处理。".into()) }
        _ => Err("unknown_command_use_taomni_help".into()),
    }
}
pub fn confirmation_card(config: &Config, task: &str, confirmation: &Value) -> Value {
    let mut elements = vec![
        json!({"tag":"div","text":{"tag":"plain_text","content":bounded(&format!("{}\n{}",task,confirmation["tool"].as_str().unwrap_or("确认")))}}),
    ];
    if confirmation["supported"] == true {
        elements.push(json!({"tag":"action","actions":([("同意","approve"),("拒绝","reject")].iter().map(|(label,decision)| json!({"tag":"button","text":{"tag":"plain_text","content":label},"type":"default","value":{"task_id":task,"confirmation_id":confirmation["id"],"decision":decision}})).collect::<Vec<_>>()) }));
    } else {
        elements.push(json!({"tag":"div","text":{"tag":"plain_text","content":"需在桌面确认"}}));
    }
    if !config.mobile_endpoint.is_empty() {
        elements.push(json!({"tag":"div","text":{"tag":"plain_text","content":link(config)}}));
    }
    json!({"config":{"wide_screen_mode":true},"header":{"title":{"tag":"plain_text","content":"Taomni 等待确认"}},"elements":elements})
}
