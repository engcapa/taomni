mod staging;

mod bridge;

mod local_offer;

mod remote_receive;

mod requests;

mod backend;

mod protocol;

mod remote_files;

mod local_files;

pub(crate) use staging::ensure_private_directory;

#[cfg(any(unix, not(unix)))]
pub(crate) use staging::process_is_alive;

pub(super) use staging::{
    cleanup_stale_clipboard_staging, clipboard_process_staging_root, clipboard_staging_base,
};

pub(super) use protocol::{
    advertise_clipboard_formats, drain_clipboard_actions, file_contents_request_message,
    file_list_clipboard_format, file_list_clipboard_format_id, write_cliprdr_messages,
};

pub(crate) use remote_files::{
    remote_clipboard_safe_path, remote_top_level_name, write_remote_file_chunk,
};

pub(super) use remote_files::{build_remote_file_transfer, next_remote_file_request};

pub(crate) use local_files::{clipboard_relative_name, read_clipboard_file_range};

pub(super) use local_files::{collect_clipboard_path, collect_local_clipboard_files};
