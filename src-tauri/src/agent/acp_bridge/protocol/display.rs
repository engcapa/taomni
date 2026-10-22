use super::update_model::AcpGeneratedMedia;
use super::updates::TOOL_DISPLAY_INPUT_KEYS;
use serde_json::Value;

pub(super) fn tool_display_key_looks_secret(key: &str) -> bool {
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
}

/// Build a display-safe JSON object summarizing a tool_call for the chat UI.
///
/// Pulls only allowlisted scalar fields from `rawInput` / nested wrappers, plus
/// file paths from `locations`. Arbitrary values (and anything that looks like
/// a secret key) are dropped so credentials never enter the transcript.
pub(super) fn tool_call_display_input(update: &Value) -> Value {
    let mut out = serde_json::Map::new();

    if let Some(kind) = update
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        out.insert(
            "kind".into(),
            Value::String(truncate_display_text(kind, 80)),
        );
    }

    // Prefer explicit file locations the agent already intends the client to follow.
    if let Some(locations) = update.get("locations").and_then(Value::as_array) {
        let paths: Vec<Value> = locations
            .iter()
            .filter_map(|loc| {
                loc.get("path")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .map(|p| Value::String(truncate_display_text(p, 240)))
            })
            .take(4)
            .collect();
        if !paths.is_empty() {
            // Single path is the common case — surface as `path` for the
            // existing summary helper; multiple become a short list.
            if paths.len() == 1 {
                out.insert("path".into(), paths[0].clone());
            } else {
                out.insert("path".into(), Value::Array(paths));
            }
        }
    }

    // Text content blocks (e.g. a short description of what the tool will do).
    if let Some(text) = first_tool_content_text(update.get("content")) {
        out.entry("description".to_string())
            .or_insert_with(|| Value::String(text));
    }

    if let Some(raw) = update
        .get("rawInput")
        .or_else(|| update.get("raw_input"))
        .and_then(Value::as_object)
    {
        merge_allowlisted_tool_fields(&mut out, raw);
        // Nested MCP / dispatcher wrappers.
        for nest in ["arguments", "input", "params"] {
            if let Some(nested) = raw.get(nest).and_then(Value::as_object) {
                merge_allowlisted_tool_fields(&mut out, nested);
            }
        }
    }

    if out.is_empty() {
        Value::Null
    } else {
        Value::Object(out)
    }
}

pub(super) fn merge_allowlisted_tool_fields(
    out: &mut serde_json::Map<String, Value>,
    raw: &serde_json::Map<String, Value>,
) {
    for key in TOOL_DISPLAY_INPUT_KEYS {
        if tool_display_key_looks_secret(key) {
            continue;
        }
        if out.contains_key(*key) {
            continue;
        }
        let Some(value) = raw.get(*key) else {
            continue;
        };
        match value {
            Value::String(s) => {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    out.insert(
                        (*key).to_string(),
                        Value::String(truncate_display_text(trimmed, 200)),
                    );
                }
            }
            Value::Number(n) => {
                out.insert((*key).to_string(), Value::Number(n.clone()));
            }
            Value::Bool(b) => {
                out.insert((*key).to_string(), Value::Bool(*b));
            }
            _ => {}
        }
    }
}

/// Prefer human-readable content blocks over a bare status string for tool results.
pub(super) fn tool_call_display_output(update: &Value, status: &str) -> String {
    if let Some(text) = first_tool_content_text(update.get("content")) {
        return text;
    }

    // Safe scalar previews from rawOutput (never dump the whole object).
    if let Some(raw) = update
        .get("rawOutput")
        .or_else(|| update.get("raw_output"))
        .and_then(Value::as_object)
    {
        for key in [
            "message", "summary", "text", "output", "result", "stdout", "path", "error",
        ] {
            if let Some(s) = raw
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return truncate_display_text(s, 240);
            }
        }
    }

    // Locations updated by the tool (e.g. written files).
    if let Some(locations) = update.get("locations").and_then(Value::as_array) {
        let paths: Vec<&str> = locations
            .iter()
            .filter_map(|loc| {
                loc.get("path")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
            })
            .take(3)
            .collect();
        if !paths.is_empty() {
            return truncate_display_text(&paths.join(", "), 240);
        }
    }

    status.to_string()
}

/// First non-empty text content block from a tool_call content array.
pub(super) fn first_tool_content_text(content: Option<&Value>) -> Option<String> {
    let items = content.and_then(Value::as_array)?;
    for item in items {
        let obj = item.as_object()?;
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("content");
        // Skip diffs (can be huge) and media; keep plain text / content.
        if matches!(
            kind,
            "diff" | "terminal" | "image" | "audio" | "resource_link"
        ) {
            continue;
        }
        if let Some(text) = obj
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            return Some(truncate_display_text(text, 240));
        }
        // content: { type: "content", content: { type: "text", text: "..." } }
        if let Some(nested) = obj
            .get("content")
            .and_then(Value::as_object)
            .and_then(|c| c.get("text"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            return Some(truncate_display_text(nested, 240));
        }
    }
    None
}

/// Extract a completed tool's local output path without preserving arbitrary
/// tool output. Grok's image and video tools place their saved artifact at
/// `rawOutput.path`; treating the path only as a candidate keeps this generic
/// and lets the chat media adapter validate MIME type, size, and regular-file
/// status before copying it into Taomni storage.
pub(super) fn parse_generated_media(
    update: &Value,
    update_type: &str,
) -> Option<AcpGeneratedMedia> {
    if update_type != "tool_call_update"
        || update.get("status").and_then(Value::as_str) != Some("completed")
    {
        return None;
    }
    let path = update
        .get("rawOutput")
        .or_else(|| update.get("raw_output"))
        .and_then(Value::as_object)
        .and_then(|output| output.get("path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty() && path.len() <= 32 * 1024)?;
    Some(AcpGeneratedMedia {
        path: path.to_string(),
    })
}

pub(in crate::agent::acp_bridge) fn truncate_display_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}
