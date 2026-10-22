use super::*;

pub(super) enum ActiveImapSession {
    Tls {
        session: imap::Session<native_tls::TlsStream<TcpStream>>,
        forward_task: Option<JoinHandle<()>>,
    },
    Plain {
        session: imap::Session<TcpStream>,
        forward_task: Option<JoinHandle<()>>,
    },
}

impl ActiveImapSession {
    pub(super) fn list_folders(&mut self, account_id: &str) -> Result<Vec<MailFolder>, String> {
        match self {
            Self::Tls { session, .. } => imap_list_folders(session, account_id),
            Self::Plain { session, .. } => imap_list_folders(session, account_id),
        }
    }

    pub(super) fn sync_folder(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
        offset: u32,
        limit: u32,
        include_bodies: bool,
    ) -> Result<(MailFolder, Vec<MailMessageCached>, bool), String> {
        match self {
            Self::Tls { session, .. } => {
                imap_sync_folder(session, account, folder, offset, limit, include_bodies)
            }
            Self::Plain { session, .. } => {
                imap_sync_folder(session, account, folder, offset, limit, include_bodies)
            }
        }
    }

    pub(super) fn sync_folder_step(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
        state: &FolderSyncState,
        params: &StepParams,
    ) -> Result<FolderStepOutcome, String> {
        match self {
            Self::Tls { session, .. } => {
                sync::imap_sync_folder_step(session, account, folder, state, params)
            }
            Self::Plain { session, .. } => {
                sync::imap_sync_folder_step(session, account, folder, state, params)
            }
        }
    }

    pub(super) fn set_subscription(
        &mut self,
        folder: &str,
        subscribed: bool,
    ) -> Result<(), String> {
        match self {
            Self::Tls { session, .. } => {
                folders::imap_set_subscription(session, folder, subscribed)
            }
            Self::Plain { session, .. } => {
                folders::imap_set_subscription(session, folder, subscribed)
            }
        }
    }

    pub(super) fn folder_status(
        &mut self,
        folder: &str,
        condstore: bool,
    ) -> Option<folders::FolderStatus> {
        match self {
            Self::Tls { session, .. } => folders::imap_folder_status(session, folder, condstore),
            Self::Plain { session, .. } => folders::imap_folder_status(session, folder, condstore),
        }
    }

    pub(super) fn has_capability(&mut self, name: &str) -> bool {
        match self {
            Self::Tls { session, .. } => sync::imap_has_capability(session, name),
            Self::Plain { session, .. } => sync::imap_has_capability(session, name),
        }
    }

    pub(super) fn fetch_body(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
        uid: u32,
    ) -> Result<MailMessageCached, String> {
        match self {
            Self::Tls { session, .. } => imap_fetch_body(session, account, folder, uid),
            Self::Plain { session, .. } => imap_fetch_body(session, account, folder, uid),
        }
    }

    pub(super) fn mark_read(&mut self, folder: &str, uids: &[u32]) -> Result<usize, String> {
        match self {
            Self::Tls { session, .. } => imap_mark_read(session, folder, uids),
            Self::Plain { session, .. } => imap_mark_read(session, folder, uids),
        }
    }

    pub(super) fn unread_uids(&mut self, folder: &str) -> Result<Vec<u32>, String> {
        match self {
            Self::Tls { session, .. } => read_actions::unread_uids(session, folder),
            Self::Plain { session, .. } => read_actions::unread_uids(session, folder),
        }
    }

    pub(super) fn download_attachment(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
        uid: u32,
        attachment_index: usize,
        target_path: &str,
        section: Option<&str>,
    ) -> Result<MailDownloadAttachmentResult, String> {
        match self {
            Self::Tls { session, .. } => imap_download_attachment(
                session,
                account,
                folder,
                uid,
                attachment_index,
                target_path,
                section,
            ),
            Self::Plain { session, .. } => imap_download_attachment(
                session,
                account,
                folder,
                uid,
                attachment_index,
                target_path,
                section,
            ),
        }
    }

    pub(super) fn set_flags(
        &mut self,
        folder: &str,
        uids: &[u32],
        add: &[String],
        remove: &[String],
    ) -> Result<usize, String> {
        match self {
            Self::Tls { session, .. } => imap_set_flags(session, folder, uids, add, remove),
            Self::Plain { session, .. } => imap_set_flags(session, folder, uids, add, remove),
        }
    }

    pub(super) fn delete_messages(
        &mut self,
        folder: &str,
        uids: &[u32],
        all: bool,
    ) -> Result<usize, String> {
        match self {
            Self::Tls { session, .. } => imap_delete_messages(session, folder, uids, all),
            Self::Plain { session, .. } => imap_delete_messages(session, folder, uids, all),
        }
    }

    pub(super) fn fetch_raw(&mut self, folder: &str, uid: u32) -> Result<Vec<u8>, String> {
        match self {
            Self::Tls { session, .. } => imap_fetch_raw(session, folder, uid),
            Self::Plain { session, .. } => imap_fetch_raw(session, folder, uid),
        }
    }

    pub(super) fn create_folder(&mut self, name: &str) -> Result<(), String> {
        match self {
            Self::Tls { session, .. } => session
                .create(name)
                .map_err(|e| format!("IMAP CREATE {name} failed: {e}")),
            Self::Plain { session, .. } => session
                .create(name)
                .map_err(|e| format!("IMAP CREATE {name} failed: {e}")),
        }
    }

    pub(super) fn rename_folder(&mut self, from: &str, to: &str) -> Result<(), String> {
        match self {
            Self::Tls { session, .. } => session
                .rename(from, to)
                .map_err(|e| format!("IMAP RENAME {from} -> {to} failed: {e}")),
            Self::Plain { session, .. } => session
                .rename(from, to)
                .map_err(|e| format!("IMAP RENAME {from} -> {to} failed: {e}")),
        }
    }

    pub(super) fn delete_folder(&mut self, name: &str) -> Result<(), String> {
        match self {
            Self::Tls { session, .. } => session
                .delete(name)
                .map_err(|e| format!("IMAP DELETE {name} failed: {e}")),
            Self::Plain { session, .. } => session
                .delete(name)
                .map_err(|e| format!("IMAP DELETE {name} failed: {e}")),
        }
    }

    pub(super) fn logout(&mut self) {
        // The imap 2.4 crate uses `assert_eq!` on command tags. A desynced
        // stream (common after proxy half-close or OAuth fingerprint churn)
        // panics instead of returning Err — never let that tear down the
        // Tokio worker.
        let result = catch_unwind(AssertUnwindSafe(|| match self {
            Self::Tls { session, .. } => session.logout(),
            Self::Plain { session, .. } => session.logout(),
        }));
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::debug!("mail imap logout failed: {e}"),
            Err(_) => {
                tracing::debug!("mail imap logout panicked (protocol desync); dropping connection")
            }
        }
    }
}

impl Drop for ActiveImapSession {
    fn drop(&mut self) {
        let task = match self {
            Self::Tls { forward_task, .. } | Self::Plain { forward_task, .. } => {
                forward_task.take()
            }
        };
        if let Some(task) = task {
            task.abort();
        }
    }
}

impl ActiveImapSession {
    pub(super) fn noop(&mut self) -> Result<(), String> {
        match catch_unwind(AssertUnwindSafe(|| match self {
            Self::Tls { session, .. } => session.noop(),
            Self::Plain { session, .. } => session.noop(),
        })) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(format!("IMAP NOOP failed: {e}")),
            Err(_) => Err("IMAP NOOP failed: protocol desync".into()),
        }
    }
}

/// Discard a live session without risking an imap-crate tag assert panic.
pub(super) fn retire_imap_session(mut session: ActiveImapSession) {
    session.logout();
    // Drop aborts the optional proxy forwarder task.
}

/// Per-account live IMAP session pool. Reuses TCP/TLS/auth and the optional
/// session-level proxy forwarder across mail commands. Does not consult the
/// app global proxy.
pub struct MailImapPool {
    pub(super) mutation_gates: std::sync::Mutex<HashMap<String, Arc<std::sync::Mutex<()>>>>,
    pub(super) entries: std::sync::Mutex<HashMap<ImapPoolKey, LiveImapEntry>>,
    /// Each lane owns its connection and proxy forwarder. Never interleave
    /// commands on one stream, but keep interactive work independent of sync.
    pub(super) account_gates: std::sync::Mutex<HashMap<ImapPoolKey, Arc<std::sync::Mutex<()>>>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub(super) enum ImapLane {
    #[default]
    Interactive,
    Background,
}

pub(super) type ImapPoolKey = (String, ImapLane);

pub(super) struct LiveImapEntry {
    pub(super) fingerprint: String,
    pub(super) session: ActiveImapSession,
    pub(super) last_used: Instant,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct ImapSessionOpts {
    pub(super) lane: ImapLane,
    /// When true, never reuse a pooled session and do not return the session
    /// to the pool (used by connection tests).
    pub(super) force_fresh: bool,
    /// When the first attempt fails with a transport-like error, drop the
    /// live session and retry once with a fresh connect.
    pub(super) retry_on_error: bool,
}

impl Default for ImapSessionOpts {
    fn default() -> Self {
        Self {
            lane: ImapLane::Interactive,
            force_fresh: false,
            retry_on_error: true,
        }
    }
}

impl ImapSessionOpts {
    pub(super) fn background() -> Self {
        Self {
            lane: ImapLane::Background,
            ..Self::default()
        }
    }
}

impl MailImapPool {
    pub(super) fn mutation_gate(&self, account: &str) -> Arc<std::sync::Mutex<()>> {
        self.mutation_gates
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(account.to_string())
            .or_insert_with(|| Arc::new(std::sync::Mutex::new(())))
            .clone()
    }

    pub fn new() -> Self {
        Self {
            entries: std::sync::Mutex::new(HashMap::new()),
            mutation_gates: std::sync::Mutex::new(HashMap::new()),
            account_gates: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub(super) fn account_gate(&self, key: &ImapPoolKey) -> Arc<std::sync::Mutex<()>> {
        let mut gates = self.account_gates.lock().unwrap_or_else(|e| e.into_inner());
        gates
            .entry(key.clone())
            .or_insert_with(|| Arc::new(std::sync::Mutex::new(())))
            .clone()
    }

    pub(super) fn take(&self, key: &ImapPoolKey, fingerprint: &str) -> Option<ActiveImapSession> {
        // LOGOUT can wait for a network timeout; never hold the shared map lock.
        let entry = self.entries.lock().ok()?.remove(key)?;
        if entry.fingerprint != fingerprint || entry.last_used.elapsed() > IMAP_LIVE_IDLE_TTL {
            // OAuth refresh changes the credential fingerprint. Never call bare
            // imap logout without panic protection — desynced pools panic here.
            retire_imap_session(entry.session);
            return None;
        }
        Some(entry.session)
    }

    pub(super) fn put(&self, key: ImapPoolKey, fingerprint: String, session: ActiveImapSession) {
        let old = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                key,
                LiveImapEntry {
                    fingerprint,
                    session,
                    last_used: Instant::now(),
                },
            );
        if let Some(old) = old {
            retire_imap_session(old.session);
        }
    }

    pub(super) fn invalidate_lane(&self, key: &ImapPoolKey) {
        let entry = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(key);
        if let Some(entry) = entry {
            retire_imap_session(entry.session);
        }
    }

    pub(super) fn invalidate(&self, account_id: &str) {
        for lane in [ImapLane::Interactive, ImapLane::Background] {
            self.invalidate_lane(&(account_id.to_string(), lane));
        }
    }
}

impl Default for MailImapPool {
    fn default() -> Self {
        Self::new()
    }
}

pub(super) fn mail_imap_fingerprint(account: &ResolvedMailAccount) -> String {
    let mut hasher = Sha256::new();
    hasher.update(account.config.session_id.as_bytes());
    hasher.update(b"|");
    hasher.update(account.config.imap.host.trim().as_bytes());
    hasher.update(b"|");
    hasher.update(account.config.imap.port.to_string().as_bytes());
    hasher.update(b"|");
    hasher.update(format!("{:?}", account.config.imap.security).as_bytes());
    hasher.update(b"|");
    hasher.update(account.imap_username.as_bytes());
    hasher.update(b"|");
    hasher.update(format!("{:?}", account.auth_mode).as_bytes());
    hasher.update(b"|");
    hasher.update(account.imap_password.as_bytes());
    hasher.update(b"|");
    hasher.update(network_fingerprint(account.network_settings.as_ref()).as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub(super) fn network_fingerprint(network: Option<&NetworkSettings>) -> String {
    let Some(net) = network else {
        return "direct".into();
    };
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}",
        net.proxy_kind,
        net.proxy_host,
        net.proxy_port,
        net.proxy_user,
        net.proxy_session_id,
        net.jump_session_id,
        net.jump_host,
        net.jump_port,
        net.jump_user,
    )
}

pub(super) fn is_imap_transport_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("connection")
        || message.contains("broken pipe")
        || message.contains("reset")
        || message.contains("timed out")
        || message.contains("timeout")
        || message.contains("eof")
        || message.contains("not connected")
        || message.contains("noop failed")
        || message.contains("tls")
        || message.contains("i/o")
        || message.contains("io error")
        || message.contains("protocol desync")
        || message.contains("desync")
}

/// Run an IMAP operation that may panic inside the imap crate (tag asserts)
/// and convert panics into transport errors so the pool can reconnect.
pub(super) fn imap_catch_result<R>(op: impl FnOnce() -> Result<R, String>) -> Result<R, String> {
    match catch_unwind(AssertUnwindSafe(op)) {
        Ok(result) => result,
        Err(_) => Err("IMAP protocol desync".into()),
    }
}

/// Checkout or connect an IMAP session, run `f`, then return the session to
/// the pool on success (unless `force_fresh`).
///
/// `runtime` is used only when starting a session-level proxy loopback
/// forwarder (`Handle::block_on`). Callers should pass `Handle::current()`
/// from the async side into `spawn_blocking` — do **not** call
/// `handle.enter()` for the whole blocking scope. Entering the runtime for the
/// entire IMAP op makes `reqwest::blocking` (OAuth refresh) panic in debug
/// builds when nested runtimes are dropped.
///
/// Emits lightweight timing diagnostics: whether the live session was reused,
/// checkout/connect ms, op ms, and whether a session-level proxy is in use.
/// Never consults the app global proxy.
pub(super) fn with_imap_session<R>(
    pool: &MailImapPool,
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
    opts: ImapSessionOpts,
    mut f: impl FnMut(&mut ActiveImapSession) -> Result<R, String>,
) -> Result<R, String> {
    let account_id = account.config.session_id.clone();
    let key = (account_id.clone(), opts.lane);
    let fingerprint = mail_imap_fingerprint(account);
    let session_proxy = account.network_settings.is_some();
    let total_start = Instant::now();

    let gate = pool.account_gate(&key);
    let _gate = gate
        .lock()
        .map_err(|_| "mail imap account lock poisoned".to_string())?;
    let queue_ms = total_start.elapsed().as_millis();

    let mut attempt =
        |force_connect: bool| -> Result<(R, ActiveImapSession, bool, u128, u128), String> {
            let checkout_start = Instant::now();
            let mut reused = false;
            let mut session = if force_connect || opts.force_fresh {
                if opts.force_fresh {
                    pool.invalidate_lane(&key);
                }
                imap_catch_result(|| connect_imap(account, runtime))?
            } else if let Some(mut session) = pool.take(&key, &fingerprint) {
                match session.noop() {
                    Ok(()) => {
                        reused = true;
                        session
                    }
                    Err(e) => {
                        tracing::debug!(
                            account_id = %account_id,
                            "mail imap live session probe failed; reconnecting: {e}"
                        );
                        retire_imap_session(session);
                        imap_catch_result(|| connect_imap(account, runtime))?
                    }
                }
            } else {
                imap_catch_result(|| connect_imap(account, runtime))?
            };
            let checkout_ms = checkout_start.elapsed().as_millis();

            let op_start = Instant::now();
            // `f` may panic on imap tag asserts; convert to Err and drop session.
            let op_result = catch_unwind(AssertUnwindSafe(|| f(&mut session)));
            match op_result {
                Ok(Ok(value)) => {
                    let op_ms = op_start.elapsed().as_millis();
                    Ok((value, session, reused, checkout_ms, op_ms))
                }
                Ok(Err(e)) => {
                    retire_imap_session(session);
                    Err(e)
                }
                Err(_) => {
                    drop(session);
                    Err("IMAP protocol desync".into())
                }
            }
        };

    let finish =
        |value: R, session: ActiveImapSession, reused: bool, checkout_ms: u128, op_ms: u128| -> R {
            if opts.force_fresh {
                retire_imap_session(session);
            } else {
                pool.put(key.clone(), fingerprint.clone(), session);
            }
            tracing::info!(
                account_id = %account_id,
                session_proxy,
                lane = ?opts.lane,
                queue_ms,
                reused,
                checkout_ms,
                op_ms,
                total_ms = total_start.elapsed().as_millis(),
                force_fresh = opts.force_fresh,
                "mail imap op"
            );
            value
        };

    match attempt(false) {
        Ok((value, session, reused, checkout_ms, op_ms)) => {
            Ok(finish(value, session, reused, checkout_ms, op_ms))
        }
        Err(e) if opts.retry_on_error && is_imap_transport_error(&e) => {
            tracing::debug!(
                account_id = %account_id,
                "mail imap op failed on live/new session; retrying once: {e}"
            );
            pool.invalidate_lane(&key);
            let (value, session, reused, checkout_ms, op_ms) = attempt(true)?;
            Ok(finish(value, session, reused, checkout_ms, op_ms))
        }
        Err(e) => {
            tracing::info!(
                account_id = %account_id,
                session_proxy,
                total_ms = total_start.elapsed().as_millis(),
                error = %e,
                "mail imap op failed"
            );
            Err(e)
        }
    }
}
