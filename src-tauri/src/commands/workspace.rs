pub(super) fn handles(command: &str) -> bool {
    matches!(
        command,
        "workspace_list_dir"
            | "workspace_compact_chain"
            | "workspace_list_files_recursive"
            | "workspace_detect_git_roots"
            | "workspace_detect_tasks"
            | "workspace_java_run_targets"
            | "workspace_java_run_target"
            | "workspace_task_tree"
            | "workspace_dependency_tree"
            | "workspace_read_file"
            | "workspace_read_loose_file"
            | "workspace_read_file_with_encoding"
            | "workspace_read_loose_file_with_encoding"
            | "workspace_write_file"
            | "workspace_write_loose_file"
            | "workspace_write_file_encoded"
            | "workspace_write_loose_file_encoded"
            | "workspace_create_file"
            | "workspace_create_dir"
            | "workspace_delete_path"
            | "workspace_rename_path"
            | "workspace_apply_resource_operation"
            | "workspace_import_paths"
    )
}

pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::workspace::workspace_list_dir,
        crate::workspace::workspace_compact_chain,
        crate::workspace::workspace_list_files_recursive,
        crate::workspace::workspace_detect_git_roots,
        crate::workspace::workspace_detect_tasks,
        crate::workspace::workspace_java_run_targets,
        crate::workspace::workspace_java_run_target,
        crate::workspace::workspace_task_tree,
        crate::workspace::workspace_dependency_tree,
        crate::commands::workspace_reads::workspace_read_file,
        crate::commands::workspace_reads::workspace_read_loose_file,
        crate::commands::workspace_reads::workspace_read_file_with_encoding,
        crate::commands::workspace_reads::workspace_read_loose_file_with_encoding,
        crate::commands::workspace_writes::workspace_write_file,
        crate::commands::workspace_writes::workspace_write_loose_file,
        crate::commands::workspace_writes::workspace_write_file_encoded,
        crate::commands::workspace_writes::workspace_write_loose_file_encoded,
        crate::workspace::workspace_create_file,
        crate::workspace::workspace_create_dir,
        crate::workspace::workspace_delete_path,
        crate::workspace::workspace_rename_path,
        crate::workspace::workspace_apply_resource_operation,
        crate::workspace::workspace_import_paths,
    ];
    handler(invoke)
}
