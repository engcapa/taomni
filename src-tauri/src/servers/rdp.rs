//! Real in-process RDP server built on `ironrdp-server` 0.10 (`ironrdp::server`).
//!
//! This is the SERVER half of RDP — it shares *this* machine's desktop with an
//! RDP client (mstsc, FreeRDP, Remote Desktop mobile). It is the mirror image of
//! the RDP *client* in `crate::rdp` (which connects out to a Windows host); the
//! two share the IronRDP umbrella but use opposite halves (`server`/`acceptor`
//! vs `connector`/`session`) and keep entirely separate state.
//!
//! Like [`super::ssh`], this is an in-process pure-Rust server (not an external
//! daemon like [`super::vnc`]), so `ServerStarted.pid` is `None`. It is NOT an
//! OS/PAM gateway: credentials are validated against the server config, never
//! against system accounts.
//!
//! Server-specific config (`config.extra`, camelCase as sent by the frontend):
//!   - `username`     (string) RDP username clients must present
//!   - `passwordRef`  (string) encrypted-vault reference resolved at startup
//!   - `domain`       (string) optional NLA domain
//!   - `viewOnly`     (bool)   ignore client keyboard/mouse input (default false)
//!   - `displayId`    (string) optional macOS display id; empty selects primary
//!   - `requireControlApproval` (bool) require local consent before input (default true)
//!   - `securityMode` (string) "hybrid" (NLA/CredSSP; the only production mode)
//!
//! ## Security
//!
//! Production mode is `hybrid` (NLA/CredSSP over TLS). TLS-only mode is not an
//! authentication mechanism in IronRDP and plain RDP has no transport
//! encryption, so both are rejected. TLS uses a self-signed cert cached in
//! app-data (see [`tls`]); credentials are mandatory and are only present in
//! memory after resolving the encrypted vault reference.
//!
//! ## Cancel bridge (the one new integration step vs `ssh.rs`)
//!
//! `RdpServer::run()` owns its own accept loop and is not aware of `ctx.cancel`.
//! It does, however, expose `event_sender()`: sending [`ServerEvent::Quit`] makes
//! the loop break cleanly the next time it is idle on the listener. We spawn a
//! small bridge task that forwards `ctx.cancel` → `ServerEvent::Quit`, and also
//! race `run()` against the cancel token as a hard backstop for the case where a
//! client connection is mid-flight when stop is requested.

mod audio_input;

mod auth;

/// Screen-capture backends (X11 / Wayland). Exposed crate-wide so the LanChat
/// native A/V stack can reuse the X11 capturer for screen sharing.
pub(crate) mod capture;

mod clipboard;

mod clipboard_formats;

mod diff;

mod display;

#[cfg(target_os = "macos")]
mod gfx;

mod input;

#[cfg(target_os = "macos")]
pub(crate) use input::{control_permission_granted, request_control_permission};

#[cfg(test)]
mod bulk_loopback_tests;

#[cfg(test)]
mod loopback_tests;

mod metrics;

mod session;

mod sound;

pub(crate) mod system_rdp;

mod tls;

use std::collections::HashMap;

use std::net::SocketAddr;

use std::sync::{Arc, Mutex};

use ironrdp::server::{
    ConnectionHandler, Credentials, DesktopSize, PostConnectionAction, RdpServer, ServerEvent,
    TlsIdentityCtx,
};

use serde::Serialize;

use tauri::{AppHandle, Emitter, Manager};

use tokio_util::sync::CancellationToken;

use super::ServerConfig;

use super::engine::{LogEmitter, ServerCtx, ServerStarted};

use auth::AuthConfig;

use clipboard::{ClipboardFactory, ClipboardPolicy};

use display::RdpDisplay;

use input::RdpInput;

use metrics::RdpMetrics;

mod approval;

mod lifetime;

mod features;

mod policy;

mod builder;

#[cfg(test)]
mod tests;

pub(crate) use approval::{ApprovalBroker, ControlGate};

use approval::{
    CONTROL_APPROVAL_TIMEOUT, ConnectionApprovalRequest, ControlDecision, ControlGateState,
    RdpSessionEvent,
};

pub use lifetime::start;

use lifetime::{AUTODETECT_INTERVAL, ServerParams, log_ready, spawn_server};

#[cfg(target_os = "macos")]
use features::EXPERIMENTAL_AVC420_ENV;

#[cfg(target_os = "macos")]
use features::EXPERIMENTAL_CLIENT_SIZE_ENV;

#[cfg(target_os = "macos")]
use features::experimental_feature_enabled;

#[cfg(any(target_os = "macos", test))]
use features::experimental_feature_value;

pub(crate) use policy::SecurityMode;

use policy::ConnectionPolicy;

use builder::build_server;
