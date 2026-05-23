pub mod path_scanner;

use path_scanner::PathScanner;
use std::sync::OnceLock;
use tauri::State;
use crate::state::AppState;

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
