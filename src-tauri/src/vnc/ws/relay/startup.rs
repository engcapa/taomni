use super::runtime::run_relay;
use crate::terminal::network::NetworkSettings;
use crate::vnc::policy::VncClipboardPolicy;
use crate::vnc::policy::VncSecurityPolicy;
use crate::vnc::quality::QualityController;
use crate::vnc::queue::FrameQueueSender;
use crate::vnc::rfb::RfbConnection;
use crate::vnc::ws::ForwardTaskGuard;
use crate::vnc::ws::VNC_AUTH_TIMEOUT;
use crate::vnc::ws::VncControl;
use crate::vnc::ws::VncRelayOptions;
use crate::vnc::ws::VncSession;
use crate::vnc::ws::WsOutgoingText;
use crate::vnc::ws::transport;
use crate::vnc::ws::transport::dial_vnc_transport;
use futures::StreamExt;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

// ── Main entry point ────────────────────────────────────────────────

/// Connect to a VNC server and spawn the relay. Returns a session handle.
pub async fn spawn_vnc_relay(
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    network: Option<NetworkSettings>,
    security_policy: VncSecurityPolicy,
    view_only: bool,
    clipboard_policy: VncClipboardPolicy,
    options: VncRelayOptions,
    attempt: CancellationToken,
) -> Result<VncSession, String> {
    tokio::select! {
        result = spawn_vnc_relay_inner(
            host,
            port,
            username,
            password,
            network,
            security_policy,
            view_only,
            clipboard_policy,
            options,
            attempt.clone(),
        ) => result,
        _ = attempt.cancelled() => Err("VNC connection attempt stopped by the user".into()),
    }
}

#[allow(clippy::too_many_arguments)]
pub(in crate::vnc::ws) async fn spawn_vnc_relay_inner(
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    network: Option<NetworkSettings>,
    security_policy: VncSecurityPolicy,
    view_only: bool,
    clipboard_policy: VncClipboardPolicy,
    options: VncRelayOptions,
    attempt: CancellationToken,
) -> Result<VncSession, String> {
    let cancel = CancellationToken::new();
    let ws_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let quality = QualityController::new(options.picture_quality);
    let initial_profile = quality.applied().clone();

    // 1. Connect + handshake + auth. Route proxy and SSH-jump connections
    // through the shared loopback forwarder, allowing the synchronous RA2
    // framing code to keep its tested std::net transport while the upstream
    // network path remains fully asynchronous and cancellable.
    let transport = dial_vnc_transport(host.clone(), port, network).await?;
    let mut network_forward_guard = ForwardTaskGuard(transport.network_forward_task);
    let prepared = crate::vnc::tls::prepare_rfb_transport(
        transport.stream,
        &host,
        security_policy,
        VNC_AUTH_TIMEOUT,
        options.allow_unencrypted,
        username
            .as_deref()
            .is_some_and(|name| !name.trim().is_empty()),
    )
    .await?;
    let mut tls_guard = ForwardTaskGuard(prepared.tls_task);
    // Stop closes the socket so the blocking authentication read returns
    // instead of waiting for a slow server (VNC-SESS-003).
    let stop_handle = prepared
        .stream
        .try_clone()
        .map_err(|e| format!("clone VNC stream for stop: {e}"))?;
    let stop_watch = {
        let attempt = attempt.clone();
        tokio::spawn(async move {
            attempt.cancelled().await;
            let _ = stop_handle.shutdown(std::net::Shutdown::Both);
        })
    };
    let handshake = tokio::task::spawn_blocking(move || {
        let mut rfb = RfbConnection::from_negotiated_stream(
            prepared.stream,
            VNC_AUTH_TIMEOUT,
            security_policy,
            crate::vnc::limits::DecodeLimits::default(),
            prepared.proto_minor,
            prepared.pending_security,
            prepared.outer_security_type,
        )?;
        rfb.set_shared(options.shared);
        let server_init = rfb.authenticate_with_policy(
            username.as_deref(),
            password.as_deref(),
            security_policy,
        )?;
        // Encodings and pixel format come from the picture-quality profile
        // (quality.rs): ZRLE > Hextile > Tight > CopyRect > Raw for High,
        // Tight + JPEG first for Medium/Low. DesktopSize keeps server-driven
        // resolution changes working; ExtendedClipboard advertises
        // multi-format clipboard exchange.
        rfb.set_pixel_format(initial_profile.pixel_format)?;
        rfb.set_encodings(&initial_profile.encodings)?;
        rfb.request_update(false)?;
        rfb.enter_runtime_mode()?;
        let writer = rfb.take_writer()?;
        Ok::<_, String>((rfb, writer, server_init))
    });
    let handshake = handshake.await;
    stop_watch.abort();
    if attempt.is_cancelled() {
        return Err("VNC connection attempt stopped by the user".into());
    }
    let (rfb, writer, server_init) =
        handshake.map_err(|e| format!("VNC handshake worker failed: {e}"))??;
    // 2. Bind WS listener on dynamic port
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind WS: {}", e))?;
    let ws_port = listener
        .local_addr()
        .map_err(|e| format!("local addr: {}", e))?
        .port();
    // 3. Channel setup
    let limits = crate::vnc::limits::DecodeLimits::default();
    let (control_tx, control_rx) = mpsc::channel::<VncControl>(limits.max_control_queue);
    let (ws_out_tx, ws_out_rx) = FrameQueueSender::new(limits);

    // Send connected notification with the actual negotiated security, never
    // just the requested policy.
    let connected = serde_json::to_string(&WsOutgoingText::Connected {
        width: server_init.width,
        height: server_init.height,
        name: server_init.name.clone(),
        protocol: rfb.protocol_version(),
        security: rfb.security_label(),
        encrypted: rfb.encrypted(),
        native_pointer: crate::vnc::native_pointer::supported() && !view_only,
    })
    .unwrap();
    let _ = ws_out_tx.send_critical_control(connected);
    let shutdown_stream = rfb.shutdown_handle()?;
    let writer = Arc::new(tokio::sync::Mutex::new(writer));

    // 4. Spawn the relay
    let cancel_clone = cancel.clone();
    let cancel_guard = cancel.clone();
    let control_tx_for_relay = control_tx.clone();
    let ws_token_for_relay = ws_token.clone();
    tokio::spawn(async move {
        if let Err(e) = run_relay(
            listener,
            rfb,
            writer,
            ws_out_tx,
            ws_out_rx,
            control_tx_for_relay,
            control_rx,
            cancel_clone,
            ws_token_for_relay,
            shutdown_stream,
            view_only,
            clipboard_policy,
            Arc::new(std::sync::Mutex::new(quality)),
            options,
        )
        .await
        {
            tracing::error!("VNC relay error: {}", e);
        }
        cancel_guard.cancel();
    });

    Ok(VncSession {
        control_tx,
        ws_port,
        ws_token,
        cancel,
        network_forward_task: network_forward_guard.0.take(),
        tls_task: tls_guard.0.take(),
    })
}
