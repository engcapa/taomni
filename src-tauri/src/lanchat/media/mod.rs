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

#[cfg(feature = "native-av")]
pub mod audio;
pub mod relay;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Peers we are currently exchanging media with (shared with the audio
    /// encode task so it fans frames to the live set).
    peers: Arc<RwLock<HashSet<String>>>,
    /// Local mic on/off (read by the audio encode task).
    mic_on: Arc<AtomicBool>,
    /// Audio send path (cpal capture + Opus encode); `None` if it failed to
    /// start. Only present with the `native-av` feature.
    #[cfg(feature = "native-av")]
    audio: std::sync::Mutex<Option<audio::AudioSender>>,
}

impl NativeMediaSession {
    /// Start a session: spawn the loopback WS relay, the audio send path, and
    /// wire the inbound pump into the relay. `state` drives outbound media frames.
    pub async fn start(state: Arc<LanChatState>, call_id: String) -> Result<Arc<Self>, String> {
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
        let relay = relay::spawn_relay(inbound_rx).await?;
        let peers = Arc::new(RwLock::new(HashSet::new()));
        let mic_on = Arc::new(AtomicBool::new(true));

        #[cfg(feature = "native-av")]
        let audio = match audio::start_audio_sender(
            state.clone(),
            call_id.clone(),
            peers.clone(),
            mic_on.clone(),
        ) {
            Ok(s) => std::sync::Mutex::new(Some(s)),
            Err(e) => {
                log::warn!("lanchat: native audio sender failed to start: {e}");
                std::sync::Mutex::new(None)
            }
        };
        #[cfg(not(feature = "native-av"))]
        let _ = &state; // state is only needed to drive the audio sender

        Ok(Arc::new(Self {
            call_id,
            inbound_tx,
            relay,
            peers,
            mic_on,
            #[cfg(feature = "native-av")]
            audio,
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

    /// Register a peer we now exchange media with (the audio task starts fanning
    /// encoded frames to it immediately).
    pub async fn add_peer(&self, peer_id: &str) {
        self.peers.write().await.insert(peer_id.to_string());
    }

    /// Stop exchanging media with a peer and drop its tile in the webview.
    pub async fn remove_peer(&self, peer_id: &str) {
        if self.peers.write().await.remove(peer_id) {
            let _ = self.relay.control_tx.send(relay::RelayControl::PeerRemoved(peer_id.to_string()));
        }
    }

    /// Toggle the local microphone (mutes the outgoing Opus stream).
    pub fn set_mic(&self, on: bool) {
        self.mic_on.store(on, Ordering::Relaxed);
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

    /// Tear the session down: stop capture/encoding and cancel the relay.
    pub fn stop(&self) {
        #[cfg(feature = "native-av")]
        if let Some(sender) = self.audio.lock().unwrap().take() {
            sender.stop();
        }
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
