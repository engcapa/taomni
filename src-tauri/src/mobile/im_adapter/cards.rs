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
const SAVED_ROWS: usize = 20;
const TITLE_CHARS: usize = 40;
const CONFIRMATION_ROWS: usize = 5;
const TERMINAL_LINES: usize = 18;
const TERMINAL_CHARS: usize = 1100;

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
/// Followed terminal cards must be shared cards before the adapter may update
/// them in place (`PATCH /im/v1/messages/:id` requires `update_multi`).
fn updatable_card(title: &str, elements: Vec<Value>) -> Value {
    json!({"config":{"wide_screen_mode":true,"update_multi":true},"header":{"title":label(title)},"elements":elements})
}
/// Never send an oversized card, including unusually large ids or confirmation
/// metadata. Keep a bounded, actionable card instead of breaking message JSON.
fn checked(card: Value) -> Value {
    if encoded_len(&card) <= CARD_BYTES && visible_len(&card) <= MESSAGE_CHARS {
        return card;
    }
    let updatable = card["config"]["update_multi"] == true;
    let mut fallback = self::card(
        "Taomni 回复",
        vec![div(
            "[已截断] 会话信息过大，请发送“列表”查看摘要，或使用手机页面。",
        )],
    );
    if updatable {
        fallback["config"]["update_multi"] = json!(true);
    }
    fallback
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

/// Terminal tail card. The same card is reused for one-off replies and for the
/// periodic in-place updates, so the adapter builds it from live broker state.
pub fn terminal(
    config: &Config,
    id: &str,
    title: &str,
    status: &str,
    tail: &str,
    following: bool,
    p2p_chat: Option<&str>,
) -> Value {
    let short = commands::short_id(id);
    let header = format!("{} · {}", clip(title, TITLE_CHARS), status_text(status));
    let body = if p2p_chat.is_none() {
        "终端输出仅限私聊。".to_owned()
    } else if tail.trim().is_empty() {
        "（暂无输出）".to_owned()
    } else {
        tail.chars().take(TERMINAL_CHARS).collect()
    };
    let mut elements = vec![div(&header), div(&body)];
    let mut buttons = vec![];
    if let Some(chat) = p2p_chat {
        buttons.push(callback(
            "刷新",
            "default",
            json!({"action":"term","op":"refresh","task_id":id,"p2p_chat_id":chat}),
        ));
        if following {
            buttons.push(callback(
                "停止跟随",
                "default",
                json!({"action":"term","op":"unfollow","task_id":id,"p2p_chat_id":chat}),
            ));
        }
        if status == "running" {
            buttons.push(callback(
                "Ctrl-C",
                "danger",
                json!({"action":"key","key":"ctrl-c","task_id":id,"p2p_chat_id":chat}),
            ));
        }
    }
    if let Some(url) = session_link(config, id) {
        buttons.push(open_button(&url));
    }
    elements.extend(row(buttons));
    elements.push(
        json!({"tag":"note","elements":[label(if p2p_chat.is_some() {
            "输入 <文本> 可直接发送到当前终端；回复里的终端卡片会短暂自动刷新。"
        } else {
            "终端输出与输入仅限私聊。"
        })]}),
    );
    checked(updatable_card(&format!("Taomni 终端 {short}"), elements))
}

/// Saved sessions that can be opened from the chat; opening creates a real
/// desktop tab and returns its `term:` id.
pub fn saved(config: &Config, sessions: &[Value], p2p_chat: Option<&str>) -> Value {
    let mut rows: Vec<Vec<Value>> = vec![];
    let mut chars = 0;
    let mut shown = 0;
    for session in sessions.iter().take(SAVED_ROWS) {
        let id = session["id"].as_str().unwrap_or("");
        let name = clip(session["name"].as_str().unwrap_or(""), TITLE_CHARS);
        let kind = session["session_type"].as_str().unwrap_or("");
        let line = format!(
            "{}. {} · {name} · {kind}",
            shown + 1,
            commands::short_id(id)
        );
        chars += line.chars().count();
        if chars > BODY_CHARS {
            break;
        }
        shown += 1;
        let mut elements = vec![div(&line)];
        if let Some(chat) = p2p_chat {
            elements.extend(row(vec![callback(
                "打开",
                "default",
                json!({"action":"open","saved_id":id,"p2p_chat_id":chat}),
            )]));
        }
        rows.push(elements);
    }
    let mut elements: Vec<Value> = rows.iter().flatten().cloned().collect();
    if sessions.is_empty() {
        elements.push(div("暂无已保存会话"));
    }
    let mut notes = vec![];
    if shown < sessions.len() {
        notes.push(format!(
            "[已截断] 仅显示前 {} 个，共 {} 个。",
            shown,
            sessions.len()
        ));
    }
    notes.push(if p2p_chat.is_some() {
        "“打开 <短id>”会在桌面新建终端；认证提示在桌面完成。".into()
    } else {
        "打开会话仅限私聊。".into()
    });
    if let Some(chat) = p2p_chat {
        elements.extend(row(vec![callback(
            "新建本地终端",
            "default",
            json!({"action":"new","p2p_chat_id":chat}),
        )]));
    }
    if !config.mobile_endpoint.is_empty() {
        elements.extend(row(vec![open_button(&format!(
            "{}/#/",
            config.mobile_endpoint.trim_end_matches('/')
        ))]));
    }
    let notes: Vec<Value> = notes.iter().map(|n| label(n)).collect();
    elements.push(json!({"tag":"note","elements":notes}));
    checked(card(
        &format!("Taomni 已保存会话（{}）", sessions.len()),
        elements,
    ))
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
    let task = || -> Result<&str, String> {
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
        Ok(task)
    };
    let command = match value["action"].as_str() {
        Some("show") => {
            let task = task()?;
            format!("show {task}")
        }
        Some("stop") => {
            let task = task()?;
            if !task.starts_with("thread:") {
                return Err("invalid_card_action".into());
            }
            format!("stop {task}")
        }
        Some("term") => {
            let task = task()?;
            if !task.starts_with("term:") {
                return Err("invalid_card_action".into());
            }
            match value["op"].as_str() {
                Some("refresh") => format!("term-refresh {task}"),
                Some("unfollow") => format!("term-unfollow {task}"),
                _ => return Err("invalid_card_action".into()),
            }
        }
        Some("key") => {
            let task = task()?;
            if !task.starts_with("term:") {
                return Err("invalid_card_action".into());
            }
            let key = value["key"]
                .as_str()
                .filter(|key| {
                    !key.is_empty() && key.len() <= 16 && !key.chars().any(char::is_whitespace)
                })
                .ok_or("invalid_card_action")?;
            format!("key {task} {key}")
        }
        Some("open") => {
            let saved = value["saved_id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 128)
                .ok_or("invalid_card_action")?;
            if saved.chars().any(char::is_whitespace) {
                return Err("invalid_card_action".into());
            }
            format!("open {saved}")
        }
        Some("new") => "new".into(),
        Some("saved") => "saved".into(),
        _ => return Err("invalid_card_action".into()),
    };
    let private =
        chat.is_some_and(|chat| !chat.is_empty() && value["p2p_chat_id"].as_str() == Some(chat));
    Ok((command, private))
}
