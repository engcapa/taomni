pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::asr::models::voice_models,
        crate::asr::models::voice_model_installation,
        crate::asr::models::voice_cancel_model_installation,
        crate::asr::models::voice_cancel_sherpa_model_installation,
        crate::asr::models::voice_check_models,
        crate::asr::models::voice_install_model,
        crate::asr::models::voice_sherpa_model_status,
        crate::asr::models::voice_sherpa_model_installation,
        crate::asr::models::voice_install_sherpa_model,
    ];
    handler(invoke)
}
