//! Text grammar and session-id resolution; never resolve by list position.
use serde_json::Value;

const PREFIX: &str = "/taomni";
const MIN_SHORT_ID: usize = 4;
const CANDIDATES: usize = 5;
const ACTIONS: [&str; 14] = [
    "help", "list", "term", "show", "file", "input", "key", "saved", "open", "new", "send", "stop",
    "approve", "reject",
];
const ALIASES: [(&str, &str); 20] = [
    ("帮助", "help"),
    ("列表", "list"),
    ("终端", "term"),
    ("查看", "show"),
    ("文件", "file"),
    ("输入", "input"),
    ("按键", "key"),
    ("保存", "saved"),
    ("已保存", "saved"),
    ("打开", "open"),
    ("新建", "new"),
    ("新开", "new"),
    ("发送", "send"),
    ("继续", "send"),
    ("停止", "stop"),
    ("同意", "approve"),
    ("批准", "approve"),
    ("拒绝", "reject"),
    ("查看终端", "term"),
    ("输入文本", "input"),
];
pub const HELP: &str = "Taomni 指令（私聊可省略 /taomni，群聊需加前缀）：
终端 / term <id>：查看终端输出并自动跟随刷新（仅私聊）
输入 / input <文本>：向当前终端发送文本并回车
输入 <id> <文本>：向指定终端发送
按键 / key <按键>：向当前终端发送 Enter、Ctrl-C、Tab、Esc 或方向键
保存 / saved：列出可远程打开的已保存会话
打开 / open <id 或名称>：在桌面打开已保存会话并返回新终端
新建 / new：在桌面新建本地终端
列表 / list：终端与 Agent 会话列表
查看 <id> / show <id>：终端输出或 Agent 摘要（仅私聊）
发送或继续 <id> <指令> / send <id> <指令>：Agent 后续轮次
停止 <id> / stop <id>：停止 Agent 轮次
同意或批准 <id> <确认id> / approve <id> <确认id>
拒绝 <id> <确认id> / reject <id> <确认id>
文件 <id> <相对路径> / file <id> <相对路径>（仅私聊，需在设置中开启）
帮助 / help（或单独 /taomni）
<id> 可用完整 id、thread:<前缀>、term:<前缀>，或至少 4 字符的裸前缀。
终端与 Agent 都显示前 8 字符短 id；有歧义时多输入几位，不接受列表序号。
终端相关内容（输出、输入、打开会话）仅限已绑定私聊。";
pub const UNKNOWN: &str = "未识别的指令。发送“帮助”查看可用指令（群聊请发送 /taomni 帮助）。";

#[derive(Debug, PartialEq)]
pub struct Invocation {
    pub command: String,
    /// Verbatim text after the action token, leading whitespace trimmed.
    pub after_action: String,
    /// Verbatim text after the action and target tokens, leading whitespace
    /// trimmed. Terminal input uses this so spacing is not collapsed.
    pub after_target: String,
}

fn canonical(word: &str) -> Option<&'static str> {
    ACTIONS
        .into_iter()
        .find(|action| action.eq_ignore_ascii_case(word))
        .or_else(|| {
            ALIASES
                .into_iter()
                .find(|(alias, _)| *alias == word)
                .map(|(_, action)| action)
        })
}

fn spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start = None;
    for (index, ch) in text.char_indices() {
        if ch.is_whitespace() {
            if let Some(from) = start.take() {
                spans.push((from, index));
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    if let Some(from) = start {
        spans.push((from, text.len()));
    }
    spans
}

/// Any Unicode whitespace separates tokens; runs collapse to an ASCII space.
/// Private unknown text still becomes a request so dispatch can reply with help.
/// The verbatim remainders let terminal input keep spaces and newlines.
pub fn parse(text: &str, private_chat: bool) -> Option<Invocation> {
    let spans = spans(text);
    let start = if spans
        .first()
        .is_some_and(|(from, to)| text[*from..*to].eq_ignore_ascii_case(PREFIX))
    {
        1
    } else if private_chat {
        0
    } else {
        return None;
    };
    let Some(&(first_from, first_to)) = spans.get(start) else {
        return Some(Invocation {
            command: "help".into(),
            after_action: String::new(),
            after_target: String::new(),
        });
    };
    let action = canonical(&text[first_from..first_to])
        .unwrap_or(&text[first_from..first_to])
        .to_owned();
    let mut command = action;
    for (from, to) in &spans[start + 1..] {
        command.push(' ');
        command.push_str(&text[*from..*to]);
    }
    let after_action = text[first_to..].trim_start().to_owned();
    let after_target = spans
        .get(start + 1)
        .map_or("", |(_, to)| text[*to..].trim_start())
        .to_owned();
    Some(Invocation {
        command,
        after_action,
        after_target,
    })
}

pub fn normalize(text: &str, private_chat: bool) -> Option<String> {
    parse(text, private_chat).map(|invocation| invocation.command)
}

pub fn usage(action: &str) -> String {
    let form = match action {
        "term" => "终端 <短id>",
        "input" => "输入 <文本>（或 输入 <短id> <文本>）",
        "key" => "按键 <Enter|Ctrl-C|Tab|Esc|Up|Down|Left|Right|Backspace>",
        "open" => "打开 <已保存会话短id或名称>",
        "show" => "查看 <短id>",
        "file" => "文件 <短id> <相对路径>",
        "send" => "发送 <短id> <指令>",
        "stop" => "停止 <短id>",
        "approve" => "同意 <短id> <确认id>",
        _ => "拒绝 <短id> <确认id>",
    };
    format!("缺少会话 id。用法：{form}；发送“列表”或“帮助”查看更多。")
}

pub fn raw(id: &str) -> &str {
    id.strip_prefix("thread:")
        .or_else(|| id.strip_prefix("term:"))
        .unwrap_or(id)
}
pub fn short_id(id: &str) -> String {
    raw(id).chars().take(8).collect()
}
fn not_found(input: &str) -> String {
    format!("未找到 id 为「{input}」的会话。发送“列表”查看当前会话。")
}

/// All ids, including full kind-prefixed ids, must match the current list.
/// Bare prefixes require at least four characters; an explicit kind scopes
/// shorter prefixes. Exact ids take priority over longer prefix matches.
pub fn resolve(sessions: &[Value], input: &str) -> Result<String, String> {
    let kind = ["thread:", "term:"]
        .into_iter()
        .find(|kind| input.starts_with(kind));
    let needle = kind.map_or(input, |kind| &input[kind.len()..]);
    if kind.is_none() && needle.chars().count() < MIN_SHORT_ID {
        return Err(format!(
            "短 id 至少 {MIN_SHORT_ID} 个字符：「{input}」。发送“列表”查看。"
        ));
    }
    if needle.is_empty() {
        return Err(not_found(input));
    }
    let scoped: Vec<(&str, &str)> = sessions
        .iter()
        .filter_map(|s| {
            let id = s["id"].as_str()?;
            kind.is_none_or(|kind| id.starts_with(kind))
                .then_some((id, s["title"].as_str().unwrap_or("")))
        })
        .collect();
    let exact: Vec<_> = scoped
        .iter()
        .copied()
        .filter(|(id, _)| raw(id) == needle)
        .collect();
    let matches: Vec<_> = if exact.is_empty() {
        scoped
            .into_iter()
            .filter(|(id, _)| raw(id).starts_with(needle))
            .collect()
    } else {
        exact
    };
    match matches.as_slice() {
        [(id, _)] => Ok((*id).into()),
        [] => Err(not_found(input)),
        _ => Err(ambiguous(input, &matches)),
    }
}

fn ambiguous(input: &str, matches: &[(&str, &str)]) -> String {
    let mut text = format!(
        "id「{input}」匹配到 {} 个会话，请多输入几位或使用完整 id：",
        matches.len()
    );
    for (id, title) in matches.iter().take(CANDIDATES) {
        let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
        let title: String = title.chars().take(40).collect();
        let kind = if id.starts_with("thread:") {
            "thread"
        } else {
            "term"
        };
        text.push_str(&format!("\n{} · {title}（{kind}）", short_id(id)));
    }
    if matches.len() > CANDIDATES {
        text.push_str(&format!("\n……仅列出前 {CANDIDATES} 个"));
    }
    text
}

/// Saved sessions are resolved by exact id, exact name, then id/name prefix.
/// Names are what the chat user remembers, so they take part in matching.
pub fn resolve_saved(sessions: &[Value], input: &str) -> Result<String, String> {
    let needle = input.trim();
    if needle.is_empty() {
        return Err("缺少已保存会话。发送“保存”查看列表。".into());
    }
    let value = |s: &Value, key: &str| s[key].as_str().unwrap_or("").to_owned();
    let exact_id: Vec<(String, String)> = sessions
        .iter()
        .filter(|s| value(s, "id") == needle)
        .map(|s| (value(s, "id"), value(s, "name")))
        .collect();
    if let [(id, _)] = exact_id.as_slice() {
        return Ok(id.clone());
    }
    let lower = needle.to_lowercase();
    let exact_name: Vec<(String, String)> = sessions
        .iter()
        .filter(|s| value(s, "name").to_lowercase() == lower)
        .map(|s| (value(s, "id"), value(s, "name")))
        .collect();
    if let [(id, _)] = exact_name.as_slice() {
        return Ok(id.clone());
    }
    let id_prefix = needle.chars().count() >= MIN_SHORT_ID;
    let name_prefix = needle.chars().count() >= 2;
    if !id_prefix && !name_prefix {
        return Err(format!(
            "已保存会话短 id 至少 {MIN_SHORT_ID} 个字符、名称至少 2 个字符：「{input}」。"
        ));
    }
    let matches: Vec<(String, String)> = sessions
        .iter()
        .filter(|s| {
            (id_prefix && raw(&value(s, "id")).starts_with(needle))
                || (name_prefix && value(s, "name").to_lowercase().starts_with(&lower))
        })
        .map(|s| (value(s, "id"), value(s, "name")))
        .collect();
    match matches.as_slice() {
        [(id, _)] => Ok(id.clone()),
        [] => Err(format!("未找到已保存会话「{input}」。发送“保存”查看列表。")),
        _ => {
            let mut text = format!(
                "「{input}」匹配到 {} 个已保存会话，请多输入几位：",
                matches.len()
            );
            for (id, name) in matches.iter().take(CANDIDATES) {
                let name: String = name.chars().take(40).collect();
                text.push_str(&format!("\n{} · {name}", short_id(id)));
            }
            Err(text)
        }
    }
}

/// Keyboard shortcuts accepted by `按键`; the byte sequences are what a
/// terminal expects for the same physical key.
pub fn key_bytes(name: &str) -> Option<&'static [u8]> {
    Some(match name.to_ascii_lowercase().as_str() {
        "enter" | "return" | "回车" => b"\r",
        "tab" | "制表" => b"\t",
        "esc" | "escape" | "退出" => b"\x1b",
        "backspace" | "退格" => b"\x7f",
        "ctrl-c" | "ctrlc" | "ctrl+c" | "中断" => b"\x03",
        "ctrl-d" | "ctrld" | "ctrl+d" => b"\x04",
        "ctrl-z" | "ctrlz" | "ctrl+z" => b"\x1a",
        "up" | "上" => b"\x1b[A",
        "down" | "下" => b"\x1b[B",
        "right" | "右" => b"\x1b[C",
        "left" | "左" => b"\x1b[D",
        _ => return None,
    })
}
