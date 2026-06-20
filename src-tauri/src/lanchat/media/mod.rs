//! LanChat native A/V media engine (v4) — the Linux / no-WebRTC media stack.
//!
//! On webviews without `RTCPeerConnection` (WebKitGTK) the webview-WebRTC path
//! is unavailable, so capture / encode / transport / decode all happen here in
//! Rust and decoded media is delivered to the webview over a per-call loopback
//! WebSocket (video → `<canvas>`, audio → AudioWorklet) — the same direct-render
//! pattern the RDP/VNC viewers already use on WebKitGTK.
//!
//! Wire: real-time frames ride the existing mTLS mesh as `TAG_MEDIA` frames
//! (see `protocol::wire`), on a dedicated drop-oldest queue isolated from file
//! transfer (`transport::send_media`). Negotiation uses the `nmedia-*` control
//! frames relayed through `lanchat://signal`.
//!
//! Build-out is phased (see claudedocs/lanchat-linux-native-av-transport.md):
//! this module starts as the inbound-routing + per-call session skeleton;
//! the loopback WS relay, codecs (Opus / H.264), and capture land in later
//! phases. Forward-declared items carry `#![allow(dead_code)]`, narrowed as
//! phases start using them.
#![allow(dead_code)]

use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::lanchat::protocol::wire::MediaFrame;
use crate::lanchat::LanChatState;

/// An inbound media frame tagged with the peer it came from, for routing inside
/// a call's relay (which fans multiple peers into one webview).
pub struct InboundMedia {
    pub peer_id: String,
    pub frame: MediaFrame,
}

/// Per-call native media session state. Created when a native call starts and
/// stored in `LanChatState.media_sessions` keyed by call id. Holds the inbound
/// pump that feeds the loopback WS relay (later phase) and, once capture lands,
/// the per-peer encode/send state.
pub struct NativeMediaSession {
    pub call_id: String,
    /// Inbound media pump: frames arriving over the mesh are forwarded here and
    /// drained by the call's loopback WS relay toward the webview.
    inbound_tx: mpsc::UnboundedSender<InboundMedia>,
}

impl NativeMediaSession {
    /// Build a session and hand back the receiver end of its inbound pump (the
    /// relay owns it). Kept separate from spawning the relay so the transport
    /// can route frames the moment the session is registered.
    pub fn new(call_id: String) -> (Self, mpsc::UnboundedReceiver<InboundMedia>) {
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
        (Self { call_id, inbound_tx }, inbound_rx)
    }

    /// Forward an inbound media frame into the relay pump. Cheap and lock-free;
    /// called from the transport read loop hot path.
    pub fn forward_inbound(&self, peer_id: &str, frame: MediaFrame) {
        let _ = self.inbound_tx.send(InboundMedia { peer_id: peer_id.to_string(), frame });
    }
}

/// Route an inbound `TAG_MEDIA` frame to its call's native media session. No-op
/// (trace log) if no session is registered for the frame's call id — e.g. a
/// late frame after hangup, or a frame for a call this node isn't in.
pub async fn handle_media_frame(
    _app: &AppHandle,
    state: &Arc<LanChatState>,
    peer_id: &str,
    frame: MediaFrame,
) {
    let session = state.media_sessions.read().await.get(&frame.session).cloned();
    match session {
        Some(s) => s.forward_inbound(peer_id, frame),
        None => log::trace!(
            "lanchat: media frame for unknown session {} from {peer_id}",
            frame.session
        ),
    }
}
