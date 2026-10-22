use super::authentication::KbdInteractivePrompter;
use super::authentication::SshAuth;
use super::authentication::authenticate;
use super::configuration::DEFAULT_PTY_MODES;
use super::configuration::build_client_config;
use super::transport::build_ssh_transport;
use crate::terminal::network::NetworkSettings;
use crate::terminal::x11_forward;
use crate::terminal::x11_forward::XForward;
use russh::ChannelId;
use russh::ChannelMsg;
use russh::ChannelReadHalf;
use russh::ChannelWriteHalf;
use russh::client;
use russh::client::Msg;
use russh::keys::PublicKey;
use std::future::Future;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::sync::mpsc::UnboundedSender;

pub struct SshSession {
    pub handle: client::Handle<SshHandler>,
}

pub struct SshHandler {
    pub output_tx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>>>,
    /// X11 forwarding config for this session, if enabled. When set, inbound
    /// `x11` channels opened by the server are bridged to the local X server.
    pub x11: Option<Arc<XForward>>,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        async {
            // TODO: proper host key verification
            Ok(true)
        }
    }

    fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut client::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            if let Some(tx) = self.output_tx.lock().await.as_ref() {
                let _ = tx.send(data.to_vec());
            }
            Ok(())
        }
    }

    fn extended_data(
        &mut self,
        _channel: ChannelId,
        _ext: u32,
        data: &[u8],
        _session: &mut client::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            if let Some(tx) = self.output_tx.lock().await.as_ref() {
                let _ = tx.send(data.to_vec());
            }
            Ok(())
        }
    }

    /// The remote opened an X11 channel (a forwarded X client wants to talk to
    /// our display). Bridge it to the local X server. We spawn the pump as a
    /// detached task so the SSH event loop keeps servicing other channels; the
    /// task ends when either side closes, and is torn down with the session.
    fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            if let Some(forward) = self.x11.clone() {
                tokio::spawn(async move {
                    let stream = channel.into_stream();
                    if let Err(e) = x11_forward::bridge(forward, stream).await {
                        tracing::debug!("X11 forward bridge ended: {}", e);
                    }
                });
            }
            // If X11 wasn't enabled for this session, dropping `channel` closes it.
            Ok(())
        }
    }
}

#[derive(Debug, Clone)]
pub struct SshStartupCommand {
    pub command: String,
    pub keep_open: bool,
}

pub async fn connect_ssh(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    cols: u16,
    rows: u16,
    network: Option<&NetworkSettings>,
    prompter: Option<&KbdInteractivePrompter>,
    x11: Option<Arc<XForward>>,
    startup: Option<&SshStartupCommand>,
) -> Result<
    (
        client::Handle<SshHandler>,
        ChannelWriteHalf<Msg>,
        tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    ),
    String,
> {
    let (output_tx, output_rx) = tokio::sync::mpsc::unbounded_channel();

    let config = build_client_config(network);

    let handler = SshHandler {
        output_tx: Arc::new(Mutex::new(None)),
        x11: x11.clone(),
    };

    let stream = build_ssh_transport(host, port, network).await?;
    let mut handle = client::connect_stream(config, stream, handler)
        .await
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    authenticate(&mut handle, username, auth, prompter).await?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed to open SSH channel: {}", e))?;

    channel
        .request_pty(
            false,
            "xterm-256color",
            cols as u32,
            rows as u32,
            0,
            0,
            DEFAULT_PTY_MODES,
        )
        .await
        .map_err(|e| format!("Failed to request PTY: {}", e))?;

    // Request X11 forwarding on the session channel before the shell starts so
    // the remote `$DISPLAY` is set for the login shell. A failure here is
    // non-fatal: we log and continue with a normal (non-X11) shell rather than
    // aborting the whole connection.
    if let Some(forward) = &x11 {
        if let Err(e) = channel
            .request_x11(
                false,
                !forward.trusted, // single_connection in untrusted mode
                forward.advertised_protocol.clone(),
                forward.advertised_cookie_hex.clone(),
                forward.display.screen,
            )
            .await
        {
            tracing::warn!("X11 forwarding request failed (continuing without): {}", e);
        }
    }

    if let Some(startup) = startup {
        if startup.keep_open {
            channel
                .request_shell(false)
                .await
                .map_err(|e| format!("Failed to request shell: {}", e))?;

            let mut command = startup.command.trim().as_bytes().to_vec();
            command.push(b'\r');
            channel
                .data_bytes(command)
                .await
                .map_err(|e| format!("Failed to send startup command: {}", e))?;
        } else {
            channel
                .exec(false, startup.command.trim().as_bytes().to_vec())
                .await
                .map_err(|e| format!("Failed to execute startup command: {}", e))?;
        }
    } else {
        channel
            .request_shell(false)
            .await
            .map_err(|e| format!("Failed to request shell: {}", e))?;
    }

    let (read_half, write_half) = channel.split();
    spawn_terminal_output_pump(read_half, output_tx);

    Ok((handle, write_half, output_rx))
}

pub(super) fn spawn_terminal_output_pump(
    mut read_half: ChannelReadHalf,
    output_tx: UnboundedSender<Vec<u8>>,
) {
    tokio::spawn(async move {
        while let Some(msg) = read_half.wait().await {
            match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if output_tx.send(data.to_vec()).is_err() {
                        break;
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
    });
}

/// Authenticate against the server and return the handle without opening a
/// PTY/shell. The SFTP module reuses this to open its own subsystem channel.
pub async fn connect_ssh_authenticated(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
) -> Result<client::Handle<SshHandler>, String> {
    connect_ssh_authenticated_with(host, port, username, auth, None).await
}

/// Same as `connect_ssh_authenticated` but allows callers to pass through
/// per-session network settings (proxy, keep-alive, IP version, …).
pub async fn connect_ssh_authenticated_with(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    network: Option<&NetworkSettings>,
) -> Result<client::Handle<SshHandler>, String> {
    connect_ssh_authenticated_with_prompter(host, port, username, auth, network, None).await
}

/// Same as `connect_ssh_authenticated_with` but lets UI callers surface
/// keyboard-interactive auth prompts (MFA/OTP) during the auth exchange.
pub async fn connect_ssh_authenticated_with_prompter(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    network: Option<&NetworkSettings>,
    prompter: Option<&KbdInteractivePrompter>,
) -> Result<client::Handle<SshHandler>, String> {
    let config = build_client_config(network);
    let handler = SshHandler {
        output_tx: Arc::new(Mutex::new(None)),
        x11: None,
    };

    let stream = build_ssh_transport(host, port, network).await?;
    let mut handle = client::connect_stream(config, stream, handler)
        .await
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    authenticate(&mut handle, username, auth, prompter).await?;
    Ok(handle)
}
