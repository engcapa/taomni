use super::*;

#[tauri::command]
pub async fn lsp_get_diagnostics(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDiagnosticsResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let diagnostics = match state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session
            .diagnostics
            .read()
            .await
            .get(&document.uri)
            .cloned()
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspDiagnosticsResult {
        status,
        diagnostics,
    })
}

/// Refresh LSP 3.17 pull-capable servers, then return diagnostics stored across
/// the workspace's ready sessions (M7-C), including files the user never opened.
/// Servers without `workspace/diagnostic` keep using publishDiagnostics data.
/// Empty when no session is active.
#[tauri::command]
pub async fn lsp_workspace_diagnostics(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<WorkspaceDiagnosticFile>, String> {
    let workspace_id = workspace_id.trim();
    let workspace_id = if workspace_id.is_empty() {
        "default"
    } else {
        workspace_id
    };
    Ok(state
        .workspace
        .lsp
        .workspace_diagnostics(workspace_id)
        .await)
}

/// Outcome of a jdtls workspace build, mirroring JDT LS's `BuildWorkspaceStatus`
/// so the caller can tell "built clean" from "built, but the project has compile
/// errors" without a second diagnostics sweep.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LspBuildStatus {
    Failed,
    Succeed,
    WithError,
    Cancelled,
}

/// Map JDT LS's `BuildWorkspaceStatus` ordinal (`java/buildWorkspace` result).
pub(super) fn build_status_from_result(value: &Value) -> LspBuildStatus {
    match value.as_u64() {
        Some(0) => LspBuildStatus::Failed,
        Some(2) => LspBuildStatus::WithError,
        Some(3) => LspBuildStatus::Cancelled,
        // 1 = SUCCEED. Anything unexpected is treated as a plain success: the
        // build ran, and blocking a launch on an unknown enum value would be
        // worse than trusting the diagnostics the caller checks next.
        _ => LspBuildStatus::Succeed,
    }
}

/// Build the project on the active jdtls session (M7-C "Rebuild project" and the
/// make-before-launch barrier of a Java debug start).
///
/// This is JDT LS's custom **`java/buildWorkspace` request** — NOT a
/// `workspace/executeCommand`. jdtls registers no `java.buildWorkspace` command
/// (it answers "No delegateCommandHandler for java.buildWorkspace"), and
/// java-debug's `vscode.java.buildWorkspace` takes a String argument, so both
/// executeCommand spellings fail outright — silently turning make-before-launch
/// into a no-op and leaving the debuggee to run stale bytecode.
///
/// `full = true` forces a clean rebuild (so diagnostics for unopened files are
/// republished); the launch barrier passes `false` for an incremental build.
#[tauri::command]
pub async fn lsp_build_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    full: Option<bool>,
) -> Result<LspBuildStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
        .ok_or_else(|| {
            "No language server session is active for this project; open a project file first"
                .to_string()
        })?;
    // `java/buildWorkspace` takes the `forceReBuild` flag as a bare boolean.
    let full = full.unwrap_or(true);
    let started = Instant::now();
    let result = session
        .request_with_timeout(
            "java/buildWorkspace",
            json!(full),
            BUILD_WORKSPACE_TIMEOUT_SECS,
        )
        .await
        .map_err(|e| format!("Failed to build project: {e}"))?;
    let status = build_status_from_result(&result);
    log::info!(
        "lsp: java/buildWorkspace(full={full}) → {status:?} in {:?}",
        started.elapsed()
    );
    Ok(status)
}
