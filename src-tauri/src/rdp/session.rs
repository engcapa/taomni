//! Post-X.224-negotiation RDP session driver.
//!
//! This module owns:
//!
//! - The TLS / NLA upgrade (when the negotiation selected `PROTOCOL_SSL`
//!   or `PROTOCOL_HYBRID`).
//! - MCS Connect Initial / Connect Response.
//! - Channel join + capability exchange.
//! - The fast-path input + slow-path orders draw loop.
//!
//! The current implementation is a controlled stub that establishes a
//! `RdpSessionHandle` exposing two async channels — one for outgoing
//! messages toward the WS layer and one for control messages from the
//! browser. Steps 2 (display + input via IronRDP) and 7 (RD Gateway)
//! plug in here without changing the relay's API surface.

use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::rdp::pdu::nego::NegotiationResponse;
use crate::rdp::transport::BoxedStream;
use crate::rdp::ws::RdpControl;
use crate::rdp::RdpOptions;

/// Output yielded from the session toward the WS layer.
///
/// `(channel_tag, payload)` — the relay prepends the tag byte verbatim
/// to the binary WS frame. See [`crate::rdp::ws::channel`] for tag values.
pub type SessionFrame = (u8, Vec<u8>);

pub struct RdpSessionHandle {
    /// Receives outgoing frames produced by the session worker.
    out_rx: UnboundedReceiver<SessionFrame>,
    /// Sends control input from the relay into the session worker.
    ctrl_tx: UnboundedSender<RdpControl>,
}

impl RdpSessionHandle {
    pub fn new() -> (Self, UnboundedSender<SessionFrame>, UnboundedReceiver<RdpControl>) {
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();
        (Self { out_rx, ctrl_tx }, out_tx, ctrl_rx)
    }

    pub async fn next_outgoing(&mut self) -> Option<SessionFrame> {
        self.out_rx.recv().await
    }

    pub async fn dispatch_control(&self, ctrl: RdpControl) -> Result<(), String> {
        self.ctrl_tx
            .send(ctrl)
            .map_err(|_| "rdp session: ctrl channel closed".to_string())
    }
}

/// Drive the session past the initial X.224 negotiation. The stream is
/// owned here so future steps can transparently upgrade it to TLS/NLA.
///
/// Returns a [`RdpSessionHandle`] the relay polls for outgoing frames
/// and feeds with incoming control input.
pub async fn run_post_negotiation(
    _stream: BoxedStream,
    _resp: NegotiationResponse,
    _options: RdpOptions,
    _username: Option<String>,
    _password: Option<String>,
) -> Result<RdpSessionHandle, String> {
    let (handle, out_tx, mut ctrl_rx) = RdpSessionHandle::new();

    // Status-only worker: announces "awaiting full session implementation"
    // and bleeds heartbeats so the relay's idle watchdog stays satisfied.
    // When IronRDP is wired in step 2, replace the body of this task with
    // the IronRDP draw loop and input dispatcher.
    tokio::spawn(async move {
        use crate::rdp::ws::channel;
        let banner = serde_json::json!({
            "stage": "awaiting-session",
            "detail": "RDP transport + negotiation complete; full session driver pending IronRDP wiring."
        })
        .to_string();
        let _ = out_tx.send((channel::STATUS, banner.into_bytes()));

        while let Some(ctrl) = ctrl_rx.recv().await {
            match ctrl {
                RdpControl::Disconnect => break,
                _ => {
                    // Echo control acks so the relay can see the loop is alive.
                    let ack = serde_json::json!({"event":"control-ack"}).to_string();
                    let _ = out_tx.send((channel::STATUS, ack.into_bytes()));
                }
            }
        }
    });

    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn handle_round_trip_via_channels() {
        let (mut handle, out_tx, _ctrl_rx) = RdpSessionHandle::new();
        let _ = out_tx.send((1, vec![1, 2, 3]));
        let got = handle.next_outgoing().await.unwrap();
        assert_eq!(got.0, 1);
        assert_eq!(got.1, vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn dispatch_control_returns_err_when_dropped() {
        let (handle, _out_tx, ctrl_rx) = RdpSessionHandle::new();
        drop(ctrl_rx);
        let res = handle
            .dispatch_control(RdpControl::Resize { width: 1, height: 1 })
            .await;
        assert!(res.is_err());
    }
}
