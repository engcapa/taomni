use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use futures::{SinkExt, StreamExt};
use image::{ColorType, ImageEncoder};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::mpsc::{self, Receiver, Sender};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode, header};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_util::sync::CancellationToken;
use tungstenite::Message;
use uuid::Uuid;

use crate::terminal::network::NetworkSettings;
use crate::vnc::clipboard::{
    ACTION_NOTIFY, ACTION_PROVIDE, ACTION_REQUEST, ClipboardFormats, ExtendedClipboardMsg,
    FORMAT_HTML, FORMAT_RTF, FORMAT_TEXT,
    SUPPORTED_ACTIONS, build_caps_body, build_notify_body, build_provide_body, build_request_body,
};
use crate::vnc::encodings::DecodedCursor;
use crate::vnc::framebuffer::{Damage, FbRect, SharedFramebuffer};
use crate::vnc::policy::{VncClipboardPolicy, VncSecurityPolicy};
use crate::vnc::quality::{QualityController, VncPictureQuality};
use crate::vnc::queue::{FrameQueueReceiver, FrameQueueSender, QueuedWsOutgoing};
use crate::vnc::rfb::{RfbConnection, RfbWriter, RuntimeStats, ServerMessage, encoding_name};

/// Deadline for the frontend to complete its WebSocket upgrade after we bind.
const WS_ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
/// Native WebSocket ping cadence. Browser engines answer these at the network
/// layer even when background-tab JavaScript timers are throttled.
const WS_PING_INTERVAL: Duration = Duration::from_secs(15);
/// Backstop for a WebView that has stopped servicing the socket entirely.
const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How often the idle watchdog checks the last-seen timestamp.
const WS_IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const VNC_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const VNC_AUTH_TIMEOUT: Duration = Duration::from_secs(45);
const VNC_WS_PATH: &str = "/vnc";

// ── Messages for internal channels ──────────────────────────────────

/// Control messages from the WebSocket client toward the VNC event loop.
#[derive(Debug)]
pub enum VncControl {
    Key {
        down: bool,
        keysym: u32,
    },
    Pointer {
        x: u16,
        y: u16,
        buttons: u8,
    },
    Clipboard(String),
    /// Send an ExtendedClipboard payload using whatever formats the server has
    /// advertised support for. The relay handles caps negotiation and falls
    /// back to plain ClientCutText if the server didn't advertise the encoding.
    ExtendedClipboard(ClipboardFormats),
    Refresh,
    Ack,
    /// Picture quality chosen in the session menu (VNC-PERF-004).
    SetQuality(VncPictureQuality),
    Disconnect,
}

// ── JSON messages on the wire ───────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum WsIncoming {
    #[serde(rename = "ack")]
    Ack,
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "key")]
    Key { down: bool, keysym: u32 },
    #[serde(rename = "pointer")]
    Pointer {
        x: u16,
        y: u16,
        #[serde(default)]
        buttons: u8,
    },
    #[serde(rename = "clipboard")]
    Clipboard { text: String },
    #[serde(rename = "ext_clipboard")]
    ExtClipboard {
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        html: Option<String>,
        #[serde(default)]
        rtf: Option<String>,
    },
    #[serde(rename = "refresh")]
    Refresh,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum WsOutgoingText {
    #[serde(rename = "connected")]
    Connected {
        width: u16,
        height: u16,
        name: String,
        protocol: String,
        security: String,
        encrypted: bool,
    },
    #[serde(rename = "desktop_size")]
    DesktopSize {
        width: u16,
        height: u16,
        generation: u64,
    },
    #[serde(rename = "disconnected")]
    Disconnected {
        code: &'static str,
        stage: crate::vnc::error::VncStage,
        retryable: bool,
        reason: String,
    },
    #[serde(rename = "bell")]
    Bell,
    #[serde(rename = "clipboard")]
    Clipboard { text: String },
    /// Server delivered an ExtendedClipboard payload. The frontend writes the
    /// matching MIME types to the system clipboard.
    #[serde(rename = "ext_clipboard")]
    ExtClipboard {
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        html: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        rtf: Option<String>,
    },
    /// Tells the frontend whether the connected server negotiated the
    /// ExtendedClipboard pseudo-encoding. When false, the frontend types
    /// non-ASCII paste content as Unicode keysyms because the legacy
    /// ClientCutText channel is Latin-1 only and would mojibake CJK.
    #[serde(rename = "ext_clipboard_support")]
    ExtClipboardSupport { available: bool },
    #[serde(rename = "cursor")]
    Cursor {
        visible: bool,
        hotspot_x: u16,
        hotspot_y: u16,
        width: u16,
        height: u16,
        png_base64: String,
    },
    #[serde(rename = "pointer_pos")]
    PointerPos { x: u16, y: u16 },
    /// Once-per-second counters for the Session Information view.
    #[serde(rename = "stats")]
    Stats {
        requested_encoding: &'static str,
        last_encoding: &'static str,
        pixel_format: String,
        quality: &'static str,
        quality_level: &'static str,
        wire_kbps: u64,
        line_kbps: Option<u64>,
        updates_per_sec: f32,
        frames_per_sec: f32,
        update_ms: f32,
    },
}

const STATS_INTERVAL: Duration = Duration::from_secs(1);
/// RealVNC `KeepAliveInterval` / `KeepAliveResponseTimeout` (VNC-SESS-003):
/// after this much server silence send a 1x1 probe; after as much again
/// without any answer the connection is considered lost.
pub(crate) const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
pub(crate) const KEEPALIVE_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const RELAY_TICK: Duration = Duration::from_millis(250);

/// Options the viewer negotiates with the server (VNC-CONN-001).
#[derive(Debug, Clone, Copy)]
pub struct VncRelayOptions {
    pub picture_quality: VncPictureQuality,
    /// ClientInit shared flag (RealVNC `Shared=True`).
    pub shared: bool,
    /// Proceed when only an unencrypted security type is available; false
    /// stops before authentication so the viewer can warn (VNC-SESS-003).
    pub allow_unencrypted: bool,
    pub keepalive_interval: Duration,
    pub keepalive_timeout: Duration,
}

impl Default for VncRelayOptions {
    fn default() -> Self {
        Self {
            picture_quality: VncPictureQuality::default(),
            shared: true,
            allow_unencrypted: true,
            keepalive_interval: KEEPALIVE_INTERVAL,
            keepalive_timeout: KEEPALIVE_RESPONSE_TIMEOUT,
        }
    }
}

/// Labels of the current encoding profile for Session Information.
struct StatsLabels {
    requested: &'static str,
    quality: &'static str,
    level: &'static str,
}

// ── Public session handle ───────────────────────────────────────────

pub struct VncSession {
    pub control_tx: Sender<VncControl>,
    pub ws_port: u16,
    pub ws_token: String,
    pub cancel: CancellationToken,
    pub network_forward_task: Option<tokio::task::JoinHandle<()>>,
    pub tls_task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for VncSession {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.network_forward_task.as_ref() {
            task.abort();
        }
        if let Some(task) = self.tls_task.as_ref() {
            task.abort();
        }
    }
}

pub(crate) struct VncDialedTransport {
    pub stream: TcpStream,
    pub network_forward_task: Option<tokio::task::JoinHandle<()>>,
}

struct ForwardTaskGuard(Option<tokio::task::JoinHandle<()>>);

impl Drop for ForwardTaskGuard {
    fn drop(&mut self) {
        if let Some(task) = self.0.as_ref() {
            task.abort();
        }
    }
}

pub(crate) async fn dial_vnc_transport(
    host: String,
    port: u16,
    network: Option<NetworkSettings>,
) -> Result<VncDialedTransport, String> {
    tokio::time::timeout(VNC_CONNECT_TIMEOUT, async move {
        let network_forward = match network.as_ref() {
            Some(settings) if settings.proxy_kind != "none" && !settings.proxy_kind.is_empty() => {
                Some(crate::database::forward::start(host.clone(), port, settings.clone()).await?)
            }
            _ => None,
        };
        let local_port = network_forward.as_ref().map(|forward| forward.local_port);
        let mut forward_guard = ForwardTaskGuard(network_forward.map(|forward| forward.task));
        let socket = match local_port {
            Some(local_port) => TcpStream::connect(("127.0.0.1", local_port))
                .await
                .map_err(|e| format!("VNC TCP connection failed: {e}"))?,
            None => crate::terminal::network::establish_transport(&host, port, network.as_ref())
                .await
                .map_err(|e| format!("VNC TCP connection failed: {e}"))?,
        };
        Ok(VncDialedTransport {
            stream: socket,
            network_forward_task: forward_guard.0.take(),
        })
    })
    .await
    .map_err(|_| "VNC TCP connection timed out after 15 seconds".to_string())?
}

#[derive(Debug, Clone, Copy, Default)]
struct ServerClipboardCaps {
    formats: u32,
    actions: u32,
}

/// How long after the last frontend ACK the relay keeps pipelining update
/// requests. A hidden or stalled WebView stops acknowledging, so the server
/// goes quiet instead of the relay decoding updates nobody will paint.
const FRAME_STREAM_GRACE: Duration = Duration::from_secs(1);

/// Update pacing between the RFB server, the authoritative framebuffer and
/// the WebView. The relay requests the next incremental update as soon as one
/// is decoded (like RealVNC Viewer) and, independently, sends the WebView the
/// newest pixels of all accumulated damage whenever it has painted the
/// previous frame. Slow painting therefore never drops pixels or triggers a
/// full-refresh storm; it only coalesces more damage into the next frame.
struct FrameFlow {
    damage: Damage,
    frontend_ready: bool,
    last_ack: Instant,
    request_deferred: bool,
    frames_sent: u64,
    /// FramebufferUpdateRequests not yet answered by an update. Pixel-format
    /// switches wait for zero (DEC-VNC-15).
    outstanding: u32,
    last_update_at: Instant,
    /// Last byte-level sign of life from the server (any message).
    last_server_at: Instant,
    probe_sent_at: Option<Instant>,
}

impl FrameFlow {
    fn new() -> Self {
        Self {
            damage: Damage::default(),
            frontend_ready: true,
            last_ack: Instant::now(),
            request_deferred: false,
            frames_sent: 0,
            // The handshake already sent the first full request.
            outstanding: 1,
            last_update_at: Instant::now(),
            last_server_at: Instant::now(),
            probe_sent_at: None,
        }
    }

    fn streaming(&self) -> bool {
        self.frontend_ready || self.last_ack.elapsed() < FRAME_STREAM_GRACE
    }
}

type SharedFrameFlow = Arc<std::sync::Mutex<FrameFlow>>;

/// Rolling one-second window over the reader's runtime counters.
struct StatsWindow {
    started: Instant,
    wire_bytes: u64,
    updates: u64,
    frames: u64,
    update_micros: u64,
    line_kbps: Option<u64>,
    initialized: bool,
    /// Back-to-back updates (gap below `BURST_GAP`) merged into one transfer.
    burst: Option<(Instant, Instant, u64)>,
}

/// Updates separated by less than this are one server transfer for the
/// line-speed estimate; a single pipelined update can start with bytes the
/// kernel already buffered, which overstates the speed of short samples.
const BURST_GAP: Duration = Duration::from_millis(30);
const LINE_SPEED_MIN_BYTES: u64 = 256 * 1024;

impl StatsWindow {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            wire_bytes: 0,
            updates: 0,
            frames: 0,
            update_micros: 0,
            line_kbps: None,
            initialized: false,
            burst: None,
        }
    }

    fn close_burst(&mut self) {
        if let Some((start, end, bytes)) = self.burst.take() {
            let micros = end.duration_since(start).as_micros() as u64;
            if bytes >= LINE_SPEED_MIN_BYTES && micros > 0 {
                let sample = bytes * 8 * 1000 / micros;
                self.line_kbps = Some(match self.line_kbps {
                    Some(previous) => (previous * 3 + sample) / 4,
                    None => sample,
                });
            }
        }
    }

    fn observe(
        &mut self,
        stats: RuntimeStats,
        frames_sent: u64,
        labels: &StatsLabels,
    ) -> Option<String> {
        if !self.initialized {
            self.initialized = true;
            self.wire_bytes = stats.wire_bytes;
            self.updates = stats.updates.saturating_sub(1);
            self.frames = frames_sent.saturating_sub(1);
        }
        self.update_micros += stats.last_update_micros;
        if let (Some(start), Some(end)) =
            (stats.last_update_started_at, stats.last_update_finished_at)
        {
            match self.burst {
                Some((burst_start, burst_end, bytes))
                    if start.saturating_duration_since(burst_end) < BURST_GAP =>
                {
                    self.burst = Some((burst_start, end, bytes + stats.last_update_wire_bytes));
                }
                _ => {
                    self.close_burst();
                    self.burst = Some((start, end, stats.last_update_wire_bytes));
                }
            }
        }
        let elapsed = self.started.elapsed();
        if elapsed < STATS_INTERVAL {
            return None;
        }
        let seconds = elapsed.as_secs_f32();
        let updates = stats.updates.saturating_sub(self.updates);
        let frames = frames_sent.saturating_sub(self.frames);
        let message = WsOutgoingText::Stats {
            requested_encoding: labels.requested,
            last_encoding: stats.last_encoding.map(encoding_name).unwrap_or("-"),
            pixel_format: stats.pixel_format.label(),
            quality: labels.quality,
            quality_level: labels.level,
            wire_kbps: (stats.wire_bytes.saturating_sub(self.wire_bytes) as f32 * 8.0
                / 1000.0
                / seconds) as u64,
            line_kbps: self.line_kbps,
            updates_per_sec: updates as f32 / seconds,
            frames_per_sec: frames as f32 / seconds,
            update_ms: if updates > 0 {
                self.update_micros as f32 / 1000.0 / updates as f32
            } else {
                0.0
            },
        };
        self.started = Instant::now();
        self.wire_bytes = stats.wire_bytes;
        self.updates = stats.updates;
        self.frames = frames_sent;
        self.update_micros = 0;
        serde_json::to_string(&message).ok()
    }
}

/// Serialize the pending damage as one relay frame if the WebView is ready.
/// Returns true when a frame boundary was queued.
fn flush_frame(
    flow: &SharedFrameFlow,
    framebuffer: &SharedFramebuffer,
    ws_out: &FrameQueueSender,
) -> bool {
    let rects = {
        let Ok(mut flow) = flow.lock() else {
            return false;
        };
        if !flow.frontend_ready || flow.damage.is_empty() {
            return false;
        }
        flow.frontend_ready = false;
        flow.frames_sent += 1;
        flow.damage.take()
    };
    let frames: Vec<Vec<u8>> = match framebuffer.lock() {
        Ok(fb) => rects
            .into_iter()
            .filter_map(|rect| fb.relay_frame(rect))
            .collect(),
        Err(_) => return false,
    };
    for frame in frames {
        let _ = ws_out.push_rect(frame);
    }
    if ws_out.finish_frame().unwrap_or(false) {
        // Either an undelivered older frame was replaced (after a Refresh or
        // resize marked the WebView ready early) or this frame exceeded the
        // queue budget. The pixels of the lost frame are unknown here, so
        // repaint the whole surface with the next frame.
        damage_full_framebuffer(flow, framebuffer);
        if !ws_out.has_pending_frame()
            && let Ok(mut flow) = flow.lock()
        {
            // Nothing is in flight, so no ACK will arrive to release the
            // next frame.
            flow.frontend_ready = true;
        }
    }
    true
}

type SharedQuality = Arc<std::sync::Mutex<QualityController>>;

fn stats_labels(quality: &SharedQuality) -> StatsLabels {
    match quality.lock() {
        Ok(quality) => StatsLabels {
            requested: quality.applied().requested_label(),
            quality: quality.preset().label(),
            level: quality.level().label(),
        },
        Err(_) => StatsLabels {
            requested: "-",
            quality: "-",
            level: "-",
        },
    }
}

/// Send the pending encoding profile: SetEncodings, SetPixelFormat when it
/// changed, and a full update request so the new quality shows at once.
/// Callers make sure no update is outstanding when the format changes.
fn apply_pending_quality(
    writer: &mut RfbWriter,
    quality: &SharedQuality,
    flow: &SharedFrameFlow,
) -> Result<bool, String> {
    let Some((profile, format_changed)) = quality
        .lock()
        .map_err(|_| "VNC quality lock poisoned".to_string())?
        .take_pending()
    else {
        return Ok(false);
    };
    writer.set_encodings(&profile.encodings)?;
    if format_changed {
        writer.set_pixel_format(profile.pixel_format)?;
    }
    writer.request_update(false)?;
    if let Ok(mut flow) = flow.lock() {
        flow.outstanding = flow.outstanding.saturating_add(1);
    }
    Ok(true)
}

/// Whether the pending quality change can be sent now.
fn quality_ready(quality: &SharedQuality, flow: &SharedFrameFlow) -> bool {
    let Ok(quality) = quality.lock() else {
        return false;
    };
    if !quality.has_pending() {
        return false;
    }
    if !quality.pending_needs_sync() {
        return true;
    }
    flow.lock().map(|flow| flow.outstanding == 0).unwrap_or(false)
}

fn note_request(flow: &SharedFrameFlow) {
    if let Ok(mut flow) = flow.lock() {
        flow.outstanding = flow.outstanding.saturating_add(1);
    }
}

fn damage_full_framebuffer(flow: &SharedFrameFlow, framebuffer: &SharedFramebuffer) {
    let size = framebuffer
        .lock()
        .map(|fb| (fb.width(), fb.height()))
        .unwrap_or((0, 0));
    if let Ok(mut flow) = flow.lock() {
        flow.damage.add(FbRect::new(0, 0, size.0, size.1));
    }
}

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
async fn spawn_vnc_relay_inner(
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

// ── Relay orchestration ─────────────────────────────────────────────

async fn run_relay(
    listener: TcpListener,
    mut rfb: RfbConnection,
    writer: Arc<tokio::sync::Mutex<RfbWriter>>,
    ws_out_tx: FrameQueueSender,
    ws_out_rx: FrameQueueReceiver,
    control_tx: Sender<VncControl>,
    mut control_rx: Receiver<VncControl>,
    cancel: CancellationToken,
    ws_token: String,
    shutdown_stream: std::net::TcpStream,
    view_only: bool,
    clipboard_policy: VncClipboardPolicy,
    quality: SharedQuality,
    options: VncRelayOptions,
) -> Result<(), String> {
    let ws_stream = accept_authorized_ws(listener, &ws_token, &cancel).await?;

    let (mut ws_sink, ws_reader) = ws_stream.split();

    // Shared "last time we heard from the frontend" — updated on every ping/control.
    let last_seen = Arc::new(AsyncMutex::new(Instant::now()));

    // Server's advertised ExtendedClipboard formats/actions. Set on receipt of
    // the server's caps message; until then we fall back to plain ClientCutText.
    let server_clip_caps = Arc::new(AsyncMutex::new(ServerClipboardCaps::default()));
    // Cache the latest local clipboard payload so servers that follow the
    // notify/request/provide flow can request it after our paste shortcut.
    let latest_local_clipboard = Arc::new(AsyncMutex::new(None::<ClipboardFormats>));

    // Task: pump outgoing messages → WS sink
    let mut ws_write = tokio::spawn(async move {
        let mut ping = tokio::time::interval(WS_PING_INTERVAL);
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ping.tick().await;
        loop {
            tokio::select! {
                output = ws_out_rx.recv() => {
                    let Some(out) = output else { break; };
                    match out {
                        QueuedWsOutgoing::Control(json) => {
                            if ws_sink.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                        QueuedWsOutgoing::Frame(rects) => {
                            let mut failed = false;
                            for data in rects {
                                if ws_sink.send(Message::Binary(data.into())).await.is_err() {
                                    failed = true;
                                    break;
                                }
                            }
                            if failed
                                || ws_sink
                                    .send(Message::Binary(Vec::new().into()))
                                    .await
                                    .is_err()
                            {
                                break;
                            }
                        }
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

    // Task: read WS messages → control_tx
    let ctrl = control_tx.clone();
    let cancel_read = cancel.clone();
    let last_seen_read = last_seen.clone();
    let control_limits = crate::vnc::limits::DecodeLimits::default();
    let mut ws_read = tokio::spawn(async move {
        let mut reader = ws_reader;
        while let Some(Ok(msg)) = reader.next().await {
            if cancel_read.is_cancelled() {
                break;
            }
            // Any inbound message counts as the frontend being alive.
            *last_seen_read.lock().await = Instant::now();
            match msg {
                Message::Text(text) => {
                    if let Ok(incoming) = serde_json::from_str::<WsIncoming>(&text) {
                        let ctrl_msg = match incoming {
                            WsIncoming::Ack => Some(VncControl::Ack),
                            WsIncoming::Ping => None, // already refreshed last_seen
                            WsIncoming::Key { down, keysym } => {
                                Some(VncControl::Key { down, keysym })
                            }
                            WsIncoming::Pointer { x, y, buttons } => {
                                Some(VncControl::Pointer { x, y, buttons })
                            }
                            WsIncoming::Clipboard { text } => {
                                log::info!(
                                    "vnc.clip: ws→relay legacy clipboard, len={}",
                                    text.len()
                                );
                                Some(VncControl::Clipboard(text))
                            }
                            WsIncoming::ExtClipboard { text, html, rtf } => {
                                log::info!(
                                    "vnc.clip: ws→relay ext clipboard text_len={} html_len={} rtf_len={}",
                                    text.as_deref().map(str::len).unwrap_or(0),
                                    html.as_deref().map(str::len).unwrap_or(0),
                                    rtf.as_deref().map(str::len).unwrap_or(0),
                                );
                                Some(VncControl::ExtendedClipboard(ClipboardFormats {
                                    text,
                                    html,
                                    rtf,
                                }))
                            }
                            WsIncoming::Refresh => Some(VncControl::Refresh),
                        };
                        if let Some(m) = ctrl_msg
                            && control_allowed(&m, view_only, clipboard_policy, &control_limits)
                            && ctrl.send(m).await.is_err()
                        {
                            break;
                        }
                    }
                }
                Message::Binary(bytes) => {
                    if let Some(ctrl_msg) = parse_binary_control(&bytes)
                        && control_allowed(&ctrl_msg, view_only, clipboard_policy, &control_limits)
                        && ctrl.send(ctrl_msg).await.is_err()
                    {
                        break;
                    }
                }
                Message::Close(_) => {
                    let _ = ctrl.send(VncControl::Disconnect).await;
                    break;
                }
                _ => {}
            }
        }
    });

    // The RFB decoder is synchronous and may wait on a socket. Keep it on a
    // dedicated blocking worker and bridge decoded messages through a bounded
    // channel so no Tokio executor thread is stalled by a slow server.
    let initial_framebuffer_size = (rfb.width, rfb.height);
    let framebuffer = rfb.framebuffer();
    let flow: SharedFrameFlow = Arc::new(std::sync::Mutex::new(FrameFlow::new()));
    let (server_message_tx, mut server_message_rx) =
        mpsc::channel::<Result<(ServerMessage, u16, u16, RuntimeStats), String>>(2);
    let cancel_reader = cancel.clone();
    let rfb_reader = tokio::task::spawn_blocking(move || {
        while !cancel_reader.is_cancelled() {
            let result = rfb
                .read_server_message()
                .map(|message| (message, rfb.width, rfb.height, rfb.runtime_stats()));
            let should_stop = result.is_err();
            if server_message_tx.blocking_send(result).is_err() || should_stop {
                break;
            }
        }
    });

    // Task: process decoded server messages and push them to the WS queue.
    let rfb_writer_for_read = writer.clone();
    let ws_out = ws_out_tx.clone();
    let server_caps_read = server_clip_caps.clone();
    let latest_clipboard_read = latest_local_clipboard.clone();
    let writer_for_caps = writer.clone();
    let flow_read = flow.clone();
    let framebuffer_read = framebuffer.clone();
    let quality_read = quality.clone();
    let mut vnc_read = tokio::spawn(async move {
        let mut published_framebuffer_size = initial_framebuffer_size;
        let mut framebuffer_generation = 0u64;
        let mut window = StatsWindow::new();
        while let Some(result) = server_message_rx.recv().await {
            if let Ok(mut flow) = flow_read.lock() {
                flow.last_server_at = Instant::now();
                flow.probe_sent_at = None;
            }
            let (msg, fb_width, fb_height, stats) = match result {
                Ok(value) => value,
                Err(message) => {
                    let error = crate::vnc::error::VncError::classify(message);
                    let json = serde_json::to_string(&WsOutgoingText::Disconnected {
                        code: error.code,
                        stage: error.stage,
                        retryable: error.retryable,
                        reason: error.message,
                    })
                    .unwrap();
                    let _ = ws_out.send_critical_control(json);
                    break;
                }
            };
            match msg {
                ServerMessage::FramebufferUpdate {
                    rects,
                    cursor,
                    pointer_pos,
                } => {
                    if (fb_width, fb_height) != published_framebuffer_size {
                        framebuffer_generation = framebuffer_generation.saturating_add(1);
                        published_framebuffer_size = (fb_width, fb_height);
                        // Frames of the old geometry are obsolete; the WebView
                        // also drops whatever it had queued on desktop_size.
                        ws_out.clear_frames();
                        if let Ok(mut flow) = flow_read.lock() {
                            flow.damage.clear();
                            flow.frontend_ready = true;
                            flow.last_ack = Instant::now();
                        }
                        let json = serde_json::to_string(&WsOutgoingText::DesktopSize {
                            width: fb_width,
                            height: fb_height,
                            generation: framebuffer_generation,
                        })
                        .unwrap();
                        let _ = ws_out.send_critical_control(json);
                    }
                    if let Ok(mut quality) = quality_read.lock() {
                        quality.observe_update(
                            stats.last_update_pixel_rects > 0,
                            stats.last_update_tight_rects > 0,
                        );
                    }
                    let request_now = {
                        match flow_read.lock() {
                            Ok(mut flow) => {
                                flow.outstanding = flow.outstanding.saturating_sub(1);
                                flow.last_update_at = Instant::now();
                                for rect in rects {
                                    flow.damage.add(rect);
                                }
                                let streaming = flow.streaming();
                                flow.request_deferred = !streaming;
                                streaming
                            }
                            Err(_) => true,
                        }
                    };
                    {
                        let mut writer = rfb_writer_for_read.lock().await;
                        writer.set_framebuffer_size(fb_width, fb_height);
                        let pending_quality = quality_read
                            .lock()
                            .map(|quality| quality.has_pending())
                            .unwrap_or(false);
                        if pending_quality && quality_ready(&quality_read, &flow_read) {
                            // The switch includes its own full update request.
                            if let Err(error) =
                                apply_pending_quality(&mut writer, &quality_read, &flow_read)
                            {
                                tracing::warn!(%error, "VNC picture quality switch failed");
                            }
                        } else if request_now && !pending_quality {
                            // Pipeline the next incremental request immediately so
                            // server encoding overlaps relay and WebView painting.
                            if writer.request_update(true).is_ok() {
                                note_request(&flow_read);
                            }
                        } else if request_now {
                            // A pixel-format switch waits for the outstanding
                            // update; no new request until it has been sent.
                            if let Ok(mut flow) = flow_read.lock() {
                                flow.request_deferred = false;
                            }
                        }
                    }
                    if let Some(cursor) = cursor {
                        match serialize_cursor(cursor) {
                            Ok(json) => {
                                let _ = ws_out.send_control(json);
                            }
                            Err(error) => {
                                tracing::warn!(%error, "ignoring invalid VNC cursor update");
                            }
                        }
                    }
                    if let Some(pointer_pos) = pointer_pos {
                        let json = serde_json::to_string(&WsOutgoingText::PointerPos {
                            x: pointer_pos.x,
                            y: pointer_pos.y,
                        })
                        .unwrap();
                        let _ = ws_out.send_control(json);
                    }
                    flush_frame(&flow_read, &framebuffer_read, &ws_out);
                    let frames_sent = flow_read.lock().map(|flow| flow.frames_sent).unwrap_or(0);
                    let labels = stats_labels(&quality_read);
                    if let Some(json) = window.observe(stats, frames_sent, &labels) {
                        if let Ok(mut quality) = quality_read.lock() {
                            quality.observe_line_speed(window.line_kbps);
                        }
                        let _ = ws_out.send_control(json);
                    }
                }
                ServerMessage::Bell => {
                    let json = serde_json::to_string(&WsOutgoingText::Bell).unwrap();
                    let _ = ws_out.send_control(json);
                }
                ServerMessage::ServerCutText { text } => {
                    if !clipboard_policy.allows_server_to_client() {
                        continue;
                    }
                    log::info!("vnc.clip: server→client legacy cut text len={}", text.len());
                    let json = serde_json::to_string(&WsOutgoingText::Clipboard { text }).unwrap();
                    let _ = ws_out.send_control(json);
                }
                ServerMessage::ExtendedClipboard(ext) => {
                    if !server_clipboard_message_allowed(&ext, clipboard_policy) {
                        continue;
                    }
                    log::info!("vnc.clip: server→client ext clipboard message");
                    handle_server_ext_clipboard(
                        ext,
                        &server_caps_read,
                        &latest_clipboard_read,
                        &writer_for_caps,
                        &ws_out,
                    )
                    .await;
                }
                ServerMessage::SetColourMapEntries => {}
            }
        }
    });

    // Task: control loop — process commands from WS client
    let rfb_ctrl = writer.clone();
    let cl_cancel = cancel.clone();
    let server_caps_ctrl = server_clip_caps.clone();
    let latest_clipboard_ctrl = latest_local_clipboard.clone();
    let dispatch_limits = crate::vnc::limits::DecodeLimits::default();
    let flow_ctrl = flow.clone();
    let framebuffer_ctrl = framebuffer.clone();
    let ws_out_ctrl = ws_out_tx.clone();
    let quality_ctrl = quality.clone();
    let mut vnc_ctrl = tokio::spawn(async move {
        let mut deferred_ctrl: Option<VncControl> = None;
        let mut last_pointer_buttons = 0u8;
        loop {
            let ctrl = match deferred_ctrl.take() {
                Some(ctrl) => ctrl,
                None => match control_rx.recv().await {
                    Some(ctrl) => ctrl,
                    None => break,
                },
            };
            if cl_cancel.is_cancelled() {
                break;
            }
            let ctrl = coalesce_pointer_control(
                ctrl,
                &mut control_rx,
                &mut deferred_ctrl,
                last_pointer_buttons,
            );
            if let VncControl::Pointer { buttons, .. } = &ctrl {
                last_pointer_buttons = *buttons;
            }
            if !control_allowed(&ctrl, view_only, clipboard_policy, &dispatch_limits) {
                continue;
            }
            let result = match ctrl {
                VncControl::Ack => {
                    // The WebView painted the previous frame: hand it the
                    // accumulated damage and resume the request pipeline if a
                    // hidden period paused it.
                    let deferred = match flow_ctrl.lock() {
                        Ok(mut flow) => {
                            flow.frontend_ready = true;
                            flow.last_ack = Instant::now();
                            std::mem::take(&mut flow.request_deferred)
                        }
                        Err(_) => false,
                    };
                    flush_frame(&flow_ctrl, &framebuffer_ctrl, &ws_out_ctrl);
                    if deferred {
                        let mut writer = rfb_ctrl.lock().await;
                        if quality_ready(&quality_ctrl, &flow_ctrl) {
                            apply_pending_quality(&mut writer, &quality_ctrl, &flow_ctrl).map(|_| ())
                        } else {
                            let result = writer.request_update(true);
                            if result.is_ok() {
                                note_request(&flow_ctrl);
                            }
                            result
                        }
                    } else {
                        Ok(())
                    }
                }
                VncControl::Key { down, keysym } => {
                    rfb_ctrl.lock().await.send_key_event(down, keysym)
                }
                VncControl::Pointer { x, y, buttons } => {
                    rfb_ctrl.lock().await.send_pointer_event(x, y, buttons)
                }
                VncControl::Clipboard(text) => {
                    log::debug!("vnc.clip: relay→server legacy cut text len={}", text.len());
                    rfb_ctrl.lock().await.send_client_cut_text(&text)
                }
                VncControl::ExtendedClipboard(formats) => {
                    let server_caps = *server_caps_ctrl.lock().await;
                    *latest_clipboard_ctrl.lock().await = Some(formats.clone());
                    let mut conn = rfb_ctrl.lock().await;
                    if server_caps.formats == 0 {
                        // No caps received — server doesn't support ExtendedClipboard.
                        // Send UTF-8 bytes via legacy ClientCutText. RFC 6143 nominally
                        // specifies Latin-1, but vino and most modern servers accept UTF-8
                        // and write it directly into the X11 selection (which is UTF-8).
                        if let Some(text) = formats.text.as_deref() {
                            log::info!(
                                "vnc.clip: relay→server FALLBACK (no ext caps), sending legacy cut text (UTF-8) len={}",
                                text.len(),
                            );
                            conn.send_client_cut_text(text)
                        } else {
                            Ok(())
                        }
                    } else {
                        // Filter to formats the server actually supports.
                        let filtered = ClipboardFormats {
                            text: if server_caps.formats & FORMAT_TEXT != 0 {
                                formats.text
                            } else {
                                None
                            },
                            html: if server_caps.formats & FORMAT_HTML != 0 {
                                formats.html
                            } else {
                                None
                            },
                            rtf: if server_caps.formats & FORMAT_RTF != 0 {
                                formats.rtf
                            } else {
                                None
                            },
                        };
                        if filtered.format_mask() == 0 {
                            log::info!(
                                "vnc.clip: relay→server skip — server caps {:b} don't overlap with our payload",
                                server_caps.formats,
                            );
                            Ok(())
                        } else {
                            log::info!(
                                "vnc.clip: relay→server ext (server caps fmt={:b} actions={:b}) text_len={}",
                                server_caps.formats,
                                server_caps.actions,
                                filtered.text.as_deref().map(str::len).unwrap_or(0),
                            );
                            if can_send_notify(server_caps) {
                                conn.send_extended_clipboard(&build_notify_body(
                                    filtered.format_mask(),
                                ))
                            } else if can_send_provide(server_caps) {
                                match build_provide_body(&filtered) {
                                    Ok(body) => conn.send_extended_clipboard(&body),
                                    Err(e) => Err(e),
                                }
                            } else {
                                Ok(())
                            }
                        }
                    }
                }
                VncControl::Refresh => {
                    // The WebView lost pixels (or the user asked to refresh):
                    // repaint from the authoritative framebuffer right away and
                    // also ask the server for a full update.
                    if let Ok(mut flow) = flow_ctrl.lock() {
                        flow.frontend_ready = true;
                        flow.last_ack = Instant::now();
                        flow.request_deferred = false;
                    }
                    damage_full_framebuffer(&flow_ctrl, &framebuffer_ctrl);
                    flush_frame(&flow_ctrl, &framebuffer_ctrl, &ws_out_ctrl);
                    let result = rfb_ctrl.lock().await.request_update(false);
                    if result.is_ok() {
                        note_request(&flow_ctrl);
                    }
                    result
                }
                VncControl::SetQuality(preset) => {
                    if let Ok(mut quality) = quality_ctrl.lock() {
                        quality.set_preset(preset);
                    }
                    if quality_ready(&quality_ctrl, &flow_ctrl) {
                        let mut writer = rfb_ctrl.lock().await;
                        apply_pending_quality(&mut writer, &quality_ctrl, &flow_ctrl).map(|_| ())
                    } else {
                        Ok(())
                    }
                }
                VncControl::Disconnect => {
                    cl_cancel.cancel();
                    Ok(())
                }
            };
            if let Err(e) = result {
                tracing::error!("VNC control error: {}", e);
            }
        }
    });

    // Task: relay tick — force an overdue pixel-format switch (the server
    // merged our requests) and run the KeepAlive probe (VNC-SESS-003).
    let tick_flow = flow.clone();
    let tick_quality = quality.clone();
    let tick_writer = writer.clone();
    let tick_out = ws_out_tx.clone();
    let tick_cancel = cancel.clone();
    let mut relay_tick = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(RELAY_TICK);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = tick_cancel.cancelled() => break,
            }
            let (last_update, last_server, probe_sent) = match tick_flow.lock() {
                Ok(flow) => (flow.last_update_at, flow.last_server_at, flow.probe_sent_at),
                Err(_) => break,
            };
            let overdue = tick_quality
                .lock()
                .map(|quality| quality.pending_overdue(last_update))
                .unwrap_or(false);
            if overdue {
                if let Ok(mut flow) = tick_flow.lock() {
                    flow.outstanding = 0;
                }
                let mut writer = tick_writer.lock().await;
                if let Err(error) = apply_pending_quality(&mut writer, &tick_quality, &tick_flow) {
                    tracing::warn!(%error, "VNC picture quality switch failed");
                }
            }
            match probe_sent {
                Some(sent) if sent.elapsed() >= options.keepalive_timeout => {
                    let error = crate::vnc::error::VncError::classify(format!(
                        "VNC keepalive: no response from the server for {} s",
                        (last_server.elapsed().as_secs())
                    ));
                    let json = serde_json::to_string(&WsOutgoingText::Disconnected {
                        code: error.code,
                        stage: error.stage,
                        retryable: error.retryable,
                        reason: error.message,
                    })
                    .unwrap();
                    let _ = tick_out.send_critical_control(json);
                    // Give the writer a moment to deliver the reason.
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    tick_cancel.cancel();
                    break;
                }
                None if last_server.elapsed() >= options.keepalive_interval => {
                    let sent = tick_writer.lock().await.request_probe();
                    if sent.is_ok() {
                        if let Ok(mut flow) = tick_flow.lock() {
                            flow.outstanding = flow.outstanding.saturating_add(1);
                            flow.probe_sent_at = Some(Instant::now());
                        }
                    }
                }
                _ => {}
            }
        }
    });

    // Task: idle watchdog — if the frontend stops pinging, tear everything down.
    let watchdog_cancel = cancel.clone();
    let watchdog_last_seen = last_seen.clone();
    let mut idle_watch = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(WS_IDLE_CHECK_INTERVAL);
        // The first tick fires immediately; skip it so we don't race the ws_read task.
        ticker.tick().await;
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let elapsed = watchdog_last_seen.lock().await.elapsed();
                    if elapsed > WS_IDLE_TIMEOUT {
                        tracing::warn!(
                            "VNC relay idle for {:?} (> {:?}); disconnecting",
                            elapsed,
                            WS_IDLE_TIMEOUT
                        );
                        watchdog_cancel.cancel();
                        break;
                    }
                }
                _ = watchdog_cancel.cancelled() => break,
            }
        }
    });

    // Wait for any critical task to finish, then cancel everything
    tokio::select! {
        _ = cancel.cancelled() => {},
        _ = tokio::signal::ctrl_c() => {},
        r = &mut ws_write => {
            if let Err(e) = r { tracing::error!("ws_write: {}", e); }
        }
        r = &mut ws_read => {
            if let Err(e) = r { tracing::error!("ws_read: {}", e); }
        }
        r = &mut vnc_read => {
            if let Err(e) = r { tracing::error!("vnc_read: {}", e); }
        }
        r = &mut vnc_ctrl => {
            if let Err(e) = r { tracing::error!("vnc_ctrl: {}", e); }
        }
        r = &mut idle_watch => {
            if let Err(e) = r { tracing::error!("idle_watch: {}", e); }
        }
        r = &mut relay_tick => {
            if let Err(e) = r { tracing::error!("relay_tick: {}", e); }
        }
    }

    cancel.cancel();
    // Closing the underlying socket interrupts the blocking runtime read.
    let _ = shutdown_stream.shutdown(std::net::Shutdown::Both);
    rfb_reader.abort();
    ws_write.abort();
    ws_read.abort();
    vnc_read.abort();
    vnc_ctrl.abort();
    idle_watch.abort();
    relay_tick.abort();
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────

/// Drive the ExtendedClipboard handshake on receipt of a server message.
async fn handle_server_ext_clipboard(
    msg: ExtendedClipboardMsg,
    server_caps: &Arc<AsyncMutex<ServerClipboardCaps>>,
    latest_local_clipboard: &Arc<AsyncMutex<Option<ClipboardFormats>>>,
    writer: &Arc<tokio::sync::Mutex<RfbWriter>>,
    ws_out: &FrameQueueSender,
) {
    // We support UTF-8 text, RTF, and HTML — call out our caps with a generous
    // 16 MiB ceiling per format.
    const OUR_CAPS: u32 = FORMAT_TEXT | FORMAT_RTF | FORMAT_HTML;
    const MAX_SIZE: u32 = 16 * 1024 * 1024;

    match msg {
        ExtendedClipboardMsg::Caps {
            formats, actions, ..
        } => {
            log::info!(
                "vnc.clip: ← Caps from server formats={:b} actions={:b} (negotiated {:b})",
                formats,
                actions,
                formats & OUR_CAPS,
            );
            *server_caps.lock().await = ServerClipboardCaps {
                formats: formats & OUR_CAPS,
                actions,
            };
            // Reply with our caps so the server knows what to deliver.
            let body = build_caps_body(OUR_CAPS, MAX_SIZE);
            log::info!(
                "vnc.clip: → Caps to server formats={:b} actions={:b}",
                OUR_CAPS,
                SUPPORTED_ACTIONS,
            );
            let mut w = writer.lock().await;
            let _ = w.send_extended_clipboard(&body);
            // Tell the frontend which clipboard path is active so diagnostics
            // can distinguish ExtendedClipboard from the legacy fallback.
            let support = WsOutgoingText::ExtClipboardSupport {
                available: (formats & OUR_CAPS) != 0
                    && (actions & (ACTION_REQUEST | ACTION_NOTIFY | ACTION_PROVIDE)) != 0,
            };
            if let Ok(json) = serde_json::to_string(&support) {
                let _ = ws_out.send_control(json);
            }
        }
        ExtendedClipboardMsg::Notify { formats } => {
            let want = formats & OUR_CAPS;
            let caps = *server_caps.lock().await;
            log::info!(
                "vnc.clip: ← Notify from server formats={:b}, requesting={:b}",
                formats,
                want,
            );
            if want != 0 && can_send_request(caps) {
                let body = build_request_body(want);
                let mut w = writer.lock().await;
                let _ = w.send_extended_clipboard(&body);
            }
        }
        ExtendedClipboardMsg::Provide {
            formats: _,
            formats_data,
        } => {
            log::info!(
                "vnc.clip: ← Provide from server text_len={} html_len={} rtf_len={}",
                formats_data.text.as_deref().map(str::len).unwrap_or(0),
                formats_data.html.as_deref().map(str::len).unwrap_or(0),
                formats_data.rtf.as_deref().map(str::len).unwrap_or(0),
            );
            let json = serde_json::to_string(&WsOutgoingText::ExtClipboard {
                text: formats_data.text,
                html: formats_data.html,
                rtf: formats_data.rtf,
            })
            .unwrap();
            let _ = ws_out.send_control(json);
        }
        ExtendedClipboardMsg::Request { formats } => {
            log::info!("vnc.clip: ← Request from server formats={:b}", formats);
            let cached = latest_local_clipboard.lock().await.clone();
            if let Some(data) = cached {
                let filtered = filter_clipboard_formats(data, formats & OUR_CAPS);
                if filtered.format_mask() != 0 {
                    if let Ok(body) = build_provide_body(&filtered) {
                        let mut w = writer.lock().await;
                        let _ = w.send_extended_clipboard(&body);
                    }
                }
            }
        }
        ExtendedClipboardMsg::Peek => {
            log::info!("vnc.clip: ← Peek from server");
            let formats = latest_local_clipboard
                .lock()
                .await
                .as_ref()
                .map(|data| data.format_mask() & OUR_CAPS)
                .unwrap_or(0);
            let body = build_notify_body(formats);
            let mut w = writer.lock().await;
            let _ = w.send_extended_clipboard(&body);
        }
    }
}

fn filter_clipboard_formats(data: ClipboardFormats, mask: u32) -> ClipboardFormats {
    ClipboardFormats {
        text: if mask & FORMAT_TEXT != 0 {
            data.text
        } else {
            None
        },
        html: if mask & FORMAT_HTML != 0 {
            data.html
        } else {
            None
        },
        rtf: if mask & FORMAT_RTF != 0 {
            data.rtf
        } else {
            None
        },
    }
}

fn can_send_request(caps: ServerClipboardCaps) -> bool {
    caps.actions == 0 || caps.actions & ACTION_REQUEST != 0
}

fn can_send_notify(caps: ServerClipboardCaps) -> bool {
    caps.actions == 0 || caps.actions & ACTION_NOTIFY != 0
}

fn can_send_provide(caps: ServerClipboardCaps) -> bool {
    caps.actions == 0 || caps.actions & ACTION_PROVIDE != 0
}

fn serialize_cursor(cursor: DecodedCursor) -> Result<String, String> {
    if cursor.width == 0 || cursor.height == 0 {
        return serde_json::to_string(&WsOutgoingText::Cursor {
            visible: false,
            hotspot_x: 0,
            hotspot_y: 0,
            width: 0,
            height: 0,
            png_base64: String::new(),
        })
        .map_err(|e| format!("serialize hidden VNC cursor: {e}"));
    }

    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            &cursor.rgba,
            u32::from(cursor.width),
            u32::from(cursor.height),
            ColorType::Rgba8.into(),
        )
        .map_err(|e| format!("encode VNC cursor PNG: {e}"))?;
    serde_json::to_string(&WsOutgoingText::Cursor {
        visible: true,
        hotspot_x: cursor.hotspot_x,
        hotspot_y: cursor.hotspot_y,
        width: cursor.width,
        height: cursor.height,
        png_base64: BASE64_STANDARD.encode(png),
    })
    .map_err(|e| format!("serialize VNC cursor: {e}"))
}

fn parse_binary_control(bytes: &[u8]) -> Option<VncControl> {
    match bytes.first().copied()? {
        0 if bytes.len() == 1 => Some(VncControl::Ack),
        1 if bytes.len() == 1 => None,
        2 if bytes.len() == 6 => {
            let down = bytes[1] != 0;
            let keysym = u32::from_be_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]);
            Some(VncControl::Key { down, keysym })
        }
        3 if bytes.len() == 6 => {
            let buttons = bytes[1];
            let x = u16::from_be_bytes([bytes[2], bytes[3]]);
            let y = u16::from_be_bytes([bytes[4], bytes[5]]);
            Some(VncControl::Pointer { x, y, buttons })
        }
        4 if bytes.len() == 1 => Some(VncControl::Refresh),
        5 if bytes.len() == 2 => VncPictureQuality::from_wire(bytes[1]).map(VncControl::SetQuality),
        _ => None,
    }
}

fn coalesce_pointer_control(
    ctrl: VncControl,
    control_rx: &mut Receiver<VncControl>,
    deferred_ctrl: &mut Option<VncControl>,
    last_buttons: u8,
) -> VncControl {
    let (mut x, mut y, buttons) = match ctrl {
        VncControl::Pointer { x, y, buttons } => (x, y, buttons),
        other => return other,
    };

    if buttons != last_buttons {
        return VncControl::Pointer { x, y, buttons };
    }

    loop {
        match control_rx.try_recv() {
            Ok(VncControl::Pointer {
                x: next_x,
                y: next_y,
                buttons: next_buttons,
            }) if next_buttons == buttons => {
                x = next_x;
                y = next_y;
            }
            Ok(other @ VncControl::Pointer { .. }) => {
                *deferred_ctrl = Some(other);
                break;
            }
            Ok(other) => {
                *deferred_ctrl = Some(other);
                break;
            }
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
        }
    }

    VncControl::Pointer { x, y, buttons }
}

fn control_allowed(
    control: &VncControl,
    view_only: bool,
    clipboard_policy: VncClipboardPolicy,
    limits: &crate::vnc::limits::DecodeLimits,
) -> bool {
    match control {
        VncControl::Key { .. } | VncControl::Pointer { .. } => !view_only,
        VncControl::Clipboard(text) => {
            clipboard_policy.allows_client_to_server() && limits.clipboard_bytes(text.len()).is_ok()
        }
        VncControl::ExtendedClipboard(formats) => {
            clipboard_policy.allows_client_to_server()
                && [
                    formats.text.as_deref(),
                    formats.html.as_deref(),
                    formats.rtf.as_deref(),
                ]
                .into_iter()
                .flatten()
                .try_fold(0usize, |total, value| {
                    limits.clipboard_bytes(value.len()).ok()?;
                    total.checked_add(value.len())
                })
                .is_some_and(|total| total <= limits.max_clipboard_decompressed_bytes)
        }
        VncControl::Refresh
        | VncControl::Ack
        | VncControl::SetQuality(_)
        | VncControl::Disconnect => true,
    }
}

fn server_clipboard_message_allowed(
    message: &ExtendedClipboardMsg,
    policy: VncClipboardPolicy,
) -> bool {
    match message {
        ExtendedClipboardMsg::Caps { .. } => true,
        ExtendedClipboardMsg::Request { .. } | ExtendedClipboardMsg::Peek => {
            policy.allows_client_to_server()
        }
        ExtendedClipboardMsg::Notify { .. } | ExtendedClipboardMsg::Provide { .. } => {
            policy.allows_server_to_client()
        }
    }
}

async fn accept_authorized_ws(
    listener: TcpListener,
    ws_token: &str,
    cancel: &CancellationToken,
) -> Result<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, String> {
    let deadline = tokio::time::Instant::now() + WS_ACCEPT_TIMEOUT;
    let expected_protocol = format!("taomni-vnc.{ws_token}");
    let relay_limits = crate::vnc::limits::DecodeLimits::default();
    loop {
        let (stream, _) = tokio::select! {
            accepted = tokio::time::timeout_at(deadline, listener.accept()) => match accepted {
                Ok(Ok(pair)) => pair,
                Ok(Err(error)) => return Err(format!("VNC WebSocket accept failed: {error}")),
                Err(_) => {
                    tracing::warn!("VNC WS authorization timed out after {:?}", WS_ACCEPT_TIMEOUT);
                    return Err("VNC WebSocket authorization timed out".into());
                }
            },
            _ = cancel.cancelled() => return Err("VNC relay cancelled".into()),
        };
        stream
            .set_nodelay(true)
            .map_err(|error| format!("configure VNC WebSocket TCP_NODELAY: {error}"))?;

        let protocol = expected_protocol.clone();
        let callback = move |request: &Request, mut response: Response| {
            let has_protocol = request
                .headers()
                .get(header::SEC_WEBSOCKET_PROTOCOL)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.split(',').any(|item| item.trim() == protocol));
            let origin_ok = request
                .headers()
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                .is_some_and(is_authorized_origin);
            let path_ok = request.uri().path() == VNC_WS_PATH;
            if !has_protocol || !origin_ok || !path_ok {
                let mut rejection = ErrorResponse::new(Some("forbidden".to_string()));
                *rejection.status_mut() = StatusCode::FORBIDDEN;
                return Err(rejection);
            }
            response.headers_mut().insert(
                header::SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_str(&protocol).expect("generated VNC protocol is valid"),
            );
            Ok(response)
        };
        let ws_config = WebSocketConfig::default()
            .max_message_size(Some(relay_limits.max_relay_message_bytes))
            .max_frame_size(Some(relay_limits.max_relay_message_bytes))
            .max_write_buffer_size(relay_limits.max_frame_queue_bytes);
        match tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(ws_config))
            .await
        {
            Ok(socket) => return Ok(socket),
            Err(error) => tracing::warn!("rejected unauthorized VNC WebSocket attempt: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::vnc::encodings::ENCODING_DESKTOP_SIZE;
    use super::*;
    use tokio::sync::oneshot;
    use tokio_tungstenite::connect_async;
    use tungstenite::client::IntoClientRequest;

    fn ws_request(
        port: u16,
        path: &str,
        protocol: &str,
        origin: &'static str,
    ) -> tungstenite::handshake::client::Request {
        let mut request = format!("ws://127.0.0.1:{port}{path}")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(header::ORIGIN, HeaderValue::from_static(origin));
        request.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_str(protocol).unwrap(),
        );
        request
    }

    #[test]
    fn binary_control_decodes_key_pointer_and_refresh() {
        match parse_binary_control(&[2, 1, 0, 0, 0xff, 0x0d]) {
            Some(VncControl::Key { down, keysym }) => {
                assert!(down);
                assert_eq!(keysym, 0xff0d);
            }
            other => panic!("expected key control, got {:?}", other),
        }

        match parse_binary_control(&[3, 1, 0x01, 0x02, 0x03, 0x04]) {
            Some(VncControl::Pointer { x, y, buttons }) => {
                assert_eq!(x, 0x0102);
                assert_eq!(y, 0x0304);
                assert_eq!(buttons, 1);
            }
            other => panic!("expected pointer control, got {:?}", other),
        }

        assert!(matches!(
            parse_binary_control(&[4]),
            Some(VncControl::Refresh)
        ));
        assert!(parse_binary_control(&[4, 0]).is_none());
    }

    #[test]
    fn binary_control_decodes_ack_and_ignores_ping() {
        assert!(matches!(parse_binary_control(&[0]), Some(VncControl::Ack)));
        assert!(parse_binary_control(&[1]).is_none());
        assert!(parse_binary_control(&[3, 0]).is_none());
    }

    #[test]
    fn rich_cursor_serializes_as_a_bounded_png_message() {
        let json = serialize_cursor(DecodedCursor {
            hotspot_x: 0,
            hotspot_y: 0,
            width: 1,
            height: 1,
            rgba: vec![0x12, 0x34, 0x56, 0xff],
        })
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "cursor");
        assert_eq!(value["visible"], true);
        assert_eq!(value["width"], 1);
        assert!(
            value["png_base64"]
                .as_str()
                .unwrap()
                .starts_with("iVBORw0KGgo")
        );
    }

    #[test]
    fn pointer_position_serializes_as_a_small_control_message() {
        let json = serde_json::to_string(&WsOutgoingText::PointerPos { x: 123, y: 456 }).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "type": "pointer_pos", "x": 123, "y": 456 })
        );
    }

    #[test]
    fn backend_enforces_view_only_and_clipboard_direction() {
        let limits = crate::vnc::limits::DecodeLimits::default();
        let key = VncControl::Key {
            down: true,
            keysym: 0x41,
        };
        assert!(!control_allowed(
            &key,
            true,
            VncClipboardPolicy::Bidirectional,
            &limits,
        ));
        assert!(control_allowed(
            &VncControl::Ack,
            true,
            VncClipboardPolicy::Disabled,
            &limits,
        ));
        assert!(!control_allowed(
            &VncControl::Clipboard("secret".into()),
            false,
            VncClipboardPolicy::ServerToClient,
            &limits,
        ));
        assert!(control_allowed(
            &VncControl::Clipboard("ok".into()),
            false,
            VncClipboardPolicy::ClientToServer,
            &limits,
        ));
    }

    #[test]
    fn backend_rejects_oversized_clipboard_controls() {
        let mut limits = crate::vnc::limits::DecodeLimits::default();
        limits.max_clipboard_format_bytes = 4;
        limits.max_clipboard_decompressed_bytes = 6;
        assert!(!control_allowed(
            &VncControl::Clipboard("12345".into()),
            false,
            VncClipboardPolicy::Bidirectional,
            &limits,
        ));
        assert!(!control_allowed(
            &VncControl::ExtendedClipboard(ClipboardFormats {
                text: Some("1234".into()),
                html: Some("5678".into()),
                rtf: None,
            }),
            false,
            VncClipboardPolicy::Bidirectional,
            &limits,
        ));
    }

    #[test]
    fn clipboard_caps_remain_available_for_one_way_client_sync() {
        let caps = ExtendedClipboardMsg::Caps {
            formats: FORMAT_TEXT,
            actions: SUPPORTED_ACTIONS,
            sizes: vec![1024],
        };
        assert!(server_clipboard_message_allowed(
            &caps,
            VncClipboardPolicy::ClientToServer,
        ));
        assert!(!server_clipboard_message_allowed(
            &ExtendedClipboardMsg::Notify {
                formats: FORMAT_TEXT,
            },
            VncClipboardPolicy::ClientToServer,
        ));
    }

    #[test]
    fn relay_origin_allowlist_rejects_untrusted_pages() {
        assert!(is_authorized_origin("tauri://localhost"));
        assert!(!is_authorized_origin("https://attacker.example"));
    }

    #[test]
    fn stats_window_merges_back_to_back_updates_into_one_line_speed_sample() {
        let mut window = StatsWindow::new();
        let labels = StatsLabels {
            requested: "ZRLE",
            quality: "automatic",
            level: "high",
        };
        let t0 = Instant::now();
        let update = |start_ms: u64, end_ms: u64, bytes: u64, updates: u64| RuntimeStats {
            wire_bytes: 0,
            updates,
            last_encoding: Some(16),
            last_update_wire_bytes: bytes,
            last_update_micros: (end_ms - start_ms) * 1000,
            last_update_started_at: Some(t0 + Duration::from_millis(start_ms)),
            last_update_finished_at: Some(t0 + Duration::from_millis(end_ms)),
            ..RuntimeStats::default()
        };
        // Two halves of one 1 MB transfer 10 ms apart, then a later small update.
        window.observe(update(0, 40, 500_000, 1), 1, &labels);
        window.observe(update(50, 100, 500_000, 2), 1, &labels);
        assert!(window.line_kbps.is_none(), "burst still open");
        window.observe(update(600, 601, 1_000, 3), 2, &labels);
        // 1_000_000 bytes over 100 ms = 80_000 kbit/s.
        assert_eq!(window.line_kbps, Some(80_000));
        // A lone small transfer never produces a sample.
        window.observe(update(2_000, 2_001, 1_000, 4), 3, &labels);
        assert_eq!(window.line_kbps, Some(80_000));
    }

    #[test]
    fn desktop_size_notification_carries_a_monotonic_generation() {
        let json = serde_json::to_string(&WsOutgoingText::DesktopSize {
            width: 2560,
            height: 1440,
            generation: 3,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"desktop_size","width":2560,"height":1440,"generation":3}"#
        );
    }

    #[tokio::test]
    async fn authenticated_websocket_rejects_bad_requests_and_is_single_use() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = CancellationToken::new();
        let server_cancel = cancel.clone();
        let (accepted_tx, accepted_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let socket = accept_authorized_ws(listener, "single-use", &server_cancel)
                .await
                .unwrap();
            let _ = accepted_tx.send(());
            let _ = release_rx.await;
            drop(socket);
        });

        assert!(
            connect_async(ws_request(
                port,
                "/vnc",
                "taomni-vnc.wrong",
                "tauri://localhost",
            ))
            .await
            .is_err()
        );
        assert!(
            connect_async(ws_request(
                port,
                "/vnc",
                "taomni-vnc.single-use",
                "https://attacker.example",
            ))
            .await
            .is_err()
        );
        assert!(
            connect_async(ws_request(
                port,
                "/wrong",
                "taomni-vnc.single-use",
                "tauri://localhost",
            ))
            .await
            .is_err()
        );

        let (mut client, response) = connect_async(ws_request(
            port,
            "/vnc",
            "taomni-vnc.single-use",
            "tauri://localhost",
        ))
        .await
        .unwrap();
        assert_eq!(
            response
                .headers()
                .get(header::SEC_WEBSOCKET_PROTOCOL)
                .and_then(|value| value.to_str().ok()),
            Some("taomni-vnc.single-use")
        );
        accepted_rx.await.unwrap();

        let second = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            connect_async(ws_request(
                port,
                "/vnc",
                "taomni-vnc.single-use",
                "tauri://localhost",
            )),
        )
        .await;
        assert!(!matches!(second, Ok(Ok(_))));

        let _ = client.close(None).await;
        let _ = release_tx.send(());
        server.await.unwrap();
    }

    /// Minimal RFB 3.8 server for relay tests: None security, 4x2 desktop.
    /// Sends one Raw update, then waits for the client's *next* update request
    /// (proving the relay pipelines requests without a WebView ACK), then —
    /// once the test has received the first frame (`delivered`) — resizes to
    /// 2x2 with a DesktopSize rect followed by a Raw rect. Without that wait
    /// the resize can arrive while the first frame is still queued, and the
    /// relay rightly drops frames of the old geometry.
    fn start_pipeline_fixture() -> (
        u16,
        std::thread::JoinHandle<Vec<u8>>,
        std::sync::mpsc::Sender<()>,
    ) {
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (delivered, first_frame_delivered) = std::sync::mpsc::channel::<()>();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            stream.write_all(b"RFB 003.008\n").unwrap();
            let mut banner = [0u8; 12];
            stream.read_exact(&mut banner).unwrap();
            stream.write_all(&[1, 1]).unwrap();
            let mut chosen = [0u8; 1];
            stream.read_exact(&mut chosen).unwrap();
            stream.write_all(&0u32.to_be_bytes()).unwrap();
            let mut shared = [0u8; 1];
            stream.read_exact(&mut shared).unwrap();
            let mut init = Vec::new();
            init.extend_from_slice(&4u16.to_be_bytes());
            init.extend_from_slice(&2u16.to_be_bytes());
            init.extend_from_slice(&[32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
            init.extend_from_slice(&4u32.to_be_bytes());
            init.extend_from_slice(b"test");
            stream.write_all(&init).unwrap();

            // Client setup: SetPixelFormat, SetEncodings, first (full) request.
            let mut pixel_format = [0u8; 20];
            stream.read_exact(&mut pixel_format).unwrap();
            let mut encodings = [0u8; 4];
            stream.read_exact(&mut encodings).unwrap();
            let count = u16::from_be_bytes([encodings[2], encodings[3]]) as usize;
            let mut list = vec![0u8; count * 4];
            stream.read_exact(&mut list).unwrap();
            let mut first_request = [0u8; 10];
            stream.read_exact(&mut first_request).unwrap();

            let raw_rect = |x: u16, y: u16, w: u16, h: u16, value: u8| {
                let mut rect = Vec::new();
                for field in [x, y, w, h] {
                    rect.extend_from_slice(&field.to_be_bytes());
                }
                rect.extend_from_slice(&0i32.to_be_bytes());
                for _ in 0..(w as usize * h as usize) {
                    rect.extend_from_slice(&[value, value, value, 0]);
                }
                rect
            };
            let mut first = vec![0, 0, 0, 1];
            first.extend_from_slice(&raw_rect(0, 0, 4, 2, 7));
            stream.write_all(&first).unwrap();

            // The relay must ask for the next incremental update on its own.
            let mut next_request = [0u8; 10];
            stream.read_exact(&mut next_request).unwrap();
            first_frame_delivered
                .recv_timeout(std::time::Duration::from_secs(10))
                .expect("first frame delivered to the WebSocket");

            let mut resized = vec![0, 0, 0, 2];
            for field in [0u16, 0, 2, 2] {
                resized.extend_from_slice(&field.to_be_bytes());
            }
            resized.extend_from_slice(&ENCODING_DESKTOP_SIZE.to_be_bytes());
            resized.extend_from_slice(&raw_rect(0, 0, 2, 2, 9));
            stream.write_all(&resized).unwrap();

            let mut rest = Vec::new();
            let _ = stream.read_to_end(&mut rest);
            next_request.to_vec()
        });
        (port, handle, delivered)
    }

    #[tokio::test]
    async fn relay_pipelines_requests_and_repaints_after_desktop_size() {
        let (port, server, delivered) = start_pipeline_fixture();
        let session = spawn_vnc_relay(
            "127.0.0.1".into(),
            port,
            None,
            None,
            None,
            VncSecurityPolicy::AllowNone,
            false,
            VncClipboardPolicy::Disabled,
            VncRelayOptions::default(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let (mut client, _) = connect_async(ws_request(
            session.ws_port,
            "/vnc",
            &format!("taomni-vnc.{}", session.ws_token),
            "tauri://localhost",
        ))
        .await
        .unwrap();

        let mut texts = Vec::new();
        let mut frames: Vec<Vec<Vec<u8>>> = vec![Vec::new()];
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while frames.iter().filter(|frame| !frame.is_empty()).count() < 2 {
            let message = tokio::time::timeout_at(deadline, client.next())
                .await
                .expect("relay frames before timeout")
                .expect("socket open")
                .expect("valid message");
            match message {
                Message::Text(text) => texts.push(text.to_string()),
                Message::Binary(bytes) if bytes.is_empty() => {
                    if !frames.last().unwrap().is_empty() {
                        let _ = delivered.send(());
                    }
                    frames.push(Vec::new());
                }
                Message::Binary(bytes) => frames.last_mut().unwrap().push(bytes.to_vec()),
                _ => {}
            }
        }
        // No ACK was sent, yet the server saw an incremental request.
        let _ = client.close(None).await;
        drop(session);
        let next_request = tokio::task::spawn_blocking(move || server.join().unwrap())
            .await
            .unwrap();
        assert_eq!(next_request[0], 3, "FramebufferUpdateRequest");
        assert_eq!(next_request[1], 1, "incremental");

        assert!(
            texts
                .iter()
                .any(|text| text.contains("\"type\":\"connected\""))
        );
        assert!(
            texts
                .iter()
                .any(|text| text.contains("\"type\":\"desktop_size\"")
                    && text.contains("\"width\":2")),
            "desktop_size notification: {texts:?}"
        );
        let painted: Vec<&Vec<Vec<u8>>> = frames.iter().filter(|frame| !frame.is_empty()).collect();
        // First frame: one 4x2 rect of value 7.
        assert_eq!(painted[0].len(), 1);
        assert_eq!(&painted[0][0][..8], &[0, 0, 0, 0, 0, 4, 0, 2]);
        assert!(painted[0][0][12..].chunks(4).all(|px| px == [7, 7, 7, 255]));
        // After the resize the whole new 2x2 surface is repainted.
        assert_eq!(&painted[1][0][..8], &[0, 0, 0, 0, 0, 2, 0, 2]);
        assert!(painted[1][0][12..].chunks(4).all(|px| px == [9, 9, 9, 255]));
    }
}

fn is_authorized_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }
    if cfg!(debug_assertions) {
        return matches!(
            origin,
            "http://localhost:1980"
                | "http://127.0.0.1:1980"
                | "http://localhost:5000"
                | "http://127.0.0.1:5000"
        );
    }
    false
}
