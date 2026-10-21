use super::authorization::accept_authorized_ws;
use super::model::RdpControl;
use super::model::RdpSession;
use super::model::RdpSpawnConfig;
use super::model::WsIncomingText;
use super::outgoing::WsOutgoing;
use super::outgoing::WsOutgoingQueue;
use super::outgoing::WsOutgoingReceiver;
use super::outgoing::WsOutgoingSender;
use super::wire::channel;
use super::wire::parse_binary_control;
use crate::rdp::session::RdpSessionConfig;
use crate::rdp::session::RdpSessionHandle;
use crate::rdp::session::SessionOutput;
use crate::rdp::session::start_ironrdp_session;
use crate::rdp::transport::open_transport;
use futures::SinkExt;
use futures::StreamExt;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::mpsc;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;
use tungstenite::Message;
use uuid::Uuid;

pub(super) const WS_ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const WS_PING_INTERVAL: Duration = Duration::from_secs(15);
pub(super) const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub(super) const WS_IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(5);

pub async fn spawn_rdp_relay(cfg: RdpSpawnConfig) -> Result<RdpSession, String> {
    let cancel = CancellationToken::new();
    let ws_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());

    // 1. Transport. Direct TCP, HTTP/SOCKS5 proxy, and RD Gateway all
    // converge on the same async stream abstraction; IronRDP owns all
    // RDP-layer negotiation after this point.
    let transport = open_transport(
        &cfg.host,
        cfg.port,
        cfg.network.as_ref(),
        cfg.options.gateway.as_ref(),
    )
    .await?;

    // 2. Bind WS listener before the IronRDP worker finishes authentication so
    // the frontend can show granular status updates.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("rdp: bind WS listener: {}", e))?;
    let ws_port = listener
        .local_addr()
        .map_err(|e| format!("rdp: local_addr: {}", e))?
        .port();

    let (control_tx, control_rx) = mpsc::unbounded_channel::<RdpControl>();
    let (ws_out_tx, ws_out_rx) = WsOutgoingQueue::new();

    // 3. Hand off to IronRDP: connector, TLS, CredSSP, active-stage display
    //    decoding, and input all run behind this handle.
    let session = start_ironrdp_session(RdpSessionConfig {
        stream: transport.stream,
        local_addr: transport.local_addr,
        host: cfg.host.clone(),
        port: cfg.port,
        username: cfg.username.clone(),
        password: cfg.password.clone(),
        options: cfg.options.clone(),
        network: cfg.network.clone(),
    });

    let cancel_clone = cancel.clone();
    let cancel_guard = cancel.clone();
    let control_tx_for_relay = control_tx.clone();
    let ws_token_for_relay = ws_token.clone();
    tokio::spawn(async move {
        if let Err(e) = run_relay(
            listener,
            session,
            ws_out_tx,
            ws_out_rx,
            control_tx_for_relay,
            control_rx,
            cancel_clone,
            ws_token_for_relay,
        )
        .await
        {
            tracing::error!("RDP relay error: {}", e);
        }
        // Always fire the cancellation token once the relay loop ends — even
        // on the early-return error paths — so the session-map reaper in
        // `rdp_connect` wakes up and drops the now-dead `RdpSession` entry.
        cancel_guard.cancel();
    });

    Ok(RdpSession {
        control_tx,
        ws_port,
        ws_token,
        cancel,
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_relay(
    listener: TcpListener,
    mut session: RdpSessionHandle,
    ws_out_tx: WsOutgoingSender,
    mut ws_out_rx: WsOutgoingReceiver,
    _control_tx: UnboundedSender<RdpControl>,
    mut control_rx: UnboundedReceiver<RdpControl>,
    cancel: CancellationToken,
    ws_token: String,
) -> Result<(), String> {
    let ws_stream = accept_authorized_ws(&listener, &ws_token, &cancel).await?;
    let (mut ws_sink, ws_reader) = ws_stream.split();
    let last_seen = std::sync::Arc::new(AsyncMutex::new(Instant::now()));

    // Pump outgoing → WS sink.
    let ws_write = tokio::spawn(async move {
        let mut ping = tokio::time::interval(WS_PING_INTERVAL);
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ping.tick().await;
        loop {
            tokio::select! {
                output = ws_out_rx.recv() => {
                    let Some(out) = output else { break; };
                    let msg = match out {
                        WsOutgoing::Frame(b) => Message::Binary(b.into()),
                        WsOutgoing::Text(t) => Message::Text(t.into()),
                    };
                    if ws_sink.send(msg).await.is_err() {
                        break;
                    }
                }
                _ = ping.tick() => {
                    if ws_sink
                        .send(Message::Ping(Vec::new().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });

    // Read WS → control_tx.
    let last_seen_read = last_seen.clone();
    let cancel_read = cancel.clone();
    let ctrl = _control_tx.clone();
    let ws_read = tokio::spawn(async move {
        let mut reader = ws_reader;
        while let Some(Ok(msg)) = reader.next().await {
            if cancel_read.is_cancelled() {
                break;
            }
            *last_seen_read.lock().await = Instant::now();
            match msg {
                Message::Binary(bytes) => {
                    if let Some(c) = parse_binary_control(&bytes) {
                        let _ = ctrl.send(c);
                    }
                }
                Message::Text(text) => {
                    if let Ok(parsed) = serde_json::from_str::<WsIncomingText>(&text) {
                        match parsed {
                            WsIncomingText::Ping | WsIncomingText::Ack => {
                                let _ = ctrl.send(RdpControl::Ack);
                            }
                            WsIncomingText::Clipboard { text } => {
                                let _ = ctrl.send(RdpControl::ClipboardData {
                                    format: 13, // CF_UNICODETEXT
                                    data: text.into_bytes(),
                                });
                            }
                            WsIncomingText::ClipboardFiles { paths } => {
                                let _ = ctrl.send(RdpControl::ClipboardFiles { paths });
                            }
                            WsIncomingText::Unicode { text } if text.chars().count() <= 4096 => {
                                let _ = ctrl.send(RdpControl::UnicodeText(text));
                            }
                            WsIncomingText::Unicode { .. } => {
                                tracing::warn!("ignored oversized RDP Unicode input message");
                            }
                            WsIncomingText::ReleaseInput => {
                                let _ = ctrl.send(RdpControl::ReleaseInput);
                            }
                            WsIncomingText::Resize { width, height } => {
                                let _ = ctrl.send(RdpControl::Resize { width, height });
                            }
                            WsIncomingText::Refresh => {
                                let _ = ctrl.send(RdpControl::Refresh);
                            }
                            WsIncomingText::Disconnect => {
                                let _ = ctrl.send(RdpControl::Disconnect);
                                break;
                            }
                        }
                    }
                }
                Message::Close(_) => {
                    let _ = ctrl.send(RdpControl::Disconnect);
                    break;
                }
                _ => {}
            }
        }
    });

    // Drive the session: forward display/status output to the WebSocket and
    // pass browser controls into IronRDP.
    let session_drive = tokio::spawn({
        let cancel = cancel.clone();
        let ws_out_clone = ws_out_tx.clone();
        async move {
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break,
                    msg = control_rx.recv() => match msg {
                        Some(RdpControl::Disconnect) => { cancel.cancel(); break; }
                        Some(other) => {
                            if let Err(e) = session.dispatch_control(other).await {
                                // The connection task queues its real error before
                                // dropping the control receiver. A late resize or
                                // input must not overwrite that diagnostic.
                                tracing::debug!(error = %e, "RDP control arrived after session ended");
                            }
                        }
                        None => break,
                    },
                    out = session.next_outgoing() => match out {
                        Some(SessionOutput::Channel { tag, payload }) => {
                            let mut frame = Vec::with_capacity(1 + payload.len());
                            frame.push(tag);
                            frame.extend_from_slice(&payload);
                            let _ = ws_out_clone.send(WsOutgoing::Frame(frame));
                        }
                        Some(SessionOutput::Text(text)) => {
                            let _ = ws_out_clone.send(WsOutgoing::Text(text));
                        }
                        None => break,
                    }
                }
            }
        }
    });

    // Idle watchdog.
    let watchdog_cancel = cancel.clone();
    let watchdog_last_seen = last_seen.clone();
    let idle_watch = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(WS_IDLE_CHECK_INTERVAL);
        ticker.tick().await;
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let elapsed = watchdog_last_seen.lock().await.elapsed();
                    if elapsed > WS_IDLE_TIMEOUT {
                        tracing::warn!(
                            "RDP relay idle for {:?} (> {:?}); disconnecting",
                            elapsed, WS_IDLE_TIMEOUT
                        );
                        watchdog_cancel.cancel();
                        break;
                    }
                }
                _ = watchdog_cancel.cancelled() => break,
            }
        }
    });

    tokio::select! {
        r = ws_write => { if let Err(e) = r { tracing::error!("ws_write: {}", e); } }
        r = ws_read => { if let Err(e) = r { tracing::error!("ws_read: {}", e); } }
        r = session_drive => { if let Err(e) = r { tracing::error!("session_drive: {}", e); } }
        r = idle_watch => { if let Err(e) = r { tracing::error!("idle_watch: {}", e); } }
    }
    cancel.cancel();
    Ok(())
}
