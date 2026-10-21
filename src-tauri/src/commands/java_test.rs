pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::java_test::java_test_discover,
        crate::java_test::java_test_resolve_launch,
    ];
    handler(invoke)
}
