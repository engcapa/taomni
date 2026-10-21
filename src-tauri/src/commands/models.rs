pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::models::models_list,
        crate::models::models_download,
        crate::models::models_delete,
        crate::models::models_verify,
        crate::models::cuda_pack_status,
        crate::models::cuda_pack_install,
        crate::models::cuda_pack_uninstall,
        crate::models::mirror_get_config,
        crate::models::mirror_set_config,
    ];
    handler(invoke)
}
