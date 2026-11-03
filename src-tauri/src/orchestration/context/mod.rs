use super::core::model::{AgentSource, ContextPreview, digest};
use std::collections::HashSet;
use std::path::{Component, Path};

const MAX_SOURCE_BYTES: u64 = 256 * 1024;
const MAX_TOTAL_BYTES: usize = 2 * 1024 * 1024;

pub fn compile(project: &str, paths: &[String]) -> Result<ContextPreview, String> {
    if project.trim().is_empty() {
        return Err("PROJECT_REQUIRED: select a project folder".into());
    }
    let root = std::fs::canonicalize(project)
        .map_err(|_| "PROJECT_UNAVAILABLE: project folder cannot be read")?;
    if !root.is_dir() {
        return Err("PROJECT_REQUIRED: expected a folder".into());
    }
    if paths.len() > 24 {
        return Err("CONTEXT_LIMIT: select at most 24 files".into());
    }
    let mut selected = vec!["AGENTS.md".to_string()];
    selected.extend(paths.iter().cloned());
    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    let mut warnings = Vec::new();
    let mut total = 0;
    for relative in selected {
        let path = Path::new(&relative);
        if path.is_absolute()
            || path
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("CONTEXT_OUTSIDE_PROJECT: use project-relative file paths".into());
        }
        let lower = relative.to_lowercase();
        if lower.split(['/', '\\']).any(|part| {
            matches!(part, ".git" | ".ssh" | "node_modules" | "target")
                || part == ".env"
                || part.starts_with(".env.")
        }) || lower.ends_with(".pem")
            || lower.ends_with(".key")
        {
            return Err("SENSITIVE_CONTEXT: this source is not allowed".into());
        }
        let file = root.join(path);
        if !file.exists() && relative == "AGENTS.md" {
            warnings
                .push("No project AGENTS.md found; no repository rules were fabricated.".into());
            continue;
        }
        let canonical =
            std::fs::canonicalize(&file).map_err(|_| format!("CONTEXT_MISSING: {relative}"))?;
        if !canonical.starts_with(&root) {
            return Err("CONTEXT_OUTSIDE_PROJECT: symlink escapes project".into());
        }
        if !seen.insert(canonical.clone()) {
            continue;
        }
        let metadata = std::fs::metadata(&canonical).map_err(|_| "CONTEXT_UNAVAILABLE")?;
        if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
            return Err(format!(
                "CONTEXT_LIMIT: {relative} is not a bounded text file"
            ));
        }
        let bytes = std::fs::read(&canonical).map_err(|_| "CONTEXT_UNAVAILABLE")?;
        if bytes.contains(&0) {
            return Err("CONTEXT_BINARY: binary files are not supported".into());
        }
        let text =
            String::from_utf8(bytes.clone()).map_err(|_| "CONTEXT_ENCODING: expected UTF-8")?;
        total += bytes.len();
        if total > MAX_TOTAL_BYTES {
            return Err("CONTEXT_LIMIT: required context exceeds the configured size".into());
        }
        let (content, redacted) = crate::chat::redact::redact(&text);
        if redacted > 0 {
            warnings.push(format!("Secrets were redacted from {relative}"));
        }
        sources.push(AgentSource {
            id: format!("src-{}", sources.len() + 1),
            path: relative,
            hash: digest(content.as_bytes()),
            content,
        });
    }
    Ok(ContextPreview {
        sources,
        estimated_input_tokens: (total as u64).div_ceil(3),
        estimate_method: "conservative_utf8_bytes_div_3_not_model_tokenizer".into(),
        warnings,
    })
}

mod prompt;

pub use prompt::{PreparedPack, prepare};

#[cfg(test)]
mod tests;
