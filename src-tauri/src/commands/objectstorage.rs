pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::objectstorage::storage_attach,
        crate::objectstorage::storage_detach,
        crate::objectstorage::storage_ping,
        crate::objectstorage::storage_test_connection,
        crate::objectstorage::storage_list_buckets,
        crate::objectstorage::storage_list_objects,
        crate::objectstorage::storage_get_object_bytes,
        crate::objectstorage::storage_put_object_bytes,
        crate::objectstorage::storage_delete_object,
        crate::objectstorage::storage_create_folder,
        crate::objectstorage::storage_create_bucket,
        crate::objectstorage::storage_delete_bucket,
        crate::objectstorage::storage_delete_prefix,
        crate::objectstorage::storage_head_object,
        crate::objectstorage::storage_copy_object,
        crate::objectstorage::storage_move_object,
        crate::objectstorage::storage_move_prefix,
        crate::objectstorage::storage_share_url,
        crate::objectstorage::storage_download,
        crate::objectstorage::storage_upload,
        crate::objectstorage::storage_cancel_transfer,
        crate::objectstorage::storage_pause_transfer,
        crate::objectstorage::storage_resume_transfer,
    ];
    handler(invoke)
}
