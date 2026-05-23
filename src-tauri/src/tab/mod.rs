pub mod fim_engine;
pub mod path_scanner;

use path_scanner::PathScanner;
use std::sync::OnceLock;

static PATH_SCANNER: OnceLock<PathScanner> = OnceLock::new();

fn scanner() -> &'static PathScanner {
    PATH_SCANNER.get_or_init(PathScanner::new)
}

/// Suggest completions for a command-line prefix.
/// - If prefix has no path separator: match executables from $PATH
/// - If prefix contains '/' or starts with '.': match files in cwd
/// Returns up to 20 matches, sorted by relevance.
#[tauri::command]
pub async fn tab_suggest_path(
    prefix: String,
    cwd: Option<String>,
    is_local: bool,
) -> Result<Vec<String>, String> {
    if !is_local || prefix.is_empty() {
        return Ok(vec![]);
    }

    let sc = scanner();

    // File path completion: prefix contains a slash or starts with . or ~
    if prefix.contains('/') || prefix.contains('\\')
        || prefix.starts_with('.') || prefix.starts_with('~')
    {
        let dir = cwd.as_deref().unwrap_or(".");
        return Ok(sc.match_files(&prefix, dir, 20));
    }

    // First token: executable completion from $PATH
    // Only apply when prefix looks like the start of a command (no spaces yet)
    if !prefix.contains(' ') {
        return Ok(sc.match_executables(&prefix, 20));
    }

    // After first token: try to complete the last word as a file path
    if let Some(last_word) = prefix.split_whitespace().last() {
        if !last_word.is_empty() {
            let dir = cwd.as_deref().unwrap_or(".");
            let matches = sc.match_files(last_word, dir, 20);
            // Return full command with last word replaced
            let prefix_without_last = &prefix[..prefix.rfind(last_word).unwrap_or(prefix.len())];
            return Ok(matches.into_iter()
                .map(|m| format!("{}{}", prefix_without_last, m))
                .collect());
        }
    }

    Ok(vec![])
}

/// Fill-in-the-middle completion for the current command line.
///
/// `prefix` is what's been typed so far; `recent_history` is up to 5 most
/// recent (already-redacted) commands for context. Returns at most ~24 tokens
/// of continuation, or `None` when no completion is appropriate.
///
/// Routes through the LLM router using `TaskKind::TabCompletion`. By default
/// that points at the local sidecar — but if the sidecar isn't installed and
/// the user has a cloud provider configured, we still get a useful answer.
#[tauri::command]
pub async fn tab_suggest_fim(
    prefix: String,
    recent_history: Vec<String>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Option<String>, String> {
    use crate::llm::{ChatMessage, ChatRequest, TaskKind};

    if prefix.trim().is_empty() {
        return Ok(None);
    }

    // Cheap heuristic: don't ask the LLM for prefixes shorter than 3 chars.
    if prefix.len() < 3 {
        return Ok(None);
    }

    let ai_ctx = state.ai_ctx.read().await;
    if ai_ctx.config.fully_disabled {
        return Ok(None);
    }

    let history_section = if recent_history.is_empty() {
        String::new()
    } else {
        format!("\n\n最近命令:\n{}", recent_history.join("\n"))
    };

    let req = ChatRequest {
        messages: vec![
            ChatMessage::system(
                "你是 shell 命令补全助手。用户正在输入一行命令，请只返回最合理的下一段，\
                 不要换行、不要解释、不要重复用户已输入的部分。如果没有把握，返回空字符串。",
            ),
            ChatMessage::user(format!("用户已输入: {prefix}{history_section}")),
        ],
        max_tokens: Some(24),
        temperature: Some(0.1),
        stream: false,
    };

    match ai_ctx.llm.complete(req, TaskKind::TabCompletion).await {
        Ok(resp) => {
            let text = resp.content.trim_matches(|c: char| c.is_whitespace() || c == '`').to_string();
            if text.is_empty() || text.len() > 80 {
                Ok(None)
            } else {
                Ok(Some(text))
            }
        }
        Err(e) => {
            tracing::debug!(?e, "tab_suggest_fim: LLM call failed");
            Ok(None)
        }
    }
}

/// AI-driven rewrite of an existing command.
/// Triggered by Ctrl+K. Goes through TaskKind::CommandRewrite (cloud by default).
#[tauri::command]
pub async fn tab_rewrite_command(
    current_command: String,
    instruction: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    use crate::llm::{ChatMessage, ChatRequest, TaskKind};

    let ai_ctx = state.ai_ctx.read().await;
    if ai_ctx.config.fully_disabled {
        return Err("AI is fully disabled.".into());
    }

    let req = ChatRequest {
        messages: vec![
            ChatMessage::system(
                "你是 shell 命令改写助手。根据用户的改写要求，给出修改后的命令。\
                 只返回最终命令文本，不要解释、不要 markdown 标记。",
            ),
            ChatMessage::user(format!(
                "当前命令:\n{current_command}\n\n改写要求:\n{instruction}"
            )),
        ],
        max_tokens: Some(120),
        temperature: Some(0.2),
        stream: false,
    };

    let resp = ai_ctx
        .llm
        .complete(req, TaskKind::CommandRewrite)
        .await
        .map_err(|e| e.to_string())?;

    Ok(resp
        .content
        .trim_matches(|c: char| c.is_whitespace() || c == '`')
        .to_string())
}

