use crate::terminal::network::NetworkSettings;
use crate::terminal::ssh::KbdInteractivePrompter;
use crate::terminal::ssh::SshAuth;
use crate::terminal::ssh::SshHandler;
use crate::terminal::ssh::connect_ssh_authenticated_with_prompter;
use russh::client;
use russh_sftp::client::SftpSession;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Everything needed to re-establish a dropped SFTP session without any
/// frontend round-trip. Auth credentials were already resolved to plaintext
/// (vault refs dereferenced, proxy/jump creds filled in) by `sftp_attach`
/// before `open_sftp` was called, so a reconnect can reuse them verbatim.
pub(super) struct ReconnectParams {
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) username: String,
    pub(super) auth: SshAuth,
    /// Effective network settings (keep-alive already forced on — see
    /// `network_with_keepalive`).
    pub(super) network: NetworkSettings,
}

pub struct ActiveSftp {
    pub sftp: Arc<Mutex<SftpSession>>,
    pub home: String,
    /// The parent SSH handle is kept alive for the lifetime of the SFTP
    /// session: dropping it would close the underlying connection. Held in a
    /// `Mutex` so `reconnect` can swap in a fresh handle after the old
    /// connection dies.
    pub(super) _handle: Mutex<client::Handle<SshHandler>>,
    /// Credentials + endpoint for transparent reconnect. `None` disables
    /// auto-reconnect (not currently used, but keeps the door open for
    /// sessions where re-auth would need a human, e.g. an agent-only setup).
    pub(super) reconnect: Option<ReconnectParams>,
    /// Serializes reconnect attempts so a burst of failing operations triggers
    /// a single re-handshake rather than a thundering herd.
    pub(super) reconnect_lock: Mutex<()>,
}

/// Force an SSH keep-alive onto SFTP connections. An idle SFTP channel with no
/// keep-alive is silently reaped by server-side idle timeouts / NAT / firewalls;
/// when that happens every later operation fails with "session closed". A
/// periodic keep-alive keeps the channel warm. Respects an explicit user
/// interval when one is set; otherwise defaults to 30s.
pub(super) fn network_with_keepalive(network: Option<&NetworkSettings>) -> NetworkSettings {
    let mut n = network.cloned().unwrap_or_default();
    n.keep_alive = true;
    if n.keep_alive_interval_secs == 0 {
        n.keep_alive_interval_secs = 30;
    }
    n
}

/// Open one SSH connection, request the sftp subsystem, and complete the SFTP
/// handshake. Returns the live session plus the handle that owns the
/// connection's lifetime. Shared by the initial attach and every reconnect.
pub(super) async fn connect_sftp(
    params: &ReconnectParams,
    prompter: Option<&KbdInteractivePrompter>,
) -> Result<(SftpSession, client::Handle<SshHandler>), String> {
    let handle = connect_ssh_authenticated_with_prompter(
        &params.host,
        params.port,
        &params.username,
        params.auth.clone(),
        Some(&params.network),
        prompter,
    )
    .await?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed to open SFTP channel: {}", e))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("Failed to request sftp subsystem: {}", e))?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTP handshake failed: {}", e))?;
    Ok((sftp, handle))
}

/// True when an error string indicates the transport died (dropped connection,
/// closed channel, EOF, timeout) rather than a normal per-file failure like
/// "No such file" or "Permission denied". Used to decide whether an operation
/// is worth retrying after a reconnect. Kept deliberately conservative so we
/// never loop on a genuine, reproducible error.
pub(crate) fn is_disconnect_error(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("session closed")
        || e.contains("sender dropped")
        || e.contains("connection closed")
        || e.contains("connection reset")
        || e.contains("channel closed")
        || e.contains("broken pipe")
        || e.contains("unexpected eof")
        || e.contains("not connected")
        || e.contains("timeout")
        || e.contains("timed out")
}

pub async fn open_sftp(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    network: Option<&NetworkSettings>,
    prompter: Option<&KbdInteractivePrompter>,
) -> Result<ActiveSftp, String> {
    let params = ReconnectParams {
        host: host.to_string(),
        port,
        username: username.to_string(),
        auth,
        network: network_with_keepalive(network),
    };
    let (sftp, handle) = connect_sftp(&params, prompter).await?;

    let home = sftp
        .canonicalize(".")
        .await
        .unwrap_or_else(|_| "/".to_string());

    Ok(ActiveSftp {
        sftp: Arc::new(Mutex::new(sftp)),
        home,
        _handle: Mutex::new(handle),
        reconnect: Some(params),
        reconnect_lock: Mutex::new(()),
    })
}

impl ActiveSftp {
    /// Re-establish the SSH + SFTP connection in place after it dropped. Swaps
    /// a fresh session and handle into the existing `Mutex`es, so every
    /// outstanding `Arc<Mutex<SftpSession>>` clone keeps working transparently.
    /// Serialized by `reconnect_lock`; callers that queue behind a winning
    /// attempt re-probe and skip the redundant handshake.
    ///
    /// Auto-reconnect runs without a keyboard-interactive prompter, so a server
    /// that demands an interactive second factor (MFA) on every login fails
    /// here and falls back to the frontend's manual reconnect, which re-prompts.
    pub(super) async fn reconnect(&self) -> Result<(), String> {
        let params = self
            .reconnect
            .as_ref()
            .ok_or("SFTP session is not reconnectable")?;
        let _guard = self.reconnect_lock.lock().await;
        // A prior waiter may have healed the session while we queued on the
        // lock. Probe cheaply; if it responds now, skip the re-handshake.
        if self
            .sftp
            .lock()
            .await
            .canonicalize(".".to_string())
            .await
            .is_ok()
        {
            return Ok(());
        }
        let (sftp, handle) = connect_sftp(params, None).await?;
        *self.sftp.lock().await = sftp;
        *self._handle.lock().await = handle;
        tracing::info!(
            "SFTP session reconnected to {}:{}",
            params.host,
            params.port
        );
        Ok(())
    }
}
