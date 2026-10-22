//! Local "Servers" feature backend (MobaXterm-style server management).
//!
//! Manages a fixed set of ten local server types (SSH, FTP, TFTP, HTTP,
//! Telnet, VNC, NFS, Cron, iperf, RDP). Each running server lives in the
//! [`ServerRegistry`] held by `AppState`; the registry tracks the cancel
//! token, the supervising task, an optional auto-stop timer, and the last
//! published [`ServerStatus`].
//!
//! The command layer mirrors `tunnel/mod.rs`: every `#[tauri::command]`
//! returns `Result<_, String>`, status changes go through
//! [`engine::set_status`] (which updates the registry and emits
//! `server://status/<type>`), and `autostart_servers` runs at startup.

pub mod cron;

pub mod db;

pub mod engine;

pub mod ftp;

pub mod http;

pub mod iperf;

pub mod nfs;

pub mod process;

pub mod rdp;

pub mod ssh;

pub mod telnet;

pub mod tftp;

pub mod vnc;

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use tauri::{AppHandle, Manager, State};

use tokio::sync::Mutex as AsyncMutex;

use tokio::task::JoinHandle;

use tokio_util::sync::CancellationToken;

use crate::module_lock::ModuleLock;

use crate::state::AppState;

use engine::{ServerCtx, set_status};

mod credentials;

mod model;

mod registry;

mod lifetime;

mod probes;

mod persistence;

mod autostart;

#[cfg(test)]
mod tests;

use credentials::{
    RDP_PASSWORD_KIND, RDP_PASSWORD_LABEL, rdp_plaintext_password, redact_legacy_rdp_password,
    redact_rdp_password, resolve_rdp_password, secure_rdp_config,
};

pub use model::{ServerConfig, ServerRunState, ServerStatus, ServerType};

use model::{default_autostop, default_bind, now_ms};

pub use registry::{
    ActiveServer, ServerRegistry, clear_server_log, list_server_logs,
    resolve_rdp_connection_request,
};

use registry::LOG_HISTORY_LINES;

pub(crate) use registry::{
    __cmd__clear_server_log, __cmd__list_server_logs, __cmd__resolve_rdp_connection_request,
    __tauri_command_name_clear_server_log, __tauri_command_name_list_server_logs,
    __tauri_command_name_resolve_rdp_connection_request,
};

pub use lifetime::{
    get_server_status, list_server_statuses, start_local_server, stop_local_server,
};

use lifetime::{spawn_auto_stop, stop_internal};

pub(crate) use lifetime::{
    __cmd__get_server_status, __cmd__list_server_statuses, __cmd__start_local_server,
    __cmd__stop_local_server, __tauri_command_name_get_server_status,
    __tauri_command_name_list_server_statuses, __tauri_command_name_start_local_server,
    __tauri_command_name_stop_local_server,
};

pub use probes::{open_system_rdp_settings, probe_rdp_capture, probe_system_rdp};

pub(crate) use probes::{
    __cmd__open_system_rdp_settings, __cmd__probe_rdp_capture, __cmd__probe_system_rdp,
    __tauri_command_name_open_system_rdp_settings, __tauri_command_name_probe_rdp_capture,
    __tauri_command_name_probe_system_rdp,
};

pub use persistence::{load_server_configs, save_server_config};

pub(crate) use persistence::{
    __cmd__load_server_configs, __cmd__save_server_config,
    __tauri_command_name_load_server_configs, __tauri_command_name_save_server_config,
};

pub use autostart::autostart_servers;

use autostart::rdp_autostart_allowed;
