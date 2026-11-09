pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::notes::commands::notes_list,
        crate::notes::commands::notes_get,
        crate::notes::commands::notes_create,
        crate::notes::commands::notes_update,
        crate::notes::commands::notes_update_metadata,
        crate::notes::commands::notes_save_content,
        crate::notes::commands::notes_delete,
        crate::notes::commands::notes_toggle_complete,
        crate::notes::commands::notes_archive,
        crate::notes::commands::notes_list_tags,
        crate::notes::commands::notes_upsert_tags,
        crate::notes::commands::notes_set_steps,
        crate::notes::commands::notes_get_prefs,
        crate::notes::commands::notes_set_prefs,
        crate::notes::commands::notes_list_alerts,
        crate::notes::commands::notes_ack_alert,
    ];
    handler(invoke)
}

pub(super) fn handles(command: &str) -> bool {
    matches!(
        command,
        "notes_list"
            | "notes_get"
            | "notes_create"
            | "notes_update"
            | "notes_update_metadata"
            | "notes_save_content"
            | "notes_delete"
            | "notes_toggle_complete"
            | "notes_archive"
            | "notes_list_tags"
            | "notes_upsert_tags"
            | "notes_set_steps"
            | "notes_get_prefs"
            | "notes_set_prefs"
            | "notes_list_alerts"
            | "notes_ack_alert"
    )
}
