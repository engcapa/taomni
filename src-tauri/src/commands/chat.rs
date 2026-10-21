pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::chat::chat_new_thread,
        crate::chat::chat_list_threads,
        crate::chat::chat_list_messages,
        crate::chat::chat_delete_thread,
        crate::chat::chat_set_thread_provider,
        crate::chat::chat_set_thread_cc_model,
        crate::chat::chat_set_thread_llm_model,
        crate::chat::chat_set_thread_output_format,
        crate::chat::chat_purge_old,
        crate::chat::chat_export_archive,
        crate::chat::chat_stat_attachment_paths,
        crate::chat::chat_read_clipboard_image_attachment,
        crate::chat::chat_send,
        crate::chat::chat_generate_media,
        crate::chat::chat_stream,
        crate::chat::chat_stop_stream,
        crate::chat::inline_qq::inline_qq_stream,
    ];
    handler(invoke)
}
