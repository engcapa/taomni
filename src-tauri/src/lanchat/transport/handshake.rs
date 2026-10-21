use super::framing::LanFramed;
use super::framing::recv_frame;
use super::framing::send_frame;
use crate::lanchat::protocol::Envelope;
use crate::lanchat::protocol::frame;
use futures::StreamExt;
use serde_json::json;
use std::net::SocketAddr;
use tauri::AppHandle;
use tauri::Emitter;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;

/// Emit a security event to the frontend (and log it) when a peer's presented
/// identity is rejected. `kind` is `"spoof"` (claimed id != cert fingerprint) or
/// `"keyChanged"` (a pinned cert changed).
pub(super) fn emit_security(app: &AppHandle, peer_id: &str, addr: SocketAddr, kind: &str) {
    log::warn!("lanchat: security: {kind} from {peer_id} ({addr})");
    let _ = app.emit(
        crate::lanchat::events::SECURITY,
        &json!({ "peerId": peer_id, "addr": addr.to_string(), "kind": kind }),
    );
}

/// Identity learned from a peer's `hello` / `hello-ack` frame. Carries enough
/// to synthesize a roster entry for a peer we never resolved over mDNS (e.g. a
/// multicast-segmented Wi-Fi client that can still reach us by unicast).
pub(super) struct PeerHello {
    pub(super) id: String,
    pub(super) name: String,
    /// The peer's advertised control-channel listen port (so we can dial back),
    /// if its `hello` carried one. Older peers omit it.
    pub(super) port: Option<u16>,
    /// The peer's protocol version (0 if absent).
    pub(super) pv: u32,
}

pub(super) fn parse_hello(env: &Envelope) -> PeerHello {
    PeerHello {
        id: env.from.clone(),
        name: env
            .payload
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        port: env
            .payload
            .get("port")
            .and_then(|v| v.as_u64())
            .and_then(|n| u16::try_from(n).ok())
            .filter(|p| *p != 0),
        pv: env
            .payload
            .get("pv")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .unwrap_or(0),
    }
}

/// Exchange hello/hello-ack and learn the remote identity. `expected` is `Some`
/// when we dialed (so we send first), `None` when accepting. `my_port` is our
/// control-channel listen port, advertised so the peer can dial us back even
/// when it never discovered us over mDNS.
pub(super) async fn handshake<T: AsyncRead + AsyncWrite + Unpin>(
    framed: &mut LanFramed<T>,
    my_id: &str,
    my_name: &str,
    my_port: u16,
    expected: Option<String>,
) -> Result<PeerHello, String> {
    let hello_payload = json!({ "name": my_name, "pv": crate::lanchat::protocol::PROTOCOL_VERSION, "port": my_port });
    match expected {
        Some(target) => {
            send_frame(
                framed,
                &Envelope::new(frame::HELLO, my_id, Some(target), hello_payload),
            )
            .await?;
            let ack = recv_frame(framed).await?;
            if ack.frame_type != frame::HELLO_ACK {
                return Err(format!("expected hello-ack, got {}", ack.frame_type));
            }
            Ok(parse_hello(&ack))
        }
        None => {
            let hello = recv_frame(framed).await?;
            if hello.frame_type != frame::HELLO {
                return Err(format!("expected hello, got {}", hello.frame_type));
            }
            let peer = parse_hello(&hello);
            send_frame(
                framed,
                &Envelope::new(
                    frame::HELLO_ACK,
                    my_id,
                    Some(peer.id.clone()),
                    hello_payload,
                ),
            )
            .await?;
            Ok(peer)
        }
    }
}
