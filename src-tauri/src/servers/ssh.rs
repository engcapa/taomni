//! Real in-process SSH/SFTP server built on `russh` 0.46 + `russh-sftp` 2.
//!
//! This is NOT an OS/PAM gateway: authentication is checked against credentials
//! supplied in the server config (a password and/or a single authorized public
//! key), never against system accounts. A successful shell session spawns the
//! local default shell in a PTY (via [`crate::terminal::pty`]) and bridges it to
//! the SSH channel; the `sftp` subsystem is served by an in-process handler
//! rooted at a configured directory.
//!
//! Server-specific config (`config.extra`, camelCase as sent by the frontend):
//!   - `password`      (string) accept password auth matching this value
//!   - `authorizedKey` (string) accept publickey auth matching this OpenSSH key
//!                              line ("ssh-ed25519 AAAA... [comment]")
//!   - `allowedUsers`  (string) comma-separated usernames; empty = any username
//!   - `rootDir`       (string) SFTP/shell root directory; default = home dir
//!
//! If neither `password` nor `authorizedKey` is set the server refuses to start
//! (an SSH server that accepts anyone is almost never what the user wants).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use russh::keys::key::{self, KeyPair, PublicKey};
use russh::server::{Auth, Config as RusshConfig, Handler as ServerHandler, Msg, Server, Session};
use russh::{Channel, ChannelId, CryptoVec, MethodSet};
use russh_sftp::protocol::{
    File, FileAttributes, Handle as SftpHandle, Name, Status, StatusCode, Version,
};
use std::io::{Read as _, Write as _};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::engine::{LogEmitter, ServerCtx, ServerStarted};
use super::ServerConfig;

/* ----------------------------- auth model ---------------------------- */

#[derive(Clone)]
struct AuthPolicy {
    password: Option<String>,
    authorized_key: Option<PublicKey>,
    allowed_users: Vec<String>,
}

impl AuthPolicy {
    fn user_allowed(&self, user: &str) -> bool {
        self.allowed_users.is_empty() || self.allowed_users.iter().any(|u| u == user)
    }
}

/* ----------------------------- server glue --------------------------- */

#[derive(Clone)]
struct SshServer {
    policy: Arc<AuthPolicy>,
    root: Arc<PathBuf>,
    log: LogEmitter,
    cancel: CancellationToken,
}

impl Server for SshServer {
    type Handler = SshConnection;

    fn new_client(&mut self, peer: Option<SocketAddr>) -> Self::Handler {
        if let Some(addr) = peer {
            self.log.line(format!("client connected from {}", addr));
        } else {
            self.log.line("client connected");
        }
        SshConnection {
            policy: self.policy.clone(),
            root: self.root.clone(),
            log: self.log.clone(),
            cancel: self.cancel.clone(),
            shells: HashMap::new(),
            pending_channels: Arc::new(Mutex::new(HashMap::new())),
            authed_user: None,
        }
    }

    fn handle_session_error(&mut self, error: russh::Error) {
        // Routine teardown (client closed the socket) shows up here; keep it at
        // a low-key log line rather than treating it as a server failure.
        self.log.line(format!("session ended: {}", error));
    }
}

/* ------------------------- per-connection state ----------------------- */

/// Writer half of a spawned shell's PTY, plus the resize handle.
struct ShellIo {
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

struct SshConnection {
    policy: Arc<AuthPolicy>,
    root: Arc<PathBuf>,
    log: LogEmitter,
    cancel: CancellationToken,
    /// Active shells keyed by channel id (PTY writer + master for resize).
    shells: HashMap<ChannelId, ShellIo>,
    /// Channels parked between `channel_open_session` and `subsystem_request`,
    /// so the SFTP subsystem can take ownership of the channel stream.
    pending_channels: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
    authed_user: Option<String>,
}

#[async_trait]
impl ServerHandler for SshConnection {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if !self.policy.user_allowed(user) {
            self.log.line(format!("password auth rejected: user '{}' not allowed", user));
            return Ok(reject());
        }
        match &self.policy.password {
            Some(expected) if expected == password => {
                self.authed_user = Some(user.to_string());
                self.log.line(format!("password auth accepted for '{}'", user));
                Ok(Auth::Accept)
            }
            Some(_) => {
                self.log.line(format!("password auth rejected for '{}'", user));
                Ok(reject())
            }
            None => Ok(reject()),
        }
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        offered: &key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        if !self.policy.user_allowed(user) {
            self.log.line(format!("publickey auth rejected: user '{}' not allowed", user));
            return Ok(reject());
        }
        match &self.policy.authorized_key {
            Some(authorized) if authorized == offered => {
                self.authed_user = Some(user.to_string());
                self.log.line(format!("publickey auth accepted for '{}'", user));
                Ok(Auth::Accept)
            }
            _ => {
                self.log.line(format!("publickey auth rejected for '{}'", user));
                Ok(reject())
            }
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        // Park the channel; either a shell or an sftp subsystem will claim it.
        let mut pending = self.pending_channels.lock().await;
        pending.insert(channel.id(), channel);
        Ok(true)
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Acknowledge the PTY and open the shell at the requested size. Most
        // clients send pty-req immediately before shell-req; opening here means
        // window dimensions are honored from the first byte. shell_request is
        // idempotent and won't open a second shell.
        session.channel_success(channel);
        self.ensure_shell(channel, col_width as u16, row_height as u16, session)
            .await;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // If a PTY was requested first, the shell already exists; otherwise open
        // one with a sensible default size (dumb, no-pty clients).
        if !self.shells.contains_key(&channel) {
            self.ensure_shell(channel, 80, 24, session).await;
        }
        session.channel_success(channel);
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(shell) = self.shells.get_mut(&channel) {
            if let Err(e) = shell.writer.write_all(data).and_then(|_| shell.writer.flush()) {
                self.log.line(format!("shell write error: {}", e));
            }
        }
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(shell) = self.shells.get(&channel) {
            let _ = crate::terminal::pty::resize_pty(
                shell.master.as_ref(),
                col_width as u16,
                row_height as u16,
            );
        }
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name == "sftp" {
            let channel = {
                let mut pending = self.pending_channels.lock().await;
                pending.remove(&channel_id)
            };
            let Some(channel) = channel else {
                session.channel_failure(channel_id);
                return Ok(());
            };
            session.channel_success(channel_id);
            self.log.line(format!(
                "sftp subsystem opened (root {})",
                self.root.display()
            ));
            let handler = SftpHandler::new(self.root.clone(), self.log.clone());
            russh_sftp::server::run(channel.into_stream(), handler).await;
            Ok(())
        } else {
            session.channel_failure(channel_id);
            Ok(())
        }
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.shells.remove(&channel);
        session.close(channel);
        Ok(())
    }

    async fn channel_close(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.shells.remove(&channel);
        Ok(())
    }
}

fn reject() -> Auth {
    Auth::Reject {
        proceed_with_methods: None,
    }
}

impl SshConnection {
    /// Open a local shell in a PTY for `channel` and start pumping its output
    /// to the SSH channel. Idempotent per channel.
    async fn ensure_shell(
        &mut self,
        channel: ChannelId,
        cols: u16,
        rows: u16,
        session: &mut Session,
    ) {
        if self.shells.contains_key(&channel) {
            return;
        }
        // This channel is interactive, not SFTP: drop the parked Channel handle
        // so its undrained receiver (which the session fills with a copy of every
        // inbound data packet) doesn't accumulate. We drive shell I/O via
        // `session.handle()` for output and `Handler::data` for input instead.
        {
            let mut pending = self.pending_channels.lock().await;
            pending.remove(&channel);
        }
        let cwd = Some(self.root.display().to_string());
        let (handle, mut reader, _id) =
            match crate::terminal::pty::create_pty(cols, rows, None, None, cwd) {
                Ok(t) => t,
                Err(e) => {
                    self.log.line(format!("failed to open shell PTY: {}", e));
                    let _ = session.handle().eof(channel).await;
                    return;
                }
            };

        let crate::terminal::pty::PtyHandle {
            writer,
            mut child,
            master,
            ..
        } = handle;

        self.shells.insert(channel, ShellIo { writer, master });

        // Pump PTY output -> SSH channel. portable-pty's reader is blocking, so
        // read on a blocking thread and forward chunks through a channel into an
        // async task that writes to the SSH session handle.
        let handle = session.handle();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let cancel = self.cancel.clone();
        let log = self.log.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => {
                        let _ = handle.eof(channel).await;
                        let _ = handle.close(channel).await;
                        break;
                    }
                    maybe = rx.recv() => {
                        match maybe {
                            Some(chunk) => {
                                if handle.data(channel, CryptoVec::from_slice(&chunk)).await.is_err() {
                                    break;
                                }
                            }
                            None => {
                                // PTY closed (shell exited). Report exit + EOF.
                                let code = match child.wait() {
                                    Ok(status) => status.exit_code(),
                                    Err(_) => 0,
                                };
                                let _ = handle.exit_status_request(channel, code).await;
                                let _ = handle.eof(channel).await;
                                let _ = handle.close(channel).await;
                                break;
                            }
                        }
                    }
                }
            }
            log.line("shell session closed");
        });
    }
}

/* ------------------------------- SFTP -------------------------------- */

/// In-process SFTP handler rooted at `root`. Paths from the client are treated
/// as absolute within the export and are confined to `root` (no escaping via
/// `..` or absolute paths).
struct SftpHandler {
    root: Arc<PathBuf>,
    log: LogEmitter,
    version: Option<u32>,
    /// Open file handles keyed by an opaque handle string we hand to the client.
    files: HashMap<String, Arc<Mutex<std::fs::File>>>,
    /// Open dir handles -> already-listed flag and the resolved path.
    dirs: HashMap<String, DirState>,
    next_handle: u64,
}

struct DirState {
    path: PathBuf,
    sent: bool,
}

impl SftpHandler {
    fn new(root: Arc<PathBuf>, log: LogEmitter) -> Self {
        Self {
            root,
            log,
            version: None,
            files: HashMap::new(),
            dirs: HashMap::new(),
            next_handle: 0,
        }
    }

    fn alloc_handle(&mut self, prefix: &str) -> String {
        let h = format!("{}-{}", prefix, self.next_handle);
        self.next_handle += 1;
        h
    }

    /// Map a client-supplied path (treated as absolute under the export root)
    /// onto a real filesystem path, refusing anything that escapes the root.
    fn resolve(&self, requested: &str) -> Result<PathBuf, StatusCode> {
        confine_path(&self.root, requested)
    }
}

/// Resolve a client SFTP path against the export `root`, treating the client's
/// view as rooted at "/" and rejecting any traversal that would climb above the
/// root. Pulled out as a free function so it can be unit-tested without an
/// `AppHandle`/`LogEmitter`.
fn confine_path(root: &Path, requested: &str) -> Result<PathBuf, StatusCode> {
    let rel = Path::new(requested);
    let mut out = root.to_path_buf();
    let mut depth: i32 = 0;
    for comp in rel.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => {
                // Reset to root; the export root is the client's "/".
                out = root.to_path_buf();
                depth = 0;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    return Err(StatusCode::PermissionDenied);
                }
                depth -= 1;
                out.pop();
            }
            Component::Normal(seg) => {
                depth += 1;
                out.push(seg);
            }
        }
    }
    Ok(out)
}

fn io_to_status(e: &std::io::Error) -> StatusCode {
    match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

impl russh_sftp::server::Handler for SftpHandler {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        if self.version.is_some() {
            return Err(StatusCode::ConnectionLost);
        }
        self.version = Some(version);
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        // Resolve to a canonical client-visible absolute path (rooted at "/").
        let resolved = self.resolve(&path)?;
        let display = canonical_client_path(&self.root, &resolved);
        Ok(Name {
            id,
            files: vec![File::dummy(display)],
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let p = self.resolve(&path)?;
        let meta = std::fs::metadata(&p).map_err(|e| io_to_status(&e))?;
        Ok(russh_sftp::protocol::Attrs {
            id,
            attrs: FileAttributes::from(&meta),
        })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let p = self.resolve(&path)?;
        let meta = std::fs::symlink_metadata(&p).map_err(|e| io_to_status(&e))?;
        Ok(russh_sftp::protocol::Attrs {
            id,
            attrs: FileAttributes::from(&meta),
        })
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?.clone();
        let guard = file.lock().await;
        let meta = guard.metadata().map_err(|e| io_to_status(&e))?;
        Ok(russh_sftp::protocol::Attrs {
            id,
            attrs: FileAttributes::from(&meta),
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<SftpHandle, Self::Error> {
        let p = self.resolve(&path)?;
        let meta = std::fs::metadata(&p).map_err(|e| io_to_status(&e))?;
        if !meta.is_dir() {
            return Err(StatusCode::NoSuchFile);
        }
        let handle = self.alloc_handle("dir");
        self.dirs.insert(handle.clone(), DirState { path: p, sent: false });
        Ok(SftpHandle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let state = self.dirs.get_mut(&handle).ok_or(StatusCode::Failure)?;
        if state.sent {
            return Err(StatusCode::Eof);
        }
        let mut files = Vec::new();
        let entries = std::fs::read_dir(&state.path).map_err(|e| io_to_status(&e))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let attrs = match entry.metadata() {
                Ok(m) => FileAttributes::from(&m),
                Err(_) => FileAttributes::default(),
            };
            files.push(File::new(name, attrs));
        }
        state.sent = true;
        Ok(Name { id, files })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: russh_sftp::protocol::OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<SftpHandle, Self::Error> {
        let p = self.resolve(&filename)?;
        let opts: std::fs::OpenOptions = pflags.into();
        let file = opts.open(&p).map_err(|e| io_to_status(&e))?;
        let handle = self.alloc_handle("file");
        self.files.insert(handle.clone(), Arc::new(Mutex::new(file)));
        Ok(SftpHandle { id, handle })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<russh_sftp::protocol::Data, Self::Error> {
        use std::io::{Read, Seek, SeekFrom};
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?.clone();
        let mut guard = file.lock().await;
        guard.seek(SeekFrom::Start(offset)).map_err(|e| io_to_status(&e))?;
        let mut buf = vec![0u8; len as usize];
        let n = guard.read(&mut buf).map_err(|e| io_to_status(&e))?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        buf.truncate(n);
        Ok(russh_sftp::protocol::Data { id, data: buf })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        use std::io::{Seek, SeekFrom, Write};
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?.clone();
        let mut guard = file.lock().await;
        guard.seek(SeekFrom::Start(offset)).map_err(|e| io_to_status(&e))?;
        guard.write_all(&data).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.files.remove(&handle);
        self.dirs.remove(&handle);
        Ok(ok_status(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let p = self.resolve(&filename)?;
        std::fs::remove_file(&p).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let p = self.resolve(&path)?;
        std::fs::create_dir(&p).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let p = self.resolve(&path)?;
        std::fs::remove_dir(&p).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let from = self.resolve(&oldpath)?;
        let to = self.resolve(&newpath)?;
        std::fs::rename(&from, &to).map_err(|e| io_to_status(&e))?;
        Ok(ok_status(id))
    }

    async fn setstat(
        &mut self,
        id: u32,
        _path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        // Accept-and-ignore: clients (scp, sftp) routinely set mode/time after
        // upload; failing here would abort otherwise-successful transfers.
        let _ = &self.log;
        Ok(ok_status(id))
    }

    async fn fsetstat(
        &mut self,
        id: u32,
        _handle: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        Ok(ok_status(id))
    }
}

/// Render a real path back to the client-visible absolute path (rooted at "/").
fn canonical_client_path(root: &Path, resolved: &Path) -> String {
    match resolved.strip_prefix(root) {
        Ok(rel) => {
            let s = rel.to_string_lossy().replace('\\', "/");
            if s.is_empty() {
                "/".to_string()
            } else {
                format!("/{}", s)
            }
        }
        Err(_) => "/".to_string(),
    }
}

/* ------------------------------- start ------------------------------- */

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let port = if config.port == 0 { 22 } else { config.port };
    let bind = config.bind_address.clone();

    // Build the auth policy from config. Refuse to start a wide-open server.
    let password = {
        let p = config.str_field("password", "");
        if p.is_empty() { None } else { Some(p.to_string()) }
    };
    let authorized_key = {
        let line = config.str_field("authorizedKey", "").trim().to_string();
        if line.is_empty() {
            None
        } else {
            Some(parse_authorized_key(&line)?)
        }
    };
    if password.is_none() && authorized_key.is_none() {
        return Err(
            "SSH server needs at least one credential — set a password and/or an \
             authorized public key in the server config"
                .to_string(),
        );
    }
    let allowed_users: Vec<String> = config
        .str_field("allowedUsers", "")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let root = {
        let configured = config.str_field("rootDir", "");
        if configured.is_empty() {
            dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
        } else {
            PathBuf::from(configured)
        }
    };
    if !root.is_dir() {
        return Err(format!("rootDir '{}' is not a directory", root.display()));
    }

    // Bind the listening socket up front so "address already in use" / privilege
    // errors (port 22 needs root on Linux) surface as a startup Error.
    let listener = tokio::net::TcpListener::bind((bind.as_str(), port))
        .await
        .map_err(|e| format!("cannot bind {}:{} for SSH — {}", bind, port, e))?;

    let host_key = KeyPair::generate_ed25519();
    let russh_config = Arc::new(RusshConfig {
        inactivity_timeout: None,
        auth_rejection_time: std::time::Duration::from_secs(2),
        auth_rejection_time_initial: Some(std::time::Duration::from_secs(0)),
        methods: MethodSet::PASSWORD | MethodSet::PUBLICKEY,
        keys: vec![host_key],
        ..Default::default()
    });

    let policy = AuthPolicy {
        password,
        authorized_key,
        allowed_users,
    };

    let mut server = SshServer {
        policy: Arc::new(policy),
        root: Arc::new(root.clone()),
        log: ctx.log.clone(),
        cancel: ctx.cancel.clone(),
    };

    ctx.log.line(format!(
        "SSH/SFTP server listening on {}:{} (root {})",
        bind,
        port,
        root.display()
    ));

    let cancel = ctx.cancel.clone();
    let log = ctx.log.clone();
    // Manual accept loop (instead of `run_on_socket`) so that cancelling the
    // server actively disconnects in-flight client sessions, not just stops
    // accepting new ones. Each connection runs in its own task that selects on
    // the same cancel token and tears its session down when fired.
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    log.line("SSH server stopped");
                    break;
                }
                accept = listener.accept() => {
                    let (stream, peer) = match accept {
                        Ok(pair) => pair,
                        Err(e) => {
                            log.line(format!("SSH accept error: {}", e));
                            continue;
                        }
                    };
                    let handler = server.new_client(Some(peer));
                    let cfg = russh_config.clone();
                    let conn_cancel = cancel.clone();
                    let conn_log = log.clone();
                    tokio::spawn(async move {
                        let session = match russh::server::run_stream(cfg, stream, handler).await {
                            Ok(s) => s,
                            Err(e) => {
                                conn_log.line(format!("SSH connection setup failed: {}", e));
                                return;
                            }
                        };
                        let handle = session.handle();
                        tokio::select! {
                            res = session => {
                                if let Err(e) = res {
                                    conn_log.line(format!("SSH session error: {}", e));
                                }
                            }
                            _ = conn_cancel.cancelled() => {
                                let _ = handle
                                    .disconnect(
                                        russh::Disconnect::ByApplication,
                                        "server shutting down".to_string(),
                                        "en-US".to_string(),
                                    )
                                    .await;
                            }
                        }
                    });
                }
            }
        }
    });

    Ok(ServerStarted { pid: None, task })
}

/// Parse a single OpenSSH `authorized_keys`-style line ("<algo> <base64> [comment]").
fn parse_authorized_key(line: &str) -> Result<PublicKey, String> {
    let mut parts = line.split_whitespace();
    let _algo = parts.next();
    let b64 = parts
        .next()
        .ok_or_else(|| "authorizedKey must be in 'ssh-... AAAA...' OpenSSH format".to_string())?;
    russh::keys::parse_public_key_base64(b64)
        .map_err(|e| format!("invalid authorizedKey: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confine_keeps_simple_paths_under_root() {
        let root = Path::new("/srv/share");
        assert_eq!(confine_path(root, "/").unwrap(), PathBuf::from("/srv/share"));
        assert_eq!(
            confine_path(root, "/a/b.txt").unwrap(),
            PathBuf::from("/srv/share/a/b.txt")
        );
        assert_eq!(
            confine_path(root, "sub/file").unwrap(),
            PathBuf::from("/srv/share/sub/file")
        );
    }

    #[test]
    fn confine_allows_parent_within_root() {
        let root = Path::new("/srv/share");
        // Descend then climb back to root — allowed because depth stays >= 0.
        assert_eq!(
            confine_path(root, "/a/../b").unwrap(),
            PathBuf::from("/srv/share/b")
        );
    }

    #[test]
    fn confine_rejects_escape_above_root() {
        let root = Path::new("/srv/share");
        assert_eq!(
            confine_path(root, "/../etc/passwd"),
            Err(StatusCode::PermissionDenied)
        );
        assert_eq!(
            confine_path(root, "/a/../../etc"),
            Err(StatusCode::PermissionDenied)
        );
    }

    #[test]
    fn confine_treats_absolute_segment_as_root_reset() {
        let root = Path::new("/srv/share");
        // A second leading-root resets to the export root rather than the FS root.
        assert_eq!(
            confine_path(root, "/a//b").unwrap(),
            PathBuf::from("/srv/share/a/b")
        );
    }

    #[test]
    fn client_path_renders_relative_to_root() {
        let root = Path::new("/srv/share");
        assert_eq!(canonical_client_path(root, Path::new("/srv/share")), "/");
        assert_eq!(
            canonical_client_path(root, Path::new("/srv/share/a/b")),
            "/a/b"
        );
    }

    #[test]
    fn authorized_key_parses_openssh_line() {
        // A valid ed25519 public key line (from russh-keys' own doctest).
        let line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ test@host";
        assert!(parse_authorized_key(line).is_ok());
        // Garbage base64 must error, not panic.
        assert!(parse_authorized_key("ssh-ed25519 not-base64!!").is_err());
        // Missing key body must error.
        assert!(parse_authorized_key("ssh-ed25519").is_err());
    }
}
