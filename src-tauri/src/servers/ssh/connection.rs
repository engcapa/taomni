use super::authentication::AuthPolicy;
use crate::servers::engine::LogEmitter;
use russh::Channel;
use russh::ChannelId;
use russh::server::Msg;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// Per-server runtime options that apply to every connection.
#[derive(Clone)]
pub(super) struct SessionOpts {
    pub(super) root: Arc<PathBuf>,
    /// When true, interactive shells are started as login shells (`-l` on Unix).
    pub(super) login_shell: bool,
    /// Hard cap on concurrent SSH sessions (connections).
    pub(super) max_sessions: usize,
}

/// Env vars clients may set via SSH_MSG_CHANNEL_REQUEST "env".
pub(super) const ENV_WHITELIST: &[&str] = &[
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LC_TIME",
    "TERM",
    "COLORTERM",
    "TZ",
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
];

/// Decrements the global active-session counter when the connection is dropped.
pub(super) struct SessionSlot {
    pub(super) active: Arc<AtomicUsize>,
}

impl Drop for SessionSlot {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

/* ------------------------- per-connection state ----------------------- */

/// Writer half of a spawned shell's PTY, plus the resize handle.
pub(super) struct ShellIo {
    pub(super) writer: Box<dyn std::io::Write + Send>,
    pub(super) master: Box<dyn portable_pty::MasterPty + Send>,
}

pub(super) struct SshConnection {
    pub(super) policy: Arc<AuthPolicy>,
    pub(super) opts: Arc<SessionOpts>,
    pub(super) log: LogEmitter,
    pub(super) cancel: CancellationToken,
    /// Active shells keyed by channel id (PTY writer + master for resize).
    pub(super) shells: HashMap<ChannelId, ShellIo>,
    /// Channels parked between `channel_open_session` and `subsystem_request`,
    /// so the SFTP subsystem can take ownership of the channel stream.
    pub(super) pending_channels: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
    /// Reverse-forward listeners for this session: `(bind_addr, port) → cancel`.
    /// Cancelled on `cancel-tcpip-forward` and when the connection is dropped.
    pub(super) reverse_forwards: HashMap<(String, u32), CancellationToken>,
    /// PTY sizes requested before shell/exec (do not open shell on pty-req alone,
    /// so `exec` can use the same size without spawning an interactive shell).
    pub(super) pty_sizes: HashMap<ChannelId, (u16, u16)>,
    /// Accepted env vars for the next shell/exec on this connection.
    pub(super) pending_env: HashMap<String, String>,
    pub(super) authed_user: Option<String>,
    pub(super) auth_method: Option<&'static str>,
    pub(super) peer: Option<SocketAddr>,
    pub(super) connected_at: Instant,
    /// Held while the connection is authenticated and counted toward max_sessions.
    pub(super) session_slot: Option<SessionSlot>,
    pub(super) active_sessions: Arc<AtomicUsize>,
}

impl Drop for SshConnection {
    fn drop(&mut self) {
        for (_, token) in self.reverse_forwards.drain() {
            token.cancel();
        }
        if let Some(user) = &self.authed_user {
            let secs = self.connected_at.elapsed().as_secs();
            let peer = self
                .peer
                .map(|p| p.to_string())
                .unwrap_or_else(|| "unknown".into());
            self.log.line(format!(
                "session closed user={} auth={} peer={} duration={}s",
                user,
                self.auth_method.unwrap_or("?"),
                peer,
                secs
            ));
        }
        // session_slot Drop decrements active count
        self.session_slot.take();
    }
}
