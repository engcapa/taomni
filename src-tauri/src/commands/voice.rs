pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::voice::commands::voice_capture_supported,
        crate::voice::commands::voice_start_capture,
        crate::voice::commands::voice_start_stream,
        crate::voice::cleanup::voice_cleanup_text,
        crate::voice::cleanup::voice_cancel_cleanup,
        crate::voice::commands::voice_stop_capture,
        crate::voice::commands::voice_stop_stream,
        crate::voice::commands::voice_stop_and_transcribe,
    ];
    handler(invoke)
}
