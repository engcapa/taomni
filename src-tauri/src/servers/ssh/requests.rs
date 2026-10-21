use super::authentication::reject;
use super::connection::ENV_WHITELIST;
use super::connection::SshConnection;
use super::forwarding::bridge_tcp_and_channel;
use super::forwarding::is_loopback_addr;
use super::forwarding::resolve_listen_addr;
use super::sftp_handler::SftpHandler;
use russh::Channel;
use russh::ChannelId;
use russh::keys::PublicKey;
use russh::server::Auth;
use russh::server::Handler as ServerHandler;
use russh::server::Msg;
use russh::server::Session;
use std::future::Future;
use std::io::Write as _;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

impl ServerHandler for SshConnection {
    type Error = russh::Error;

    fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> impl Future<Output = Result<Auth, Self::Error>> + Send {
        async move {
            if !self.policy.user_allowed(user) {
                self.log.line(format!(
                    "password auth rejected: user '{}' not allowed",
                    user
                ));
                return Ok(reject());
            }
            match &self.policy.password {
                Some(expected) if expected == password => {
                    if !self.try_acquire_session_slot() {
                        self.log.line(format!(
                            "password auth rejected: max sessions ({}) reached",
                            self.opts.max_sessions
                        ));
                        return Ok(reject());
                    }
                    self.authed_user = Some(user.to_string());
                    self.auth_method = Some("password");
                    self.log
                        .line(format!("password auth accepted for '{}'", user));
                    Ok(Auth::Accept)
                }
                Some(_) => {
                    self.log
                        .line(format!("password auth rejected for '{}'", user));
                    Ok(reject())
                }
                None => Ok(reject()),
            }
        }
    }

    fn auth_publickey(
        &mut self,
        user: &str,
        offered: &PublicKey,
    ) -> impl Future<Output = Result<Auth, Self::Error>> + Send {
        async move {
            if !self.policy.user_allowed(user) {
                self.log.line(format!(
                    "publickey auth rejected: user '{}' not allowed",
                    user
                ));
                return Ok(reject());
            }
            if self.policy.public_key_ok(offered) {
                if !self.try_acquire_session_slot() {
                    self.log.line(format!(
                        "publickey auth rejected: max sessions ({}) reached",
                        self.opts.max_sessions
                    ));
                    return Ok(reject());
                }
                self.authed_user = Some(user.to_string());
                self.auth_method = Some("publickey");
                self.log
                    .line(format!("publickey auth accepted for '{}'", user));
                Ok(Auth::Accept)
            } else {
                self.log
                    .line(format!("publickey auth rejected for '{}'", user));
                Ok(reject())
            }
        }
    }

    fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _session: &mut Session,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        async move {
            // Park the channel; either a shell or an sftp subsystem will claim it.
            let mut pending = self.pending_channels.lock().await;
            pending.insert(channel.id(), channel);
            Ok(true)
        }
    }

    /// Local (`-L`) and dynamic (`-D`) forwarding: client asks us to open a TCP
    /// connection to `host:port` and relay the channel.
    fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        originator_address: &str,
        originator_port: u32,
        _session: &mut Session,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        async move {
            if port_to_connect == 0 || port_to_connect > u32::from(u16::MAX) {
                self.log.line(format!(
                    "direct-tcpip rejected: invalid port {} (from {}:{})",
                    port_to_connect, originator_address, originator_port
                ));
                return Ok(false);
            }
            let host = host_to_connect.to_string();
            let port = port_to_connect as u16;
            let dest = format!("{}:{}", host, port);
            let log = self.log.clone();
            let cancel = self.cancel.clone();
            let origin = format!("{}:{}", originator_address, originator_port);
            self.log
                .line(format!("direct-tcpip → {} (origin {})", dest, origin));
            tokio::spawn(async move {
                let tcp = match TcpStream::connect((host.as_str(), port)).await {
                    Ok(s) => s,
                    Err(e) => {
                        log.line(format!("direct-tcpip connect to {} failed: {}", dest, e));
                        let _ = channel.close().await;
                        return;
                    }
                };
                log.line(format!("direct-tcpip established to {}", dest));
                bridge_tcp_and_channel(tcp, channel, cancel, log, format!("direct-tcpip {}", dest))
                    .await;
            });
            Ok(true)
        }
    }

    /// Remote forwarding (`-R`): client asks us to listen on `address:port` and
    /// open `forwarded-tcpip` channels back for each inbound TCP connection.
    fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut Session,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        async move {
            if *port > u32::from(u16::MAX) {
                self.log
                    .line(format!("tcpip-forward rejected: invalid port {}", *port));
                return Ok(false);
            }
            let listen_host = resolve_listen_addr(address);
            let requested_port = *port as u16;
            let listener = match TcpListener::bind((listen_host.as_str(), requested_port)).await {
                Ok(l) => l,
                Err(e) => {
                    self.log.line(format!(
                        "tcpip-forward bind {}:{} failed: {}",
                        listen_host, requested_port, e
                    ));
                    return Ok(false);
                }
            };
            let bound = match listener.local_addr() {
                Ok(a) => a,
                Err(e) => {
                    self.log
                        .line(format!("tcpip-forward local_addr failed: {}", e));
                    return Ok(false);
                }
            };
            let bound_port = bound.port() as u32;
            // RFC 4254: port 0 means "server allocates"; report the real port.
            *port = bound_port;

            if !is_loopback_addr(&listen_host) {
                self.log.line(format!(
                    "WARNING: remote forward listening on {} — reachable beyond this machine",
                    bound
                ));
            }

            // Replace any previous listener on the same (addr, port).
            let key = (listen_host.clone(), bound_port);
            if let Some(prev) = self.reverse_forwards.remove(&key) {
                prev.cancel();
            }
            let fwd_cancel = CancellationToken::new();
            self.reverse_forwards
                .insert(key.clone(), fwd_cancel.clone());

            let handle = session.handle();
            let log = self.log.clone();
            let session_cancel = self.cancel.clone();
            let connected_address = address.to_string();
            self.log.line(format!(
                "tcpip-forward listening on {} (advertised as {}:{})",
                bound, connected_address, bound_port
            ));

            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = fwd_cancel.cancelled() => break,
                        _ = session_cancel.cancelled() => break,
                        accept = listener.accept() => {
                            let (tcp, peer) = match accept {
                                Ok(p) => p,
                                Err(e) => {
                                    log.line(format!("tcpip-forward accept error: {}", e));
                                    break;
                                }
                            };
                            let peer_ip = peer.ip().to_string();
                            let peer_port = peer.port() as u32;
                            log.line(format!(
                                "forwarded-tcpip {} → session (listen {}:{})",
                                peer, connected_address, bound_port
                            ));
                            let handle = handle.clone();
                            let log = log.clone();
                            let connected_address = connected_address.clone();
                            let session_cancel = session_cancel.clone();
                            tokio::spawn(async move {
                                let channel = match handle
                                    .channel_open_forwarded_tcpip(
                                        connected_address.clone(),
                                        bound_port,
                                        peer_ip,
                                        peer_port,
                                    )
                                    .await
                                {
                                    Ok(ch) => ch,
                                    Err(e) => {
                                        log.line(format!(
                                            "forwarded-tcpip open to client failed: {}",
                                            e
                                        ));
                                        return;
                                    }
                                };
                                bridge_tcp_and_channel(
                                    tcp,
                                    channel,
                                    session_cancel,
                                    log,
                                    format!(
                                        "forwarded-tcpip {}:{} from {}",
                                        connected_address, bound_port, peer
                                    ),
                                )
                                .await;
                            });
                        }
                    }
                }
                log.line(format!(
                    "tcpip-forward listener stopped on {}:{}",
                    connected_address, bound_port
                ));
            });
            Ok(true)
        }
    }

    fn cancel_tcpip_forward(
        &mut self,
        address: &str,
        port: u32,
        _session: &mut Session,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        async move {
            let listen_host = resolve_listen_addr(address);
            let key = (listen_host.clone(), port);
            if let Some(token) = self.reverse_forwards.remove(&key) {
                token.cancel();
                self.log.line(format!(
                    "tcpip-forward cancelled on {}:{}",
                    listen_host, port
                ));
                Ok(true)
            } else {
                // Also try the raw address the client sent (in case it differed
                // from our normalized listen host).
                let raw_key = (address.to_string(), port);
                if let Some(token) = self.reverse_forwards.remove(&raw_key) {
                    token.cancel();
                    self.log
                        .line(format!("tcpip-forward cancelled on {}:{}", address, port));
                    Ok(true)
                } else {
                    self.log.line(format!(
                        "tcpip-forward cancel: no listener on {}:{}",
                        address, port
                    ));
                    Ok(false)
                }
            }
        }
    }

    fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            // Record size only — do not open a shell here so a following
            // `exec` request can use the PTY size without an interactive shell.
            self.pty_sizes
                .insert(channel, (col_width as u16, row_height as u16));
            let _ = session.channel_success(channel);
            Ok(())
        }
    }

    fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            let (cols, rows) = self.pty_sizes.remove(&channel).unwrap_or((80, 24));
            if !self.shells.contains_key(&channel) {
                self.ensure_shell(channel, cols, rows, session).await;
            }
            let _ = session.channel_success(channel);
            Ok(())
        }
    }

    fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            let command = String::from_utf8_lossy(data).into_owned();
            let (cols, rows) = self.pty_sizes.remove(&channel).unwrap_or((80, 24));
            self.log.line(format!(
                "exec request from {}: {}",
                self.authed_user.as_deref().unwrap_or("?"),
                command
            ));
            if self
                .ensure_exec(channel, &command, cols, rows, session)
                .await
            {
                let _ = session.channel_success(channel);
            } else {
                let _ = session.channel_failure(channel);
            }
            Ok(())
        }
    }

    fn env_request(
        &mut self,
        channel: ChannelId,
        variable_name: &str,
        variable_value: &str,
        session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            if ENV_WHITELIST.iter().any(|k| *k == variable_name) {
                self.pending_env
                    .insert(variable_name.to_string(), variable_value.to_string());
                let _ = session.channel_success(channel);
            } else {
                // Silently refuse non-whitelisted vars (OpenSSH-style).
                let _ = session.channel_failure(channel);
            }
            Ok(())
        }
    }

    fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            if let Some(shell) = self.shells.get_mut(&channel) {
                if let Err(e) = shell
                    .writer
                    .write_all(data)
                    .and_then(|_| shell.writer.flush())
                {
                    self.log.line(format!("shell write error: {}", e));
                }
            }
            Ok(())
        }
    }

    fn window_change_request(
        &mut self,
        channel: ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            if let Some(shell) = self.shells.get(&channel) {
                let _ = crate::terminal::pty::resize_pty(
                    shell.master.as_ref(),
                    col_width as u16,
                    row_height as u16,
                );
            }
            Ok(())
        }
    }

    fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
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
                    self.opts.root.display()
                ));
                let handler = SftpHandler::new(self.opts.root.clone(), self.log.clone());
                russh_sftp::server::run(channel.into_stream(), handler).await;
                Ok(())
            } else {
                session.channel_failure(channel_id);
                Ok(())
            }
        }
    }

    fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            self.shells.remove(&channel);
            session.close(channel);
            Ok(())
        }
    }

    fn channel_close(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            self.shells.remove(&channel);
            Ok(())
        }
    }
}
