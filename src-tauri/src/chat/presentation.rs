use super::*;

/// Keys that almost always carry secrets — never surface their values in the UI.
pub(super) fn tool_arg_key_looks_secret(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("password")
        || lower.contains("passwd")
        || lower.contains("secret")
        || lower.contains("token")
        || lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("authorization")
        || lower.contains("credential")
        || lower.contains("cookie")
        || lower.contains("private_key")
        || lower == "key"
        || lower.ends_with("_key")
        || lower.ends_with("key") && lower.contains("auth")
}

/// Flatten a JSON value into a short, single-line display string.
pub(super) fn tool_arg_value_preview(
    value: &serde_json::Value,
    max_chars: usize,
) -> Option<String> {
    let raw = match value {
        serde_json::Value::String(s) => s.trim().to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Array(items) if !items.is_empty() && items.len() <= 6 => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|item| tool_arg_value_preview(item, max_chars / items.len().max(1)))
                .collect();
            if parts.is_empty() {
                return None;
            }
            parts.join(", ")
        }
        _ => return None,
    };
    if raw.is_empty() {
        return None;
    }
    Some(truncate_display_chars(&raw, max_chars))
}

pub(super) fn truncate_display_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

/// The one-line argument summary for a tool call ("ls -la", query text, path…).
///
/// Returns an owned string so nested / multi-key summaries can be composed.
/// Only allowlisted, non-secret scalar fields are considered — never dump the
/// whole JSON object (which may contain credentials).
pub(super) fn cc_tool_arg_summary(input: &serde_json::Value) -> Option<String> {
    let obj = input.as_object()?;
    if obj.is_empty() {
        return None;
    }

    // Prefer a single high-signal field when present.
    for key in TOOL_ARG_SUMMARY_KEYS {
        if tool_arg_key_looks_secret(key) {
            continue;
        }
        if let Some(preview) = obj.get(*key).and_then(|v| tool_arg_value_preview(v, 160)) {
            // For nested MCP dispatchers, also surface the nested tool name.
            if matches!(*key, "tool" | "tool_name" | "toolName" | "name") {
                if let Some(nested) = obj
                    .get("arguments")
                    .or_else(|| obj.get("input"))
                    .or_else(|| obj.get("params"))
                    .and_then(cc_tool_arg_summary)
                {
                    return Some(format!("{preview} · {nested}"));
                }
            }
            return Some(preview);
        }
    }

    // Nested wrappers: use_tool / CallMcpTool often put real args one level down.
    for nest_key in ["arguments", "input", "params", "rawInput", "raw_input"] {
        if let Some(nested) = obj.get(nest_key).and_then(cc_tool_arg_summary) {
            return Some(nested);
        }
    }

    // Fallback: join up to three allowlisted non-secret fields as `k=v`.
    let mut parts = Vec::new();
    for (key, value) in obj {
        if tool_arg_key_looks_secret(key) {
            continue;
        }
        if !TOOL_ARG_SUMMARY_KEYS
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(key))
        {
            continue;
        }
        if let Some(preview) = tool_arg_value_preview(value, 80) {
            parts.push(format!("{key}={preview}"));
        }
        if parts.len() >= 3 {
            break;
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}

/// Render a CC tool-use event as a compact, human-readable transcript line.
///
/// This is *not* a `[TOOL_CALL]` marker — it carries no machine-parseable JSON,
/// so MessageBubble never turns it into an ActionCard or re-executes it. It
/// exists purely so the chat keeps a record of what Claude Code did (the real
/// confirmation happens live via the in-app MCP server's permission prompt).
pub(super) fn format_cc_tool_use(name: &str, input: &serde_json::Value) -> String {
    match cc_tool_arg_summary(input) {
        Some(s) => format!("\n> 🔧 `{}` — {}\n", name, s),
        None => format!("\n> 🔧 `{}`\n", name),
    }
}

/// A short, single-line preview of a tool result for the transcript /
/// display card (collapses whitespace, truncates).
pub(super) fn cc_tool_result_preview(content: &str) -> String {
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    // Status-only strings from ACP ("completed"/"failed") are low signal —
    // keep them short; richer tool output gets a longer preview.
    let max = if flat.eq_ignore_ascii_case("completed")
        || flat.eq_ignore_ascii_case("failed")
        || flat.eq_ignore_ascii_case("ok")
    {
        32
    } else {
        240
    };
    truncate_display_chars(&flat, max)
}
