use super::*;

pub(super) fn append_agent_context_to_system_prompt(
    mut system_prompt: String,
    agent_ctx: &crate::agent::context::AgentThreadContext,
) -> String {
    let mut block = String::new();
    if !agent_ctx.session_card.trim().is_empty() {
        block.push_str(agent_ctx.session_card.trim());
        block.push('\n');
    }
    if let Some(cwd) = agent_ctx
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let (clean_cwd, _) = redact::redact(cwd);
        block.push_str(&format!("Current working directory: {clean_cwd}\n"));
    }
    if let Some(code_block) = code_workspace_context_block(agent_ctx) {
        block.push_str(code_block.trim_end());
        block.push('\n');
    }
    if agent_ctx.bound_db_connection_id.is_some() {
        block.push_str("Database binding: active for SQL/Redis tools.\n");
    }
    if let Some(line) = selected_objects_context_line(agent_ctx) {
        block.push_str(&line);
    }
    if block.trim().is_empty() {
        return system_prompt;
    }
    system_prompt.push_str("\n\n[Taomni runtime context]\n");
    system_prompt.push_str(block.trim_end());
    system_prompt
}

pub(super) fn selected_objects_context_line(
    agent_ctx: &crate::agent::context::AgentThreadContext,
) -> Option<String> {
    let objects =
        crate::agent::context::normalize_selected_objects(&agent_ctx.bound_db_selected_objects);
    if objects.is_empty() {
        return None;
    }
    let selected = objects
        .iter()
        .take(10)
        .map(|object| format!("{} [{}]", object.display_name(), object.kind))
        .collect::<Vec<_>>()
        .join(", ");
    let selectable = objects
        .iter()
        .filter(|object| object.is_selectable())
        .take(10)
        .map(|object| format!("{} [{}]", object.display_name(), object.kind))
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if objects.len() > 10 { ", ..." } else { "" };
    let mut line = format!("Database selected objects: {selected}{suffix}\n");
    if selectable.is_empty() {
        line.push_str("Database selected queryable objects: (none)\n");
    } else {
        line.push_str(&format!(
            "Database selected queryable objects: {selectable}{suffix}\n"
        ));
    }
    Some(line)
}

pub(super) fn code_workspace_context_block(
    agent_ctx: &crate::agent::context::AgentThreadContext,
) -> Option<String> {
    let workspace = agent_ctx
        .code_workspace
        .as_ref()
        .and_then(crate::agent::context::AgentCodeWorkspace::normalized)?;
    let mut lines = vec!["Code workspace:".to_string()];
    if !workspace.roots.is_empty() {
        lines.push("Roots:".into());
        for root in &workspace.roots {
            let (path, _) = redact::redact(&root.path);
            lines.push(format!(
                "- {} [{}]: {}",
                root.name,
                root.kind.as_deref().unwrap_or("folder"),
                path
            ));
        }
    } else if !workspace.repo_root.is_empty() {
        let (repo_root, _) = redact::redact(&workspace.repo_root);
        lines.push(format!("Root: {repo_root}"));
    }
    if !workspace.loose_files.is_empty() {
        lines.push("Loose files:".into());
        for file in &workspace.loose_files {
            let (path, _) = redact::redact(&file.path);
            let name = file.name.as_deref().unwrap_or(&file.id);
            lines.push(format!("- {name}: {path}"));
        }
    }
    if let Some(active_file) = workspace.active_file.as_ref() {
        lines.push(format!(
            "Code active file: {}",
            format_code_workspace_file(active_file)
        ));
    } else if let Some(active_path) = workspace.active_path.as_deref() {
        lines.push(format!("Code active file: {active_path}"));
    }
    if !workspace.open_files.is_empty() {
        lines.push(format!(
            "Code open files: {}",
            format_code_workspace_files(&workspace.open_files)
        ));
    } else if !workspace.open_paths.is_empty() {
        lines.push(format!(
            "Code open files: {}",
            format_code_workspace_paths(&workspace.open_paths)
        ));
    }
    if !workspace.dirty_files.is_empty() {
        lines.push(format!(
            "Code unsaved files: {}",
            format_code_workspace_files(&workspace.dirty_files)
        ));
    } else if !workspace.dirty_paths.is_empty() {
        lines.push(format!(
            "Code unsaved files: {}",
            format_code_workspace_paths(&workspace.dirty_paths)
        ));
    }
    if let Some(lsp) = workspace.lsp.as_ref() {
        if let Some(status) = lsp.active_status.as_ref() {
            let name = status
                .display_name
                .as_deref()
                .or(status.language_id.as_deref())
                .unwrap_or("language server");
            let state = if status.active {
                "active"
            } else if status.available {
                "available"
            } else {
                "missing"
            };
            let command = status
                .selected_command
                .as_deref()
                .map(|cmd| format!(" via {cmd}"))
                .unwrap_or_default();
            lines.push(format!("Code LSP: {name} {state}{command}"));
            if !status.active {
                if let Some(hint) = status.install_hint.as_deref() {
                    lines.push(format!("Code LSP install hint: {hint}"));
                } else if let Some(error) = status.error.as_deref() {
                    lines.push(format!("Code LSP issue: {error}"));
                }
            }
        }
        if !lsp.diagnostics.is_empty() {
            lines.push("Code diagnostics:".into());
            for diagnostic in lsp.diagnostics.iter().take(12) {
                let file = format_code_workspace_file(&diagnostic.file);
                let mut counts = Vec::new();
                if diagnostic.error_count > 0 {
                    counts.push(format!("{} error(s)", diagnostic.error_count));
                }
                if diagnostic.warning_count > 0 {
                    counts.push(format!("{} warning(s)", diagnostic.warning_count));
                }
                if diagnostic.info_count > 0 {
                    counts.push(format!("{} info/hint", diagnostic.info_count));
                }
                let counts = if counts.is_empty() {
                    "diagnostics".to_string()
                } else {
                    counts.join(", ")
                };
                let messages = if diagnostic.messages.is_empty() {
                    String::new()
                } else {
                    format!(" - {}", diagnostic.messages.join("; "))
                };
                lines.push(format!("- {file}: {counts}{messages}"));
            }
        }
    }
    Some(format!("{}\n", lines.join("\n")))
}

pub(super) fn format_code_workspace_file(
    file: &crate::agent::context::AgentCodeWorkspaceFile,
) -> String {
    match file.kind.as_str() {
        "root" => {
            let root = file
                .root_name
                .as_deref()
                .or(file.root_id.as_deref())
                .unwrap_or("root");
            let path = file.path.as_deref().unwrap_or("");
            format!("{root}/{path}")
        }
        "loose" => {
            let path = file.path.as_deref().unwrap_or("");
            let (clean, _) = redact::redact(path);
            clean
        }
        _ => file.path.as_deref().unwrap_or("").to_string(),
    }
}

pub(super) fn format_code_workspace_files(
    files: &[crate::agent::context::AgentCodeWorkspaceFile],
) -> String {
    const MAX_DISPLAY_PATHS: usize = 12;
    let shown = files
        .iter()
        .take(MAX_DISPLAY_PATHS)
        .map(format_code_workspace_file)
        .collect::<Vec<_>>()
        .join(", ");
    if files.len() > MAX_DISPLAY_PATHS {
        format!("{shown}, ...")
    } else {
        shown
    }
}

pub(super) fn format_code_workspace_paths(paths: &[String]) -> String {
    const MAX_DISPLAY_PATHS: usize = 12;
    let shown = paths
        .iter()
        .take(MAX_DISPLAY_PATHS)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    if paths.len() > MAX_DISPLAY_PATHS {
        format!("{shown}, ...")
    } else {
        shown
    }
}
