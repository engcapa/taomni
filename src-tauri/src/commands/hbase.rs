pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::hbase::hbase_connect,
        crate::hbase::hbase_ping,
        crate::hbase::hbase_disconnect,
        crate::hbase::hbase_cancel,
        crate::hbase::hbase_list_tables,
        crate::hbase::hbase_describe_table,
        crate::hbase::hbase_execute,
        crate::hbase::hbase_parse_site_xml,
        crate::hbase::hbase_parse_keytab_principal,
    ];
    handler(invoke)
}
