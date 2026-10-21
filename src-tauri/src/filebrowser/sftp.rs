//! Wrapper around `russh-sftp` that exposes the operations the JS layer needs.
//!
//! Each `ActiveSftp` keeps the parent `client::Handle<SshHandler>` alive so
//! the SSH connection task is not dropped while the SFTP subsystem is in use.

/// Run an `ActiveSftp` operation, and if it fails because the transport died,
/// reconnect once and retry it. `$op` is re-evaluated verbatim after the
/// reconnect, so it must be a self-contained call (a `*_once` helper) — no `?`
/// may escape into the surrounding function between the two attempts.
macro_rules! retry_reconnect {
    ($self:ident, $op:expr) => {{
        match $op {
            Err(e) if is_disconnect_error(&e) => {
                tracing::warn!("SFTP operation failed ({e}); attempting reconnect");
                match $self.reconnect().await {
                    Ok(()) => $op,
                    // Reconnect failed (e.g. the server demands an interactive
                    // second factor we can't answer here). Surface the original
                    // transport error, not the handshake error: it's the true
                    // cause and reliably drives the frontend's reconnect banner,
                    // where a human can re-auth.
                    Err(reconnect_err) => {
                        tracing::warn!("SFTP reconnect failed: {reconnect_err}");
                        Err(e)
                    }
                }
            }
            other => other,
        }
    }};
}

use crate::filebrowser::local;

use crate::filebrowser::transfer::{self, ProgressPayload, TransferHandle};

use crate::terminal::network::NetworkSettings;

use crate::terminal::ssh::{
    KbdInteractivePrompter, SshAuth, SshHandler, connect_ssh_authenticated_with_prompter,
};

use russh::client;

use russh_sftp::client::SftpSession;

use russh_sftp::protocol::{FileAttributes, FileType as SftpFileType, OpenFlags};

use serde::Serialize;

use std::path::Path;

use std::sync::Arc;

use std::sync::atomic::{AtomicU64, Ordering};

use std::time::Instant;

use tauri::{AppHandle, Emitter};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use tokio::sync::Mutex;

mod progress;

mod metadata;

mod connection;

mod entries;

mod mutations;

mod bytes;

mod upload;

mod download;

#[cfg(test)]
mod tests;

use progress::{CHUNK_SIZE, emit_paused, emit_progress};

pub use metadata::{FileEntryDto, join_remote};

use metadata::{entry_from_attrs, remote_basename};

pub use connection::{ActiveSftp, open_sftp};

pub(crate) use connection::is_disconnect_error;

use connection::{ReconnectParams, connect_sftp, network_with_keepalive};
