pub(super) fn handles(command: &str) -> bool {
    matches!(
        command,
        "explorer_canonical_path"
            | "explorer_same_volume"
            | "local_copy_entries"
            | "local_move_entries"
            | "explorer_search_entries"
            | "explorer_global_file_search"
            | "explorer_cancel_operation"
            | "local_trash_entries"
            | "local_trash_restore"
            | "local_properties"
            | "explorer_read_preview_bytes"
            | "explorer_read_preview_text"
            | "local_rename_entry"
            | "local_create_entry"
            | "explorer_write_clipboard_files"
            | "explorer_update_cut_clipboard"
            | "sftp_attach"
            | "sftp_detach"
            | "sftp_list_remote"
            | "sftp_list_local"
            | "sftp_list_local_detailed"
            | "sftp_local_home"
            | "sftp_local_drives"
            | "sftp_mkdir"
            | "sftp_remove"
            | "sftp_rename"
            | "sftp_stat"
            | "sftp_chmod"
            | "sftp_realpath"
            | "sftp_open_path"
            | "open_external_url"
            | "sftp_read_file_text"
            | "sftp_write_file_text"
            | "sftp_upload"
            | "sftp_download"
            | "sftp_upload_dir"
            | "sftp_download_dir"
            | "sftp_upload_bytes"
            | "sftp_download_bytes"
            | "sftp_cancel_transfer"
            | "sftp_pause_transfer"
            | "sftp_resume_transfer"
            | "open_sftp_window"
    )
}

pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::filebrowser::local_ops::explorer_canonical_path,
        crate::filebrowser::local_ops::explorer_same_volume,
        crate::filebrowser::local_ops::local_copy_entries,
        crate::filebrowser::local_ops::local_move_entries,
        crate::filebrowser::local_ops::explorer_search_entries,
        crate::filebrowser::local_ops::explorer_global_file_search,
        crate::filebrowser::local_ops::explorer_cancel_operation,
        crate::filebrowser::local_ops::local_trash_entries,
        crate::filebrowser::local_ops::local_trash_restore,
        crate::filebrowser::local_ops::local_properties,
        crate::filebrowser::local_ops::explorer_read_preview_bytes,
        crate::filebrowser::local_ops::explorer_read_preview_text,
        crate::filebrowser::local_ops::local_rename_entry,
        crate::filebrowser::local_ops::local_create_entry,
        crate::config::explorer_write_clipboard_files,
        crate::config::explorer_update_cut_clipboard,
        crate::filebrowser::sftp_attach,
        crate::filebrowser::sftp_detach,
        crate::filebrowser::sftp_list_remote,
        crate::filebrowser::sftp_list_local,
        crate::filebrowser::sftp_list_local_detailed,
        crate::filebrowser::sftp_local_home,
        crate::filebrowser::sftp_local_drives,
        crate::filebrowser::sftp_mkdir,
        crate::filebrowser::sftp_remove,
        crate::filebrowser::sftp_rename,
        crate::filebrowser::sftp_stat,
        crate::filebrowser::sftp_chmod,
        crate::filebrowser::sftp_realpath,
        crate::filebrowser::sftp_open_path,
        crate::filebrowser::open_external_url,
        crate::filebrowser::sftp_read_file_text,
        crate::filebrowser::sftp_write_file_text,
        crate::filebrowser::sftp_upload,
        crate::filebrowser::sftp_download,
        crate::filebrowser::sftp_upload_dir,
        crate::filebrowser::sftp_download_dir,
        crate::filebrowser::sftp_upload_bytes,
        crate::filebrowser::sftp_download_bytes,
        crate::filebrowser::sftp_cancel_transfer,
        crate::filebrowser::sftp_pause_transfer,
        crate::filebrowser::sftp_resume_transfer,
        crate::filebrowser::open_sftp_window,
    ];
    handler(invoke)
}
