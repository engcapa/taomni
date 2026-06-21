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
//! the relay + per-call session + command surface are always compiled; capture
//! and the codecs (Opus / H.264) live behind the `native-av` feature and land in
//! later phases. Forward-declared items carry `#![allow(dead_code)]`, narrowed
//! as phases start using them.
#![allow(dead_code)]

pub mod relay;

use std::collections::HashSet;
use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::{mpsc, RwLock};

use crate::lanchat::protocol::wire::MediaFrame;
use crate::lanchat::LanChatState;

/// An inbound media frame tagged with the peer it came from, for routing inside
/// a call's relay (which fans multiple peers into one webview).
pub struct InboundMedia {
    pub peer_id: String,
    pub frame: MediaFrame,
}

/// Per-call native media session state. Created when a native call starts and
/// stored in `LanChatState.media_sessions` keyed by call id. Owns the loopback
/// WS relay (decoded media → webview) and the set of peers this call exchanges
/// media with; per-peer capture/encode state attaches in later phases.
pub struct NativeMediaSession {
    pub call_id: String,
    /// Inbound media pump: frames arriving over the mesh are forwarded here and
    /// drained by the relay toward the webview.
    inbound_tx: mpsc::UnboundedSender<InboundMedia>,
    /// The loopback WS relay for this call.
    relay: relay::RelayHandle,
    /// Peers we are currently exchanging media with.
    peers: RwLock<HashSet<String>>,
}

impl NativeMediaSession {
    /// Start a session: spawn the loopback WS relay and wire the inbound pump
    /// into it. Returns the session ready to register in `media_sessions`.
    pub async fn start(call_id: String) -> Result<Arc<Self>, String> {
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
        let relay = relay::spawn_relay(inbound_rx).await?;
        Ok(Arc::new(Self {
            call_id,
            inbound_tx,
            relay,
            peers: RwLock::new(HashSet::new()),
        }))
    }

    /// The loopback WS port the webview connects to for this call.
    pub fn ws_port(&self) -> u16 {
        self.relay.ws_port
    }

    /// Forward an inbound media frame into the relay pump. Cheap and lock-free;
    /// called from the transport read loop hot path.
    pub fn forward_inbound(&self, peer_id: &str, frame: MediaFrame) {
        let _ = self.inbound_tx.send(InboundMedia { peer_id: peer_id.to_string(), frame });
    }

    /// Register a peer we now exchange media with (capture/encode toward it is
    /// started by the audio/video phases).
    pub async fn add_peer(&self, peer_id: &str) {
        self.peers.write().await.insert(peer_id.to_string());
    }

    /// Stop exchanging media with a peer and drop its tile in the webview.
    pub async fn remove_peer(&self, peer_id: &str) {
        if self.peers.write().await.remove(peer_id) {
            let _ = self.relay.control_tx.send(relay::RelayControl::PeerRemoved(peer_id.to_string()));
        }
    }

    /// Forward a peer's mic/cam/screen state to the webview.
    pub fn peer_state(&self, peer_id: &str, mic: bool, cam: bool, screen: bool) {
        let _ = self.relay.control_tx.send(relay::RelayControl::PeerState {
            peer_id: peer_id.to_string(),
            mic,
            cam,
            screen,
        });
    }

    /// Tear the session down: cancel the relay (which releases the WS + tasks).
    pub fn stop(&self) {
        self.relay.cancel.cancel();
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
