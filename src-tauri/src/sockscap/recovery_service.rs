mod stop;

mod update;

mod privileged_files;

mod recovery;

mod teardown;

mod repair;

pub use stop::{prepare_for_exit, sockscap_stop};

pub(crate) use stop::{__cmd__sockscap_stop, __tauri_command_name_sockscap_stop};

pub use update::sockscap_prepare_for_update;

#[cfg(target_os = "linux")]
pub(super) use update::should_recover_stale_capture_for_update;

#[cfg(target_os = "linux")]
pub(super) use update::linux_recovery_requires_elevation;

pub(crate) use update::{
    __cmd__sockscap_prepare_for_update, __tauri_command_name_sockscap_prepare_for_update,
};

#[cfg(windows)]
pub(super) use privileged_files::wait_for_privileged_files_unlocked;

#[cfg(windows)]
pub(super) use privileged_files::is_file_locked;

pub use recovery::sockscap_recover;

pub(super) use recovery::should_block_exit_for_recovery;

#[cfg(target_os = "macos")]
pub(super) use recovery::pending_approval_never_recorded_scope;

pub(crate) use recovery::{__cmd__sockscap_recover, __tauri_command_name_sockscap_recover};

pub use teardown::shutdown_on_exit;

pub(super) use teardown::full_teardown;

pub use repair::boot_repair;

pub(super) use repair::{queue_reap, read_ready_files};
