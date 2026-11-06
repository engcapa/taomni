//! Text grammar and session-id resolution; never resolve by list position.
use serde_json::Value;

const PREFIX: &str = "/taomni";
const MIN_SHORT_ID: usize = 4;
const CANDIDATES: usize = 5;
const ACTIONS: [&str; 8] = [
    "help", "list", "show", "file", "send", "stop", "approve", "reject",
];
const ALIASES: [(&str, &str); 10] = [
    ("帮助", "help"),
    ("列表", "list"),
    ("查看", "show"),
    ("文件", "file"),
    ("发送", "send"),
    ("继续", "send"),
    ("停止", "stop"),
    ("同意", "approve"),
    ("批准", "approve"),
    ("拒绝", "reject"),
];
pub const HELP: &str = "Taomni 指令（私聊可省略 /taomni，群聊需加前缀）：
列表 / list
查看 <id> / show <id>：摘要、待确认与最近结果（仅私聊）
发送或继续 <id> <指令> / send <id> <指令>：Agent 后续轮次
停止 <id> / stop <id>
同意或批准 <id> <确认id> / approve <id> <确认id>
拒绝 <id> <确认id> / reject <id> <确认id>
文件 <id> <相对路径> / file <id> <相对路径>（仅私聊，需在设置中开启）
帮助 / help（或单独 /taomni）
<id> 可用完整 id、thread:<前缀>、term:<前缀>，或至少 4 字符的裸前缀。
列表显示前 8 字符短 id；有歧义时多输入几位，不接受列表序号。
发送/停止/同意/拒绝仅限 Agent 线程，不支持 PTY 输入。";
pub const UNKNOWN: &str = "未识别的指令。发送“帮助”查看可用指令（群聊请发送 /taomni 帮助）。";

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

/// Any Unicode whitespace separates tokens; runs collapse to an ASCII space.
/// Private unknown text still becomes a request so dispatch can reply with help.
pub fn normalize(text: &str, private_chat: bool) -> Option<String> {
    let mut words = text.split_whitespace().peekable();
    let prefixed = words
        .peek()
        .is_some_and(|word| word.eq_ignore_ascii_case(PREFIX));
    if prefixed {
        words.next();
    } else if !private_chat {
        return None;
    }
    let Some(word) = words.next() else {
        return Some("help".into());
    };
    let mut command = canonical(word).unwrap_or(word).to_owned();
    for word in words {
        command.push(' ');
        command.push_str(word);
    }
    Some(command)
}

pub fn usage(action: &str) -> String {
    let form = match action {
        "show" => "查看 <短id>",
        "file" => "文件 <短id> <相对路径>",
        "send" => "发送 <短id> <指令>",
        "stop" => "停止 <短id>",
        "approve" => "同意 <短id> <确认id>",
        _ => "拒绝 <短id> <确认id>",
    };
    format!("缺少会话 id。用法：{form}；发送“列表”查看短 id。")
}

fn raw(id: &str) -> &str {
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
