use super::flow_control::MAX_FRAMES_IN_FLIGHT;
use super::transport::GfxState;
use crate::servers::engine::LogEmitter;
use ironrdp_egfx::pdu::CapabilitiesAdvertisePdu;
use ironrdp_egfx::pdu::CapabilitySet;
use ironrdp_egfx::server::GraphicsPipelineHandler;
use ironrdp_egfx::server::GraphicsPipelineServer;
use ironrdp_server::GfxDvcBridge;
use ironrdp_server::GfxServerFactory;
use ironrdp_server::GfxServerHandle;
use ironrdp_server::ServerEvent;
use ironrdp_server::ServerEventSender;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tokio::sync::mpsc::UnboundedSender;

/// Factory installed into IronRDP. A fresh graphics server is created for each
/// RDP connection; retaining the previous surface or ACK state across clients
/// would be protocol-invalid and could cause a new session to start stale.
pub(crate) struct EgfxFactory {
    pub(super) state: Arc<Mutex<GfxState>>,
    pub(super) acks: Arc<AtomicU64>,
    pub(super) decoded: Arc<AtomicU32>,
    pub(super) log: LogEmitter,
}

impl ServerEventSender for EgfxFactory {
    fn set_sender(&mut self, sender: UnboundedSender<ServerEvent>) {
        if let Ok(mut state) = self.state.lock() {
            state.sender = Some(sender);
        }
    }
}

impl GfxServerFactory for EgfxFactory {
    fn build_gfx_handler(&self) -> Box<dyn GraphicsPipelineHandler> {
        Box::new(EgfxHandler {
            acks: self.acks.clone(),
            decoded: self.decoded.clone(),
            log: self.log.clone(),
        })
    }

    fn build_server_with_handle(&self) -> Option<(GfxDvcBridge, GfxServerHandle)> {
        let server = Arc::new(Mutex::new(GraphicsPipelineServer::new(
            self.build_gfx_handler(),
        )));
        self.acks.store(0, Ordering::Relaxed);
        self.decoded.store(0, Ordering::Relaxed);
        if let Ok(mut state) = self.state.lock() {
            state.handle = Some(server.clone());
            state.surface = None;
            // A fresh client gets a fresh verdict: an earlier client that
            // stopped acknowledging must not keep EGFX switched off.
            state.disabled = false;
            state.stall = None;
            state.decode_watch = None;
            state.decode_confirmed = false;
            state.session_started = Instant::now();
        }
        Some((GfxDvcBridge::new(server.clone()), server))
    }
}

pub(super) struct EgfxHandler {
    pub(super) acks: Arc<AtomicU64>,
    pub(super) decoded: Arc<AtomicU32>,
    pub(super) log: LogEmitter,
}

impl GraphicsPipelineHandler for EgfxHandler {
    fn capabilities_advertise(&mut self, _pdu: &CapabilitiesAdvertisePdu) {}

    fn on_ready(&mut self, _negotiated: &CapabilitySet) {
        self.log.line(
            "RDP EGFX channel negotiated; enabling AVC420 hardware video with decoded-frame validation",
        );
    }

    fn on_frame_ack(&mut self, _frame_id: u32, queue_depth: u32, total_frames_decoded: u32) {
        // Publishes liveness to the display side, which uses it to tell a
        // client that is one frame behind from one that has stopped consuming.
        self.acks.fetch_add(1, Ordering::Relaxed);
        self.decoded.store(total_frames_decoded, Ordering::Relaxed);
        tracing::trace!(
            queue_depth,
            total_frames_decoded,
            "RDP EGFX frame acknowledged"
        );
    }

    fn on_close(&mut self) {
        self.log
            .line("RDP EGFX channel closed; returning to bitmap updates");
    }

    fn max_frames_in_flight(&self) -> u32 {
        MAX_FRAMES_IN_FLIGHT
    }
}
