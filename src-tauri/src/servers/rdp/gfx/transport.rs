use super::flow_control::ACK_STALL_TIMEOUT;
use super::flow_control::AckStall;
use super::flow_control::DECODE_STALL_TIMEOUT;
use super::flow_control::DecodeWatch;
use super::flow_control::StallVerdict;
use super::flow_control::decode_verdict;
use super::flow_control::stall_verdict;
use super::handler::EgfxFactory;
use crate::servers::engine::LogEmitter;
use crate::servers::rdp::capture::Frame;
use ironrdp::dvc::encode_dvc_messages;
use ironrdp::pdu::gcc::Monitor;
use ironrdp::pdu::gcc::MonitorFlags;
use ironrdp::svc::ChannelFlags;
use ironrdp::svc::SvcMessage;
use ironrdp_egfx::pdu::Avc420Region;
use ironrdp_server::EgfxServerMessage;
use ironrdp_server::GfxServerHandle;
use ironrdp_server::ServerEvent;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tokio::sync::mpsc::UnboundedSender;

#[derive(Clone)]
pub(crate) struct GfxTransport {
    pub(super) state: Arc<Mutex<GfxState>>,
    /// Incremented by the graphics handler on every client frame acknowledgement.
    /// Shared with the per-connection handler so the display side can tell a
    /// slow-but-live client from one that has stopped consuming EGFX entirely.
    pub(super) acks: Arc<AtomicU64>,
    /// Latest `totalFramesDecoded` value published by the client. Unlike an ACK
    /// count, progress here confirms that AVC420 payloads are actually usable.
    pub(super) decoded: Arc<AtomicU32>,
    pub(super) log: LogEmitter,
}

pub(super) struct GfxState {
    pub(super) sender: Option<UnboundedSender<ServerEvent>>,
    pub(super) handle: Option<GfxServerHandle>,
    pub(super) surface: Option<GfxSurface>,
    /// Set once the ACK window has been full past [`ACK_STALL_TIMEOUT`] with no
    /// progress. Cleared when a new connection builds a fresh graphics server.
    pub(super) disabled: bool,
    pub(super) stall: Option<AckStall>,
    pub(super) decode_watch: Option<DecodeWatch>,
    pub(super) decode_confirmed: bool,
    pub(super) session_started: Instant,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct GfxSurface {
    pub(super) id: u16,
    pub(super) width: u16,
    pub(super) height: u16,
}

pub(crate) enum GfxSubmit {
    /// EGFX took ownership of a current frame.
    Sent,
    /// The client has enough in-flight frames. The caller must discard this
    /// frame rather than falling back to a bitmap update, which would only add
    /// stale work to the connection.
    Backpressured,
    /// No negotiated AVC420 graphics path is available; use normal RDP bitmap
    /// updates so older clients remain fully supported.
    Unavailable,
}

pub(crate) enum GfxReadiness {
    Ready,
    Backpressured,
    Unavailable,
}

impl GfxTransport {
    pub(crate) fn new(log: LogEmitter) -> Self {
        Self {
            state: Arc::new(Mutex::new(GfxState {
                sender: None,
                handle: None,
                surface: None,
                disabled: false,
                stall: None,
                decode_watch: None,
                decode_confirmed: false,
                session_started: Instant::now(),
            })),
            acks: Arc::new(AtomicU64::new(0)),
            decoded: Arc::new(AtomicU32::new(0)),
            log,
        }
    }

    pub(crate) fn factory(&self) -> EgfxFactory {
        EgfxFactory {
            state: self.state.clone(),
            acks: self.acks.clone(),
            decoded: self.decoded.clone(),
            log: self.log.clone(),
        }
    }

    /// Snapshot the connection-scoped state. Taking this before locking the
    /// graphics server keeps one consistent lock order (state, then server)
    /// everywhere in this module.
    pub(super) fn snapshot(&self) -> Option<GfxSnapshot> {
        let state = self.state.lock().ok()?;
        if state.disabled {
            return None;
        }
        Some(GfxSnapshot {
            handle: state.handle.clone()?,
            sender: state.sender.clone()?,
            surface: state.surface,
            stall: state.stall,
            decode_watch: state.decode_watch,
            session_started: state.session_started,
        })
    }

    /// Check before beginning a hardware encode. This inexpensive gate means
    /// no CPU/GPU work is spent for an unready client or one whose ACK window
    /// is already full.
    pub(crate) fn readiness(&self) -> GfxReadiness {
        let Some(snapshot) = self.snapshot() else {
            return GfxReadiness::Unavailable;
        };
        let Ok(server) = snapshot.handle.lock() else {
            return GfxReadiness::Unavailable;
        };
        if !server.is_ready() || !server.supports_avc420() {
            return GfxReadiness::Unavailable;
        }
        let backpressured = server.should_backpressure();
        drop(server);

        if backpressured {
            // The ACK window is full. Decide whether this client is merely a
            // frame behind or has stopped acknowledging altogether.
            let acks = self.acks.load(Ordering::Relaxed);
            return match stall_verdict(snapshot.stall, acks, Instant::now()) {
                StallVerdict::Restart => {
                    self.begin_stall(acks);
                    GfxReadiness::Backpressured
                }
                StallVerdict::Wait => GfxReadiness::Backpressured,
                StallVerdict::Disable => {
                    self.disable_after_stall();
                    GfxReadiness::Unavailable
                }
            };
        }

        self.clear_stall();
        let Some(watch) = snapshot.decode_watch else {
            return GfxReadiness::Ready;
        };
        let decoded = self.decoded.load(Ordering::Relaxed);
        match decode_verdict(watch, decoded, Instant::now()) {
            StallVerdict::Restart => {
                self.record_decode_progress(decoded);
                GfxReadiness::Ready
            }
            StallVerdict::Wait => GfxReadiness::Ready,
            StallVerdict::Disable => {
                self.disable_after_decode_stall();
                GfxReadiness::Unavailable
            }
        }
    }

    /// Record the beginning of a backpressure window against the current ACK
    /// count, so progress can be detected on the next check.
    pub(super) fn begin_stall(&self, acks: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.stall = Some(AckStall {
                since: Instant::now(),
                acks,
            });
        }
    }

    pub(super) fn clear_stall(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.stall = None;
        }
    }

    pub(super) fn note_frame_submitted(&self, reset_watch: bool) {
        let decoded = self.decoded.load(Ordering::Relaxed);
        if let Ok(mut state) = self.state.lock()
            && (reset_watch || state.decode_watch.is_none())
        {
            state.decode_watch = Some(DecodeWatch {
                since: Instant::now(),
                decoded,
            });
        }
    }

    pub(super) fn record_decode_progress(&self, decoded: u32) {
        let first_confirmation = if let Ok(mut state) = self.state.lock() {
            state.decode_watch = Some(DecodeWatch {
                since: Instant::now(),
                decoded,
            });
            let first = !state.decode_confirmed;
            state.decode_confirmed = true;
            first
        } else {
            false
        };
        if first_confirmation {
            self.log
                .line("RDP EGFX client confirmed AVC420 decoded-frame progress");
        }
    }

    /// Give up on EGFX for this connection and return it to bitmap updates.
    ///
    /// The mapped surface is removed first: leaving it in place would let the
    /// client keep compositing a frozen surface over the graphics output and
    /// hide the bitmap updates that are about to take over.
    pub(super) fn disable_after_stall(&self) {
        self.disable_after_failure_with_reason(format!(
            "client stopped acknowledging frames for {}ms",
            ACK_STALL_TIMEOUT.as_millis()
        ));
    }

    pub(super) fn disable_after_decode_stall(&self) {
        self.disable_after_failure_with_reason(format!(
            "client acknowledged graphics frames without decoded-frame progress for {}ms",
            DECODE_STALL_TIMEOUT.as_millis()
        ));
    }

    /// Disable EGFX after a protocol, encoder, or transport failure. A stale
    /// mapped surface can continue to cover bitmap output on the client, so it
    /// is deleted before the display path falls back.
    pub(crate) fn disable_after_failure(&self) {
        self.disable_after_failure_with_reason("graphics pipeline failed".to_string());
    }

    pub(super) fn disable_after_failure_with_reason(&self, reason: String) {
        let (handle, sender, surface) = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.disabled {
                return;
            }
            state.disabled = true;
            state.stall = None;
            state.decode_watch = None;
            let surface = state.surface.take();
            let (Some(handle), Some(sender)) = (state.handle.clone(), state.sender.clone()) else {
                return;
            };
            (handle, sender, surface)
        };

        self.log
            .line(format!("RDP EGFX {reason}; returning to bitmap updates"));

        let Some(surface) = surface else {
            return;
        };
        let Ok(mut server) = handle.lock() else {
            return;
        };
        server.delete_surface(surface.id);
        let Some(channel_id) = server.channel_id() else {
            return;
        };
        let output = server.drain_output();
        drop(server);
        if let Some(messages) = encode_output(channel_id, output) {
            let _ = sender.send(ServerEvent::Egfx(EgfxServerMessage::SendMessages {
                messages,
            }));
        }
    }

    pub(crate) fn send_avc420(&self, frame: &Frame, h264: &[u8]) -> GfxSubmit {
        let Some(snapshot) = self.snapshot() else {
            return GfxSubmit::Unavailable;
        };

        let Ok(mut server) = snapshot.handle.lock() else {
            return GfxSubmit::Unavailable;
        };
        if !server.is_ready() || !server.supports_avc420() {
            return GfxSubmit::Unavailable;
        }
        if server.should_backpressure() {
            return GfxSubmit::Backpressured;
        }

        let reuse = snapshot
            .surface
            .filter(|surface| surface.width == frame.width && surface.height == frame.height);
        let (surface, created) = match reuse {
            Some(surface) => (surface, false),
            None => {
                // First frame, or the captured display changed mode. Resizing
                // publishes the new graphics output, drops the obsolete surface
                // so the client stops compositing it, and clears the ACK window
                // that referred to it.
                server.resize_with_monitors(
                    frame.width,
                    frame.height,
                    vec![desktop_monitor(frame.width, frame.height)],
                );
                let Some(id) = server.create_surface(frame.width, frame.height) else {
                    return GfxSubmit::Unavailable;
                };
                if !server.map_surface_to_output(id, 0, 0) {
                    return GfxSubmit::Unavailable;
                }
                (
                    GfxSurface {
                        id,
                        width: frame.width,
                        height: frame.height,
                    },
                    true,
                )
            }
        };

        let region = Avc420Region::full_frame(frame.width, frame.height, 26);
        let timestamp_ms = frame_timestamp_ms(snapshot.session_started, frame.captured_at);
        let queued = server
            .send_avc420_frame(surface.id, h264, &[region], timestamp_ms)
            .is_some();
        let channel_id = server.channel_id();
        let output = server.drain_output();
        drop(server);

        // The state lock is only taken after the server lock is released, so
        // this module always acquires the two in the same order.
        if created && let Ok(mut state) = self.state.lock() {
            state.surface = Some(surface);
        }
        if !queued {
            return GfxSubmit::Backpressured;
        }
        let Some(channel_id) = channel_id else {
            return GfxSubmit::Unavailable;
        };
        let Some(messages) = encode_output(channel_id, output) else {
            return GfxSubmit::Unavailable;
        };

        // Capture the decoded counter before the event can be processed and
        // acknowledged on the connection task. This makes the first decoded
        // frame observable even on a very low-latency local connection.
        self.note_frame_submitted(created);
        if snapshot
            .sender
            .send(ServerEvent::Egfx(EgfxServerMessage::SendMessages {
                messages,
            }))
            .is_err()
        {
            return GfxSubmit::Unavailable;
        }
        GfxSubmit::Sent
    }
}

/// Connection-scoped state read under the state lock, before the graphics
/// server lock is taken.
pub(super) struct GfxSnapshot {
    pub(super) handle: GfxServerHandle,
    pub(super) sender: UnboundedSender<ServerEvent>,
    pub(super) surface: Option<GfxSurface>,
    pub(super) stall: Option<AckStall>,
    pub(super) decode_watch: Option<DecodeWatch>,
    pub(super) session_started: Instant,
}

pub(super) fn frame_timestamp_ms(session_started: Instant, captured_at: Instant) -> u32 {
    let millis = captured_at
        .checked_duration_since(session_started)
        .unwrap_or_default()
        .as_millis();
    let modulus = u128::from(u32::MAX) + 1;
    u32::try_from(millis % modulus).expect("timestamp is reduced to the u32 range")
}

/// Single primary monitor covering the whole captured desktop. MS-RDPEGFX
/// allows an empty monitor array, but real servers always describe the layout,
/// and clients use it to place the graphics output buffer.
pub(super) fn desktop_monitor(width: u16, height: u16) -> Monitor {
    Monitor {
        left: 0,
        top: 0,
        // TS_MONITOR_DEF uses inclusive lower-right coordinates. Using width
        // and height here describes a monitor one pixel larger in each axis
        // than the ResetGraphics output buffer, which Win11 may reject.
        right: i32::from(width.saturating_sub(1)),
        bottom: i32::from(height.saturating_sub(1)),
        flags: MonitorFlags::PRIMARY,
    }
}

pub(super) fn encode_output(
    channel_id: u32,
    output: Vec<ironrdp::dvc::DvcMessage>,
) -> Option<Vec<SvcMessage>> {
    match encode_dvc_messages(channel_id, output, ChannelFlags::SHOW_PROTOCOL) {
        Ok(messages) => Some(messages),
        Err(error) => {
            tracing::warn!("RDP EGFX output encoding failed; using bitmap updates: {error}");
            None
        }
    }
}
