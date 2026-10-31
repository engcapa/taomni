pub mod client;
pub mod keygen;
pub mod openssh;

pub mod forwards;

pub mod local_directories;

pub mod network;

pub mod pty;

pub mod shell_integration;

pub mod ssh;

pub mod x11;

pub mod x11_forward;

use crate::state::AppState;

use base64::{Engine, engine::general_purpose::STANDARD as B64};

use russh::Sig;

use serde::Serialize;

use std::collections::{BTreeMap, HashMap};

use std::future::Future;

use std::io::{Read, Write};

use std::pin::Pin;

use std::sync::Arc;

use std::sync::Mutex;

use tauri::ipc::{Channel, InvokeResponseBody};

use tauri::{AppHandle, Emitter, State};

use tokio::sync::Mutex as AsyncMutex;

use tokio::task::JoinHandle;

mod output;

mod active;

mod local_commands;

mod local_start;

mod authentication;

#[cfg(test)]
mod tests;

mod ssh_start;

mod io_commands;

mod connection_probe;

pub use output::{
    TerminalOutputChannel, TerminalOutputSubscriber, attach_terminal_output, detach_terminal_output,
};

pub(crate) use output::revoke_window_outputs;

pub use output::TerminalOutputHub;
use output::{TerminalOutputSubscribers, add_terminal_output_channel, send_terminal_output};

pub(crate) use output::{
    __cmd__attach_terminal_output, __cmd__detach_terminal_output,
    __tauri_command_name_attach_terminal_output, __tauri_command_name_detach_terminal_output,
};

pub use active::ActiveTerminal;

pub use local_commands::{
    detect_x_server, list_common_local_directories, list_local_shells,
    open_local_shell_as_administrator, record_local_directory_use,
};

pub(crate) use local_commands::{record_local_directory_use_inner, record_successful_local_start};

pub(crate) use local_commands::{
    __cmd__detect_x_server, __cmd__list_common_local_directories, __cmd__list_local_shells,
    __cmd__open_local_shell_as_administrator, __cmd__record_local_directory_use,
    __tauri_command_name_detect_x_server, __tauri_command_name_list_common_local_directories,
    __tauri_command_name_list_local_shells, __tauri_command_name_open_local_shell_as_administrator,
    __tauri_command_name_record_local_directory_use,
};

pub use local_start::{LocalTerminalCreated, create_command_terminal, create_local_terminal};

#[cfg(target_os = "linux")]
pub(crate) use local_start::register_local_terminal;

use local_start::terminal_task_environment;

pub(crate) use local_start::{
    __cmd__create_command_terminal, __cmd__create_local_terminal,
    __tauri_command_name_create_command_terminal, __tauri_command_name_create_local_terminal,
};

pub use authentication::submit_ssh_auth_response;

pub(crate) use authentication::{build_kbd_prompter, clear_session_auth_responders};

use authentication::{SshAuthPromptEntry, SshAuthPromptPayload, uuid_like};

pub(crate) use authentication::{
    __cmd__submit_ssh_auth_response, __tauri_command_name_submit_ssh_auth_response,
};

pub use ssh_start::create_ssh_terminal;

pub(crate) use ssh_start::{resolve_jump_credentials, resolve_proxy_session};

pub(crate) use ssh_start::{__cmd__create_ssh_terminal, __tauri_command_name_create_ssh_terminal};

pub use io_commands::{close_terminal, resize_terminal, send_terminal_signal, write_terminal};

use io_commands::{read_loop_local, ssh_signal_from_name, validate_session_id};

#[cfg(any(unix, not(unix)))]
use io_commands::send_local_signal;

pub(crate) use io_commands::{
    __cmd__close_terminal, __cmd__resize_terminal, __cmd__send_terminal_signal,
    __cmd__write_terminal, __tauri_command_name_close_terminal,
    __tauri_command_name_resize_terminal, __tauri_command_name_send_terminal_signal,
    __tauri_command_name_write_terminal,
};

pub use connection_probe::{test_proxy_connection, test_ssh_connection};

pub(crate) use connection_probe::{
    __cmd__test_proxy_connection, __cmd__test_ssh_connection,
    __tauri_command_name_test_proxy_connection, __tauri_command_name_test_ssh_connection,
};

pub(crate) use io_commands::{
    resize_terminal_inner, send_terminal_signal_inner, write_terminal_inner,
};
