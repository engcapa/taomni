//! Account-owned, resumable full-MIME storage. The renderer only starts or pauses it.

mod limits;

mod lifetime;

mod commands;

mod sync;

mod local_commands;

mod download;

#[cfg(test)]
mod tests;

pub use lifetime::{ArchiveManager, ArchiveStatus};

pub use commands::{mail_archive_pause, mail_archive_start, mail_archive_status};

pub(crate) use commands::{
    __cmd__mail_archive_pause, __cmd__mail_archive_start, __cmd__mail_archive_status,
    __tauri_command_name_mail_archive_pause, __tauri_command_name_mail_archive_start,
    __tauri_command_name_mail_archive_status,
};

pub use local_commands::{
    mail_archive_attachment, mail_archive_cleanup, mail_archive_export, mail_archive_list,
    mail_archive_preview_cleanup, mail_archive_query, mail_archive_read, mail_archive_remove,
};

pub(crate) use local_commands::{
    __cmd__mail_archive_attachment, __cmd__mail_archive_cleanup, __cmd__mail_archive_export,
    __cmd__mail_archive_list, __cmd__mail_archive_preview_cleanup, __cmd__mail_archive_query,
    __cmd__mail_archive_read, __cmd__mail_archive_remove,
    __tauri_command_name_mail_archive_attachment, __tauri_command_name_mail_archive_cleanup,
    __tauri_command_name_mail_archive_export, __tauri_command_name_mail_archive_list,
    __tauri_command_name_mail_archive_preview_cleanup, __tauri_command_name_mail_archive_query,
    __tauri_command_name_mail_archive_read, __tauri_command_name_mail_archive_remove,
};
