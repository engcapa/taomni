mod files;

mod dialogs;

mod clipboard;

mod paths;

#[cfg(test)]
mod tests;

pub use files::{
    ReadStreamOpenResult, check_file_exists, read_file_bytes, read_stream_close, read_stream_open,
    read_stream_read, temporary_file_path, write_stream_abort, write_stream_append,
    write_stream_close, write_stream_open,
};

pub(crate) use files::{
    __cmd__check_file_exists, __cmd__read_file_bytes, __cmd__read_stream_close,
    __cmd__read_stream_open, __cmd__read_stream_read, __cmd__temporary_file_path,
    __cmd__write_stream_abort, __cmd__write_stream_append, __cmd__write_stream_close,
    __cmd__write_stream_open, __tauri_command_name_check_file_exists,
    __tauri_command_name_read_file_bytes, __tauri_command_name_read_stream_close,
    __tauri_command_name_read_stream_open, __tauri_command_name_read_stream_read,
    __tauri_command_name_temporary_file_path, __tauri_command_name_write_stream_abort,
    __tauri_command_name_write_stream_append, __tauri_command_name_write_stream_close,
    __tauri_command_name_write_stream_open,
};

pub use dialogs::{
    get_home_dir, select_file_path, select_folder_path, select_private_key_file,
    select_save_directory, select_save_file_path, select_upload_file,
};

pub(crate) use dialogs::{
    __cmd__get_home_dir, __cmd__select_file_path, __cmd__select_folder_path,
    __cmd__select_private_key_file, __cmd__select_save_directory, __cmd__select_save_file_path,
    __cmd__select_upload_file, __tauri_command_name_get_home_dir,
    __tauri_command_name_select_file_path, __tauri_command_name_select_folder_path,
    __tauri_command_name_select_private_key_file, __tauri_command_name_select_save_directory,
    __tauri_command_name_select_save_file_path, __tauri_command_name_select_upload_file,
};

pub use clipboard::{
    ClipboardCapabilities, ClipboardMultiFormat, clipboard_capabilities,
    clipboard_parse_file_paths, clipboard_read_files, clipboard_read_multi_format,
    clipboard_read_text, clipboard_write_files, clipboard_write_multi_format, clipboard_write_text,
};

pub(crate) use clipboard::{
    __cmd__clipboard_capabilities, __cmd__clipboard_parse_file_paths, __cmd__clipboard_read_files,
    __cmd__clipboard_read_multi_format, __cmd__clipboard_read_text, __cmd__clipboard_write_files,
    __cmd__clipboard_write_multi_format, __cmd__clipboard_write_text,
    __tauri_command_name_clipboard_capabilities, __tauri_command_name_clipboard_parse_file_paths,
    __tauri_command_name_clipboard_read_files, __tauri_command_name_clipboard_read_multi_format,
    __tauri_command_name_clipboard_read_text, __tauri_command_name_clipboard_write_files,
    __tauri_command_name_clipboard_write_multi_format, __tauri_command_name_clipboard_write_text,
};

#[cfg(any(all(unix, not(target_os = "macos")), test))]
mod clipboard_text;

#[cfg(windows)]
#[path = "platform/windows.rs"]
mod platform;

#[cfg(target_os = "macos")]
#[path = "platform/macos.rs"]
mod platform;

#[cfg(all(unix, not(target_os = "macos")))]
#[path = "platform/unix.rs"]
mod platform;

#[cfg(not(any(windows, unix)))]
#[path = "platform/unsupported.rs"]
mod platform;
