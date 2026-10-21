use super::*;

#[tauri::command]
pub fn workspace_detect_tasks(
    repo_root: String,
    tool_config: Option<WorkspaceToolConfig>,
) -> Result<Vec<WorkspaceTask>, String> {
    let root = canonical_repo_root(&repo_root)?;
    detect_workspace_tasks(&root, tool_config.as_ref())
}

#[tauri::command]
pub fn workspace_java_run_targets(
    repo_root: String,
    tool_config: Option<WorkspaceToolConfig>,
) -> Result<Vec<JavaRunTarget>, String> {
    let root = canonical_repo_root(&repo_root)?;
    detect_java_run_targets(&root, tool_config.as_ref())
}

#[tauri::command]
pub fn workspace_java_run_target(
    repo_root: String,
    file_path: String,
    tool_config: Option<WorkspaceToolConfig>,
) -> Result<JavaRunTarget, String> {
    let root = canonical_repo_root(&repo_root)?;
    let source_file = resolve_existing_path(&root, &file_path)?;
    if source_file.extension().and_then(|value| value.to_str()) != Some("java") {
        return Err("Run Java File requires a .java source file".into());
    }
    java_run_target_for_path(&root, &source_file, tool_config.as_ref())
}

/// Grouped task tree for the Build panel (M7 F-2). Maven/Gradle carry their full
/// lifecycle / common tasks; other ecosystems group their detected tasks by source.
#[tauri::command]
pub fn workspace_task_tree(
    repo_root: String,
    tool_config: Option<WorkspaceToolConfig>,
) -> Result<Vec<WorkspaceTaskGroup>, String> {
    let root = canonical_repo_root(&repo_root)?;
    build_workspace_task_tree(&root, tool_config.as_ref())
}
