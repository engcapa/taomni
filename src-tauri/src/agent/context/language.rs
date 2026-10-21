use super::files::normalize_code_workspace_file;
use super::limits::MAX_CODE_WORKSPACE_LSP_DIAGNOSTIC_FILES;
use super::limits::MAX_CODE_WORKSPACE_LSP_MESSAGES;
use super::limits::MAX_CODE_WORKSPACE_LSP_TEXT_LEN;
use super::workspace_model::AgentCodeWorkspaceLooseFile;
use super::workspace_model::AgentCodeWorkspaceLsp;
use super::workspace_model::AgentCodeWorkspaceLspDiagnostic;
use super::workspace_model::AgentCodeWorkspaceLspStatus;
use super::workspace_model::AgentCodeWorkspaceRoot;

pub(super) fn clean_lsp_text(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|s| !s.is_empty()).map(|s| {
        let mut out = s.replace(['\n', '\r'], " ");
        if out.len() > MAX_CODE_WORKSPACE_LSP_TEXT_LEN {
            out.truncate(MAX_CODE_WORKSPACE_LSP_TEXT_LEN);
            out.push_str("...");
        }
        out
    })
}

pub(super) fn normalize_code_workspace_lsp(
    lsp: &AgentCodeWorkspaceLsp,
    roots: &[AgentCodeWorkspaceRoot],
    loose_files: &[AgentCodeWorkspaceLooseFile],
) -> Option<AgentCodeWorkspaceLsp> {
    let active_status = lsp.active_status.as_ref().and_then(|status| {
        let display_name = clean_lsp_text(status.display_name.as_deref());
        let language_id = clean_lsp_text(status.language_id.as_deref());
        let selected_command = clean_lsp_text(status.selected_command.as_deref());
        let install_hint = clean_lsp_text(status.install_hint.as_deref());
        let error = clean_lsp_text(status.error.as_deref());
        if display_name.is_none()
            && language_id.is_none()
            && selected_command.is_none()
            && install_hint.is_none()
            && error.is_none()
            && !status.active
            && !status.available
        {
            return None;
        }
        Some(AgentCodeWorkspaceLspStatus {
            display_name,
            language_id,
            active: status.active,
            available: status.available,
            selected_command,
            install_hint,
            error,
        })
    });

    let mut diagnostics = Vec::new();
    for diagnostic in &lsp.diagnostics {
        let Some(file) = normalize_code_workspace_file(&diagnostic.file, roots, loose_files) else {
            continue;
        };
        let total = diagnostic.error_count + diagnostic.warning_count + diagnostic.info_count;
        if total == 0 && diagnostic.messages.is_empty() {
            continue;
        }
        let mut messages = Vec::new();
        for message in &diagnostic.messages {
            let Some(clean) = clean_lsp_text(Some(message)) else {
                continue;
            };
            if messages.iter().any(|existing| existing == &clean) {
                continue;
            }
            messages.push(clean);
            if messages.len() >= MAX_CODE_WORKSPACE_LSP_MESSAGES {
                break;
            }
        }
        diagnostics.push(AgentCodeWorkspaceLspDiagnostic {
            file,
            error_count: diagnostic.error_count.min(999),
            warning_count: diagnostic.warning_count.min(999),
            info_count: diagnostic.info_count.min(999),
            messages,
        });
        if diagnostics.len() >= MAX_CODE_WORKSPACE_LSP_DIAGNOSTIC_FILES {
            break;
        }
    }

    if active_status.is_none() && diagnostics.is_empty() {
        None
    } else {
        Some(AgentCodeWorkspaceLsp {
            active_status,
            diagnostics,
        })
    }
}
