//! Tunneling backend (MobaSSHTunnel-style)
//!
//! Persists `TunnelConfig` records as JSON in the app data directory and
//! manages running port-forwarders. Three forwarding modes are supported:
//!
//! * `Local`   - listen locally, forward to `dest_host:dest_port` via SSH.
//! * `Remote`  - ask the SSH server to listen on `listen_port` and forward
//!               inbound connections back to a local `dest_host:dest_port`.
//! * `Dynamic` - listen locally as a SOCKS5 (CONNECT only) proxy and tunnel
//!               each client connection through SSH using `direct-tcpip`.
//!
//! All commands return early-exit `Result<_, String>` so the frontend gets
//! a clean error message in invoke().

mod model;

mod registry;

mod persistence;

mod credentials;

mod local_forward;

mod dynamic_forward;

mod remote_forward;

mod commands;

mod lifetime;

pub use model::{
    TunnelAuthMethod, TunnelConfig, TunnelKind, TunnelSshCreds, TunnelStatus, TunnelStatusInfo,
};

pub use registry::{ActiveTunnel, TunnelRegistry};

pub use commands::{
    delete_tunnel, get_tunnel_status, list_tunnel_statuses, list_tunnels, reorder_tunnels,
    test_tunnel, upsert_tunnel,
};

pub(crate) use commands::{
    __cmd__delete_tunnel, __cmd__get_tunnel_status, __cmd__list_tunnel_statuses,
    __cmd__list_tunnels, __cmd__reorder_tunnels, __cmd__test_tunnel, __cmd__upsert_tunnel,
    __tauri_command_name_delete_tunnel, __tauri_command_name_get_tunnel_status,
    __tauri_command_name_list_tunnel_statuses, __tauri_command_name_list_tunnels,
    __tauri_command_name_reorder_tunnels, __tauri_command_name_test_tunnel,
    __tauri_command_name_upsert_tunnel,
};

pub use lifetime::{
    autostart_tunnels, start_all_tunnels, start_tunnel, stop_all_tunnels, stop_tunnel,
};

pub(crate) use lifetime::{
    __cmd__start_all_tunnels, __cmd__start_tunnel, __cmd__stop_all_tunnels, __cmd__stop_tunnel,
    __tauri_command_name_start_all_tunnels, __tauri_command_name_start_tunnel,
    __tauri_command_name_stop_all_tunnels, __tauri_command_name_stop_tunnel,
};
