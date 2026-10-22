mod model;

mod credentials;

mod commands;

mod local_shells;

mod xshell;

mod discovery;

mod filesystem;

#[cfg(test)]
mod tests;

pub use model::{DbeaverCredentialEntry, LocalSessionFile};

pub use commands::{
    import_external_bash_sessions, import_putty_sessions, import_wsl_sessions,
    read_dbeaver_credentials_for_data_sources, read_plist_session_file, scan_local_session_files,
};

pub(crate) use commands::{
    __cmd__import_external_bash_sessions, __cmd__import_putty_sessions, __cmd__import_wsl_sessions,
    __cmd__read_dbeaver_credentials_for_data_sources, __cmd__read_plist_session_file,
    __cmd__scan_local_session_files, __tauri_command_name_import_external_bash_sessions,
    __tauri_command_name_import_putty_sessions, __tauri_command_name_import_wsl_sessions,
    __tauri_command_name_read_dbeaver_credentials_for_data_sources,
    __tauri_command_name_read_plist_session_file, __tauri_command_name_scan_local_session_files,
};

pub(crate) use filesystem::decode_command_output;
