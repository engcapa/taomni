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
        crate::workspace::workspace_read_file,
        crate::workspace::workspace_read_loose_file,
        crate::workspace::workspace_read_file_with_encoding,
        crate::workspace::workspace_read_loose_file_with_encoding,
        crate::commands::workspace_writes::workspace_write_file,
        crate::commands::workspace_writes::workspace_write_loose_file,
        crate::commands::workspace_writes::workspace_write_file_encoded,
        crate::commands::workspace_writes::workspace_write_loose_file_encoded,
        crate::workspace::workspace_create_file,
        crate::workspace::workspace_create_dir,
        crate::workspace::workspace_delete_path,
        crate::workspace::workspace_rename_path,
        crate::workspace::workspace_apply_resource_operation,
    ];
    handler(invoke)
}
