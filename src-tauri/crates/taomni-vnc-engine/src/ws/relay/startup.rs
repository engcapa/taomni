use super::runtime::run_relay;
use crate::policy::VncClipboardPolicy;
use crate::policy::VncSecurityPolicy;
use crate::quality::QualityController;
use crate::queue::FrameQueueSender;
use crate::ws::ForwardTaskGuard;
use crate::ws::NativeInput;
use crate::ws::VNC_AUTH_TIMEOUT;
use crate::ws::VncControl;
use crate::ws::VncDialedTransport;
use crate::ws::VncRelayOptions;
use crate::ws::VncSession;
use crate::ws::WsOutgoingText;
use std::future::Future;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

pub struct RelayRequest {
    /// Original server name for the TLS handshake, including forwarded sessions.
    pub host: String,
    pub username: Option<String>,
    pub password: Option<Zeroizing<String>>,
    pub security_policy: VncSecurityPolicy,
    pub view_only: bool,
    pub clipboard_policy: VncClipboardPolicy,
    pub options: VncRelayOptions,
}

/// Authenticate an RFB transport and start its WebSocket relay.
pub async fn spawn_relay(
    request: RelayRequest,
    dial: impl Future<Output = Result<VncDialedTransport, String>> + Send,
    native_input: NativeInput,
    attempt: CancellationToken,
) -> Result<VncSession, String> {
    tokio::select! {
        result = start_relay(
            request,
            dial,
            native_input,
            attempt.clone(),
        ) => result,
        _ = attempt.cancelled() => Err("VNC connection attempt stopped by the user".into()),
    }
}

async fn start_relay(
    request: RelayRequest,
    dial: impl Future<Output = Result<VncDialedTransport, String>> + Send,
    native_input: NativeInput,
    attempt: CancellationToken,
) -> Result<VncSession, String> {
    let RelayRequest {
        host,
        username,
        password,
        security_policy,
        view_only,
        clipboard_policy,
        options,
    } = request;
    let cancel = CancellationToken::new();
    let ws_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let quality = QualityController::new(options.picture_quality);
    let initial_profile = quality.applied().clone();

    // A direct or forwarded transport has the same RFB authentication path.
    let transport = dial.await?;
    let mut network_forward_guard = ForwardTaskGuard::new(transport.network_forward_task);
    let mut prepared = crate::tls::prepare_rfb_transport(
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
    let mut tls_guard = ForwardTaskGuard::new(prepared.take_tls_task());
    // Stop closes the socket so the blocking authentication read returns
    // instead of waiting for a slow server (VNC-SESS-003).
    let stop_handle = prepared
        .try_clone_stream()
        .map_err(|e| format!("clone VNC stream for stop: {e}"))?;
    let stop_watch = {
        let attempt = attempt.clone();
        tokio::spawn(async move {
            attempt.cancelled().await;
            let _ = stop_handle.shutdown(std::net::Shutdown::Both);
        })
    };
    let handshake = tokio::task::spawn_blocking(move || {
        let mut rfb = prepared.into_connection(
            VNC_AUTH_TIMEOUT,
            security_policy,
            crate::limits::DecodeLimits::default(),
        )?;
        rfb.set_shared(options.shared);
        let server_init = rfb.authenticate_with_policy(
            username.as_deref(),
            password.as_deref().map(String::as_str),
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
    let limits = crate::limits::DecodeLimits::default();
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
        native_pointer: native_input.pointer.is_some() && !view_only,
        native_special_keys: native_input.special_keys.is_some() && !view_only,
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
            native_input,
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
        network_forward_task: network_forward_guard.take(),
        tls_task: tls_guard.take(),
    })
}
