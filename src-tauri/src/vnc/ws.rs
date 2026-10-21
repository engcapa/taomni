mod transport;
pub use transport::*;
mod frame_flow;
use frame_flow::*;
mod relay;
pub use relay::*;
mod clipboard;
use clipboard::*;
mod input;
use input::*;
#[cfg(test)]
mod tests;

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
    FORMAT_HTML, FORMAT_RTF, FORMAT_TEXT, SUPPORTED_ACTIONS, build_caps_body, build_notify_body,
    build_provide_body, build_request_body,
};
use crate::vnc::encodings::DecodedCursor;
use crate::vnc::framebuffer::{Damage, FbRect, SharedFramebuffer};
use crate::vnc::native_pointer::{NativePointerSampler, NativePointerTarget};
use crate::vnc::policy::{VncClipboardPolicy, VncSecurityPolicy};
use crate::vnc::quality::{QualityController, UpdateSummary, VncPictureQuality};
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
/// The WebView's plain moves trail the native sampler by one or two vsync
/// periods; within this window after a sample they carry no newer position.
const SAMPLED_POINTER_FRESH: Duration = Duration::from_millis(50);

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
    /// Start (`Some`) or stop native pointer sampling over the canvas
    /// (VNC-PERF-005).
    NativePointer(Option<NativePointerTarget>),
    /// A cursor position read by the native sampler (no buttons). Applied
    /// only while no button is held; the WebView's later copies of the same
    /// moves are then dropped.
    SampledPointer {
        x: u16,
        y: u16,
    },
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
    /// `on` with the canvas geometry starts native pointer sampling; `on:
    /// false` (or incomplete geometry) stops it.
    #[serde(rename = "native_pointer")]
    NativePointer {
        on: bool,
        #[serde(default)]
        left: Option<f64>,
        #[serde(default)]
        top: Option<f64>,
        #[serde(default)]
        width: Option<f64>,
        #[serde(default)]
        height: Option<f64>,
        #[serde(default)]
        dpr: Option<f64>,
        #[serde(default)]
        fb_width: Option<u16>,
        #[serde(default)]
        fb_height: Option<u16>,
    },
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
        /// The relay samples the cursor natively while it rests over the
        /// canvas (Windows, VNC-PERF-005).
        native_pointer: bool,
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

#[derive(Debug, Clone, Copy, Default)]
struct ServerClipboardCaps {
    formats: u32,
    actions: u32,
}

/// Update pacing between the RFB server, the authoritative framebuffer and
/// the WebView. A server request is released only after the WebView has
/// acknowledged the frame that contains the previous damage. Old Vino
/// versions can spend seconds encoding a 1680x1050 update; allowing a second
/// request while WebKit is still painting makes those updates accumulate and
/// can leave the remote desktop looking frozen. Cursor-only updates remain
/// pipelined because they do not occupy the canvas painter.
struct FrameFlow {
    damage: Damage,
    frontend_ready: bool,
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

type SharedQuality = Arc<std::sync::Mutex<QualityController>>;

/// Merges the WebView's pointer events with native cursor samples
/// (VNC-PERF-005, DEC-VNC-20). The WebView owns the pointer while one of its
/// buttons is down; otherwise the sampler's moves win and the WebView's later
/// copies of them are dropped.
#[derive(Debug, Default)]
struct PointerArbiter {
    native_on: bool,
    buttons: u8,
    sampled_at: Option<Instant>,
    last_wire: Option<(u16, u16, u8)>,
}
