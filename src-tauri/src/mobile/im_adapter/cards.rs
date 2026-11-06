//! Interactive card replies and session deep links. Button values are built
//! here and parsed back by `callback_command`; keep both sides in sync.
use super::{commands, config::Config};
use serde_json::{Value, json};

/// Feishu caps card request bodies at 30 KB; content is sent as a JSON string.
pub const CARD_BYTES: usize = 28 * 1024;
pub const MESSAGE_CHARS: usize = 2000;
/// Same visible-text budget as the 1200-character text replies.
const BODY_CHARS: usize = 1200;
const TRUNCATED: &str = "\n[已截断]";
const LIST_ROWS: usize = 20;
const TITLE_CHARS: usize = 40;
const CONFIRMATION_ROWS: usize = 5;

pub fn bounded(text: &str) -> String {
    let mut chars = text.chars();
    let value: String = chars.by_ref().take(BODY_CHARS).collect();
    if chars.next().is_some() {
        format!("{value}{TRUNCATED}")
    } else {
        value
    }
}

/// Matches JavaScript `encodeURIComponent`: UTF-8 bytes outside
/// `A-Z a-z 0-9 - _ . ! ~ * ' ( )` become uppercase `%XX`.
pub fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
/// Mobile Web route for one session; the contract shared with `mobile-web`.
pub fn session_link(config: &Config, id: &str) -> Option<String> {
    (!config.mobile_endpoint.is_empty()).then(|| {
        format!(
            "{}/#/session/{}",
            config.mobile_endpoint.trim_end_matches('/'),
            encode_component(id)
        )
    })
}
/// Text suffix with the session deep link, or nothing without an endpoint.
pub fn link_line(config: &Config, id: &str) -> String {
    session_link(config, id)
        .map(|url| format!("\nMobile Web：{url}"))
        .unwrap_or_default()
}
pub fn status_text(status: &str) -> &str {
    match status {
        "running" => "运行中",
        "idle" => "空闲",
        "exited" => "已退出",
        "awaiting_confirmation" => "待确认",
        other => other,
    }
}
/// Size of the card as it appears inside the send request body.
pub fn encoded_len(card: &Value) -> usize {
    serde_json::to_string(&card.to_string()).map_or(usize::MAX, |s| s.len())
}
fn clip(text: &str, chars: usize) -> String {
    let mut iter = text.chars();
    let value: String = iter.by_ref().take(chars).collect();
    if iter.next().is_some() {
        format!("{value}…")
    } else {
        value
    }
}
fn div(content: &str) -> Value {
    json!({"tag":"div","text":{"tag":"plain_text","content":content}})
}
fn label(text: &str) -> Value {
    json!({"tag":"plain_text","content":text})
}
fn callback(text: &str, kind: &str, value: Value) -> Value {
    json!({"tag":"button","text":label(text),"type":kind,"value":value})
}
fn open_button(url: &str) -> Value {
    json!({"tag":"button","text":label("打开手机页面"),"type":"default","url":url})
}
fn row(buttons: Vec<Value>) -> Option<Value> {
    (!buttons.is_empty()).then(|| json!({"tag":"action","actions":buttons}))
}
fn visible_len(value: &Value) -> usize {
    match value {
        Value::Object(fields) => fields
            .iter()
            .map(|(key, value)| {
                if key == "content" {
                    value.as_str().map_or(0, |text| text.chars().count())
                } else if key == "value" || key == "confirm" {
                    0
                } else {
                    visible_len(value)
                }
            })
            .sum(),
        Value::Array(values) => values.iter().map(visible_len).sum(),
        _ => 0,
    }
}
fn card(title: &str, elements: Vec<Value>) -> Value {
    json!({"config":{"wide_screen_mode":true},"header":{"title":label(title)},"elements":elements})
}
/// Never send an oversized card, including unusually large ids or confirmation
/// metadata. Keep a bounded, actionable card instead of breaking message JSON.
fn checked(card: Value) -> Value {
    if encoded_len(&card) <= CARD_BYTES && visible_len(&card) <= MESSAGE_CHARS {
        card
    } else {
        self::card(
            "Taomni 回复",
            vec![div(
                "[已截断] 会话信息过大，请发送“列表”查看摘要，或使用手机页面。",
            )],
        )
    }
}
/// `show` buttons carry the private chat they were sent to; a callback from
/// any other chat (for example a forwarded card) is not a private query.
fn show_button(text: &str, id: &str, p2p_chat: &str) -> Value {
    callback(
        text,
        "default",
        json!({"action":"show","task_id":id,"p2p_chat_id":p2p_chat}),
    )
}
fn stop_button(id: &str) -> Value {
    let mut button = callback("停止", "danger", json!({"action":"stop","task_id":id}));
    button["confirm"] = json!({"title":label("停止当前轮次？"),"text":label(id)});
    button
}
fn stoppable(id: &str, status: &str) -> bool {
    id.starts_with("thread:") && matches!(status, "running" | "awaiting_confirmation")
}
fn session_buttons(
    config: &Config,
    id: &str,
    status: &str,
    p2p_chat: Option<&str>,
    show: &str,
) -> Vec<Value> {
    let mut buttons = vec![];
    if let Some(chat) = p2p_chat {
        buttons.push(show_button(show, id, chat));
    }
    if stoppable(id, status) {
        buttons.push(stop_button(id));
    }
    if let Some(url) = session_link(config, id) {
        buttons.push(open_button(&url));
    }
    buttons
}
/// Approve/reject buttons; the value shape predates the other card actions
/// and existing cards in chats still send it, so it must not change.
fn decision_buttons(task: &str, confirmation: &Value) -> Vec<Value> {
    [("同意", "approve"), ("拒绝", "reject")]
        .iter()
        .map(|(text, decision)| {
            callback(
                text,
                "default",
                json!({"task_id":task,"confirmation_id":confirmation["id"],"decision":decision}),
            )
        })
        .collect()
}

/// Session list card. `p2p_chat` is set only for replies to a private chat,
/// the only place where `查看` is allowed.
pub fn list(config: &Config, sessions: &[Value], p2p_chat: Option<&str>) -> Value {
    let mut rows: Vec<Vec<Value>> = vec![];
    let mut chars = 0;
    for session in sessions.iter().take(LIST_ROWS) {
        let id = session["id"].as_str().unwrap_or("");
        let status = session["status"].as_str().unwrap_or("");
        let line = format!(
            "{}. {} · {} · {}",
            rows.len() + 1,
            commands::short_id(id),
            clip(session["title"].as_str().unwrap_or(""), TITLE_CHARS),
            status_text(status)
        );
        chars += line.chars().count();
        if chars > BODY_CHARS {
            break;
        }
        let mut elements = vec![div(&line)];
        elements.extend(row(session_buttons(config, id, status, p2p_chat, "查看")));
        rows.push(elements);
    }
    loop {
        let mut elements: Vec<Value> = rows.iter().flatten().cloned().collect();
        if sessions.is_empty() {
            elements.push(div("暂无会话"));
        }
        let mut notes = vec![];
        if rows.len() < sessions.len() {
            notes.push(format!(
                "[已截断] 仅显示前 {} 个，共 {} 个。",
                rows.len(),
                sessions.len()
            ));
        }
        notes.push(if p2p_chat.is_some() {
            "点按钮，或回复“查看 <短id>”“停止 <短id>”。".into()
        } else {
            "内容查询仅限私聊；群聊指令需加 /taomni 前缀。".into()
        });
        let notes: Vec<Value> = notes
            .iter()
            .filter(|n| !n.is_empty())
            .map(|n| label(n))
            .collect();
        elements.push(json!({"tag":"note","elements":notes}));
        let value = card(&format!("Taomni 会话（{}）", sessions.len()), elements);
        if (encoded_len(&value) <= CARD_BYTES && visible_len(&value) <= MESSAGE_CHARS)
            || rows.is_empty()
        {
            return checked(value);
        }
        rows.pop();
    }
}

/// Session detail card for a resolved session. `body` is the text reply.
pub fn show(
    config: &Config,
    detail: &Value,
    short: &str,
    body: &str,
    p2p_chat: Option<&str>,
) -> Value {
    let id = detail["id"].as_str().unwrap_or("");
    let status = detail["status"].as_str().unwrap_or("");
    let mut elements = vec![div(&bounded(body))];
    let confirmations = detail["confirmations"].as_array().map(Vec::as_slice);
    for confirmation in confirmations
        .unwrap_or_default()
        .iter()
        .filter(|c| c["supported"] == true)
        .take(CONFIRMATION_ROWS)
    {
        let tool = clip(confirmation["tool"].as_str().unwrap_or("确认"), TITLE_CHARS);
        elements.push(div(&format!("待确认：{tool}")));
        elements.extend(row(decision_buttons(id, confirmation)));
    }
    elements.extend(row(session_buttons(config, id, status, p2p_chat, "查看")));
    let link = link_line(config, id);
    if !link.is_empty() {
        elements.push(div(link.trim()));
    }
    checked(card(&format!("Taomni 会话 {short}"), elements))
}

pub fn confirmation_card(config: &Config, task: &str, confirmation: &Value) -> Value {
    let text = format!(
        "{}\n{}",
        task,
        confirmation["tool"].as_str().unwrap_or("确认")
    );
    let mut elements = vec![div(&bounded(&text))];
    let url = session_link(config, task);
    let mut buttons = vec![];
    if confirmation["supported"] == true {
        buttons = decision_buttons(task, confirmation);
    } else {
        elements.push(div("需在桌面确认"));
    }
    buttons.extend(url.as_deref().map(open_button));
    elements.extend(row(buttons));
    if let Some(url) = url {
        elements.push(div(&format!("Mobile Web：{url}")));
    }
    checked(card("Taomni 等待确认", elements))
}

/// Canonical command for a non-decision card button, and whether the click
/// came from the private chat the button was sent to.
pub fn callback_command(value: &Value, chat: Option<&str>) -> Result<(String, bool), String> {
    let task = value["task_id"].as_str().ok_or("invalid_task")?;
    if task.is_empty()
        || task.chars().any(char::is_whitespace)
        || task.len() > 256
        || !(task
            .strip_prefix("thread:")
            .or_else(|| task.strip_prefix("term:")))
        .is_some_and(|raw| !raw.is_empty())
    {
        return Err("invalid_task".into());
    }
    let command = match value["action"].as_str() {
        Some("show") if task.starts_with("thread:") || task.starts_with("term:") => "show",
        Some("stop") if task.starts_with("thread:") => "stop",
        _ => return Err("invalid_card_action".into()),
    };
    let private =
        chat.is_some_and(|chat| !chat.is_empty() && value["p2p_chat_id"].as_str() == Some(chat));
    Ok((format!("{command} {task}"), private))
}
