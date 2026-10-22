use super::authentication::AuthPolicy;
use super::authentication::load_authorized_keys_file;
use super::authentication::load_or_create_host_key;
use super::authentication::parse_authorized_keys_text;
use super::connection::SessionOpts;
use super::connection::SshConnection;
use crate::servers::ServerConfig;
use crate::servers::engine::LogEmitter;
use crate::servers::engine::ServerCtx;
use crate::servers::engine::ServerStarted;
use russh::MethodKind;
use russh::MethodSet;
use russh::server::Config as RusshConfig;
use russh::server::Server;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::time::Instant;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/* ----------------------------- server glue --------------------------- */

#[derive(Clone)]
pub(super) struct SshServer {
    pub(super) policy: Arc<AuthPolicy>,
    pub(super) opts: Arc<SessionOpts>,
    pub(super) log: LogEmitter,
    pub(super) cancel: CancellationToken,
    pub(super) active_sessions: Arc<AtomicUsize>,
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
            opts: self.opts.clone(),
            log: self.log.clone(),
            cancel: self.cancel.clone(),
            shells: HashMap::new(),
            pending_channels: Arc::new(Mutex::new(HashMap::new())),
            reverse_forwards: HashMap::new(),
            pty_sizes: HashMap::new(),
            pending_env: HashMap::new(),
            authed_user: None,
            auth_method: None,
            peer,
            connected_at: Instant::now(),
            session_slot: None,
            active_sessions: self.active_sessions.clone(),
        }
    }

    fn handle_session_error(&mut self, error: russh::Error) {
        // Routine teardown (client closed the socket) shows up here; keep it at
        // a low-key log line rather than treating it as a server failure.
        self.log.line(format!("session ended: {}", error));
    }
}

/* ------------------------------- start ------------------------------- */

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let port = if config.port == 0 { 22 } else { config.port };
    let bind = config.bind_address.clone();

    // Frontend fields (camelCase, flattened into `extra`):
    //   - password / authorizedKey / authorizedKeyPath / allowedUsers / rootDir
    //   - loginShell (bool) / maxSessions (u64)
    // "password" auth is against the configured value, never OS/PAM accounts.
    let password = {
        let p = config.str_field("password", "");
        if p.is_empty() {
            None
        } else {
            Some(p.to_string())
        }
    };
    let mut authorized_keys = Vec::new();
    let inline = config.str_field("authorizedKey", "");
    if !inline.trim().is_empty() {
        authorized_keys.extend(parse_authorized_keys_text(inline, "authorizedKey")?);
    }
    let key_path = config.str_field("authorizedKeyPath", "").trim().to_string();
    if !key_path.is_empty() {
        authorized_keys.extend(load_authorized_keys_file(&key_path)?);
    }
    if password.is_none() && authorized_keys.is_empty() {
        return Err(
            "SSH server needs at least one credential: set a password and/or \
             an authorized public key / key file before starting"
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
    if !root.exists() {
        return Err(format!(
            "SFTP root directory does not exist: '{}'",
            root.display()
        ));
    }
    if !root.is_dir() {
        return Err(format!(
            "SFTP root path is not a directory: '{}'",
            root.display()
        ));
    }

    let login_shell = config.bool_field("loginShell", true);
    let max_sessions = config.u64_field("maxSessions", 8).clamp(1, 256) as usize;

    // Bind the listening socket up front so "address already in use" / privilege
    // errors (port 22 needs root on Linux) surface as a startup Error.
    let listener = tokio::net::TcpListener::bind((bind.as_str(), port))
        .await
        .map_err(|e| {
            let hint = if port > 0 && port < 1024 {
                " (ports below 1024 often require elevated privileges)"
            } else {
                ""
            };
            format!("cannot bind {}:{} for SSH — {}{}", bind, port, e, hint)
        })?;

    let (host_key, fingerprint) = load_or_create_host_key(&ctx.app)?;
    let mut methods = MethodSet::empty();
    if password.is_some() {
        methods.push(MethodKind::Password);
    }
    if !authorized_keys.is_empty() {
        methods.push(MethodKind::PublicKey);
    }
    let russh_config = Arc::new(RusshConfig {
        inactivity_timeout: None,
        auth_rejection_time: std::time::Duration::from_secs(2),
        auth_rejection_time_initial: Some(std::time::Duration::from_secs(0)),
        methods,
        keys: vec![host_key],
        ..Default::default()
    });

    let policy = AuthPolicy {
        password,
        authorized_keys,
        allowed_users,
    };
    let opts = SessionOpts {
        root: Arc::new(root.clone()),
        login_shell,
        max_sessions,
    };

    let mut server = SshServer {
        policy: Arc::new(policy),
        opts: Arc::new(opts),
        log: ctx.log.clone(),
        cancel: ctx.cancel.clone(),
        active_sessions: Arc::new(AtomicUsize::new(0)),
    };

    ctx.log.line(format!(
        "SSH/SFTP server listening on {}:{} (root {}; max_sessions={}; login_shell={}; \
         port-forward -L/-R/-D enabled)",
        bind,
        port,
        root.display(),
        max_sessions,
        login_shell
    ));
    ctx.log
        .line(format!("SSH host key fingerprint: {}", fingerprint));

    let cancel = ctx.cancel.clone();
    let log = ctx.log.clone();
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
