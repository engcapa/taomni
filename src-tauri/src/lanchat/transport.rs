//! TCP control channel (phase 4).
//!
//! Length-prefixed JSON frames (`[u32 BE length][UTF-8 JSON]`) via
//! `tokio-util` `LengthDelimitedCodec` + `serde_json`, carrying
//! `protocol::Envelope`. Owns the listener, on-demand dialing with
//! single-connection-per-peer dedup, the `hello`/`hello-ack` handshake, and
//! `ping`/`pong` keepalive with disconnect cleanup.
//!
//! Inbound application frames (text-msg, file-*, signal-*, wb-*) are routed to
//! `dispatch_inbound`, extended by later phases; phase 4 handles the
//! handshake + keepalive set and logs the rest.

use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

use crate::lanchat::protocol::{frame, Envelope, PeerRecord, PresenceStatus};
use crate::lanchat::LanChatState;

/// How often to send a keepalive ping on an idle connection.
const PING_INTERVAL: Duration = Duration::from_secs(15);
/// How long the handshake may take before the connection is abandoned.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// A live connection to a peer: its id/address plus an outbound frame sender
/// drained by the connection's write task.
pub struct ConnHandle {
    pub peer_id: String,
    pub addr: SocketAddr,
    tx: mpsc::UnboundedSender<Envelope>,
}

impl ConnHandle {
    /// Queue an envelope for delivery to this peer.
    pub fn send(&self, env: Envelope) -> Result<(), String> {
        self.tx.send(env).map_err(|_| "connection closed".to_string())
    }
}

type LanFramed = Framed<TcpStream, LengthDelimitedCodec>;

/// Accept loop over the reserved control listener. Spawns a task per inbound
/// connection. Runs until the listener errors irrecoverably.
pub async fn run_listener(app: AppHandle, state: Arc<LanChatState>) {
    let listener = match state.control_listener.lock().await.take() {
        Some(l) => l,
        None => {
            log::error!("lanchat: no reserved control listener for transport");
            return;
        }
    };
    log::info!("lanchat: transport listening on {:?}", listener.local_addr());
    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                let app = app.clone();
                let state = state.clone();
                tokio::spawn(async move {
                    if let Err(e) = setup_connection(app, state, stream, addr, None).await {
                        log::debug!("lanchat: inbound connection from {addr} ended: {e}");
                    }
                });
            }
            Err(e) => {
                log::warn!("lanchat: accept error: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

/// Ensure a live connection to `peer_id`, dialing if necessary. Returns once
/// the connection is registered (handshake complete), so callers may send
/// immediately afterwards.
pub async fn ensure_connection(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    peer_id: &str,
) -> Result<(), String> {
    if state.connections.read().await.contains_key(peer_id) {
        return Ok(());
    }
    let peer = state
        .peers
        .read()
        .await
        .get(peer_id)
        .cloned()
        .ok_or_else(|| format!("peer {peer_id} not in roster"))?;
    let addr = peer.addr.ok_or("peer has no address")?;
    let port = peer.port.ok_or("peer has no control port")?;
    let sa: SocketAddr = format!("{addr}:{port}")
        .parse()
        .map_err(|e| format!("bad peer address {addr}:{port}: {e}"))?;
    let stream = TcpStream::connect(sa)
        .await
        .map_err(|e| format!("connect {sa}: {e}"))?;
    setup_connection(app.clone(), state.clone(), stream, sa, Some(peer_id.to_string())).await?;
    Ok(())
}

/// Send to a peer over an already-established connection, without dialing.
/// Returns false if there is no live connection. Used by tight loops (file
/// transfer) that run after a connection is known to exist, avoiding the
/// dial machinery (which would create a non-Send type cycle with dispatch).
pub async fn try_send(state: &Arc<LanChatState>, peer_id: &str, env: Envelope) -> bool {
    match state.connections.read().await.get(peer_id) {
        Some(handle) => handle.send(env).is_ok(),
        None => false,
    }
}

/// Queue an envelope to a peer, dialing on demand if not yet connected.
pub async fn send_to_peer(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    peer_id: &str,
    env: Envelope,
) -> Result<(), String> {
    ensure_connection(app, state, peer_id).await?;
    let conns = state.connections.read().await;
    let handle = conns
        .get(peer_id)
        .ok_or_else(|| format!("no live connection to {peer_id}"))?;
    handle.send(env)
}

async fn send_frame(framed: &mut LanFramed, env: &Envelope) -> Result<(), String> {
    let bytes = env.encode().map_err(|e| e.to_string())?;
    framed.send(bytes).await.map_err(|e| e.to_string())
}

async fn recv_frame(framed: &mut LanFramed) -> Result<Envelope, String> {
    match framed.next().await {
        Some(Ok(buf)) => Envelope::decode(&buf).map_err(|e| e.to_string()),
        Some(Err(e)) => Err(e.to_string()),
        None => Err("connection closed during handshake".into()),
    }
}

/// Identity learned from a peer's `hello` / `hello-ack` frame. Carries enough
/// to synthesize a roster entry for a peer we never resolved over mDNS (e.g. a
/// multicast-segmented Wi-Fi client that can still reach us by unicast).
struct PeerHello {
    id: String,
    name: String,
    /// The peer's advertised control-channel listen port (so we can dial back),
    /// if its `hello` carried one. Older peers omit it.
    port: Option<u16>,
}

fn parse_hello(env: &Envelope) -> PeerHello {
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
    }
}

/// Exchange hello/hello-ack and learn the remote identity. `expected` is `Some`
/// when we dialed (so we send first), `None` when accepting. `my_port` is our
/// control-channel listen port, advertised so the peer can dial us back even
/// when it never discovered us over mDNS.
async fn handshake(
    framed: &mut LanFramed,
    my_id: &str,
    my_name: &str,
    my_port: u16,
    expected: Option<String>,
) -> Result<PeerHello, String> {
    let hello_payload =
        json!({ "name": my_name, "pv": crate::lanchat::protocol::PROTOCOL_VERSION, "port": my_port });
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
                &Envelope::new(frame::HELLO_ACK, my_id, Some(peer.id.clone()), hello_payload),
            )
            .await?;
            Ok(peer)
        }
    }
}

/// Learn / refresh a peer from a freshly established connection. Peers that
/// mDNS never resolved (cross-segment Wi-Fi, multicast-pruned networks) are
/// synthesized from the connection's source IP + the `hello` identity so they
/// show up in the roster and can be replied to. Returns true if a *new* peer
/// was added (caller should re-emit the roster).
async fn learn_peer_from_conn(
    state: &Arc<LanChatState>,
    peer_id: &str,
    hello: &PeerHello,
    addr: SocketAddr,
) -> bool {
    let ip = addr.ip().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let mut peers = state.peers.write().await;
    match peers.get_mut(peer_id) {
        Some(existing) => {
            // Already known (typically from mDNS). Keep it fresh and backfill
            // any missing reach info without forcing a roster churn.
            existing.last_seen = now;
            if existing.addr.is_none() {
                existing.addr = Some(ip);
            }
            if existing.port.is_none() {
                existing.port = hello.port;
            }
            false
        }
        None => {
            let name = if hello.name.trim().is_empty() {
                peer_id.chars().take(8).collect()
            } else {
                hello.name.clone()
            };
            let rec = PeerRecord {
                id: peer_id.to_string(),
                name,
                avatar_hash: None,
                signature: String::new(),
                status: PresenceStatus::Online,
                last_seen: now,
                addr: Some(ip),
                port: hello.port,
            };
            let _ = state.store.store_peer(&rec);
            peers.insert(peer_id.to_string(), rec);
            true
        }
    }
}

/// Establish a connection (handshake + register + spawn read/write/ping
/// tasks). Returns once registered so callers can send immediately.
async fn setup_connection(
    app: AppHandle,
    state: Arc<LanChatState>,
    stream: TcpStream,
    addr: SocketAddr,
    expected: Option<String>,
) -> Result<(), String> {
    let _ = stream.set_nodelay(true);
    let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
    let my_id = state.node_id().await;
    let my_name = state
        .store
        .get_profile()
        .ok()
        .flatten()
        .map(|p| p.name)
        .unwrap_or_default();
    let my_port = state.control_port.load(Ordering::SeqCst);

    let hello = timeout(
        HANDSHAKE_TIMEOUT,
        handshake(&mut framed, &my_id, &my_name, my_port, expected.clone()),
    )
    .await
    .map_err(|_| "handshake timed out".to_string())??;
    let peer_id = hello.id.clone();

    if let Some(exp) = &expected {
        if exp != &peer_id {
            return Err(format!("peer id mismatch: expected {exp}, got {peer_id}"));
        }
    }

    // Single connection per peer: keep the existing one, drop this duplicate.
    if state.connections.read().await.contains_key(&peer_id) {
        log::debug!("lanchat: duplicate connection to {peer_id} dropped");
        return Ok(());
    }

    // Learn this peer from the connection itself — covers peers mDNS never
    // resolved (cross-segment / multicast-pruned Wi-Fi). Re-emit the roster so
    // the UI gains a row to open/reply, even with no prior discovery.
    if learn_peer_from_conn(&state, &peer_id, &hello, addr).await {
        crate::lanchat::discovery::emit_roster(&app, &state).await;
    }

    let (mut sink, mut read) = framed.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Envelope>();

    state.connections.write().await.insert(
        peer_id.clone(),
        ConnHandle {
            peer_id: peer_id.clone(),
            addr,
            tx: tx.clone(),
        },
    );
    log::info!("lanchat: connected to {peer_id} ({addr})");

    // Write task: drain the outbound queue into the framed sink.
    let write_task = tokio::spawn(async move {
        while let Some(env) = rx.recv().await {
            match env.encode() {
                Ok(bytes) => {
                    if sink.send(bytes).await.is_err() {
                        break;
                    }
                }
                Err(e) => log::debug!("lanchat: encode frame failed: {e}"),
            }
        }
    });

    // Keepalive ping task.
    let ping_tx = tx.clone();
    let ping_my = my_id.clone();
    let ping_peer = peer_id.clone();
    let ping_task = tokio::spawn(async move {
        let mut iv = tokio::time::interval(PING_INTERVAL);
        iv.tick().await; // consume the immediate tick
        loop {
            iv.tick().await;
            let env = Envelope::new(frame::PING, &ping_my, Some(ping_peer.clone()), json!({}));
            if ping_tx.send(env).is_err() {
                break;
            }
        }
    });

    // Read loop owns teardown: on disconnect it removes the connection and
    // aborts the write + ping tasks.
    tokio::spawn(async move {
        while let Some(frame_res) = read.next().await {
            let buf = match frame_res {
                Ok(b) => b,
                Err(e) => {
                    log::debug!("lanchat: read error from {peer_id}: {e}");
                    break;
                }
            };
            match Envelope::decode(&buf) {
                Ok(env) => dispatch_inbound(&app, &state, &peer_id, &my_id, env).await,
                Err(e) => log::debug!("lanchat: bad frame from {peer_id}: {e}"),
            }
        }
        state.connections.write().await.remove(&peer_id);
        ping_task.abort();
        write_task.abort();
        log::info!("lanchat: disconnected from {peer_id}");
    });

    Ok(())
}

/// Route an inbound frame. Phase 4 handles keepalive; phase 5 adds text
/// messaging; later phases extend with file-*, signal-*, wb-*.
async fn dispatch_inbound(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    peer_id: &str,
    my_id: &str,
    env: Envelope,
) {
    match env.frame_type.as_str() {
        frame::PING => {
            let conns = state.connections.read().await;
            if let Some(handle) = conns.get(peer_id) {
                let _ = handle.send(Envelope::new(
                    frame::PONG,
                    my_id,
                    Some(peer_id.to_string()),
                    json!({}),
                ));
            }
        }
        frame::PONG => {
            if let Some(peer) = state.peers.write().await.get_mut(peer_id) {
                peer.last_seen = chrono::Utc::now().timestamp_millis();
            }
        }
        frame::TEXT_MSG => {
            crate::lanchat::messaging::handle_text_msg(app, state, peer_id, &env).await;
        }
        frame::TEXT_ACK => {
            crate::lanchat::messaging::handle_text_ack(app, state, &env).await;
        }
        frame::GROUP_ANNOUNCE => {
            crate::lanchat::messaging::handle_group_announce(app, state, &env).await;
        }
        frame::GROUP_JOIN | frame::GROUP_LEAVE => {
            crate::lanchat::messaging::handle_group_membership(app, state, &env).await;
        }
        frame::FILE_OFFER => {
            crate::lanchat::transfer::handle_file_offer(app, state, peer_id, &env).await;
        }
        frame::FILE_ACCEPT => {
            crate::lanchat::transfer::handle_file_accept(app, state, peer_id, &env).await;
        }
        frame::FILE_REJECT => {
            crate::lanchat::transfer::handle_file_reject(app, state, peer_id, &env).await;
        }
        frame::FILE_CHUNK => {
            crate::lanchat::transfer::handle_file_chunk(app, state, peer_id, &env).await;
        }
        frame::FILE_COMPLETE => {
            crate::lanchat::transfer::handle_file_complete(app, state, peer_id, &env).await;
        }
        frame::FILE_PAUSE | frame::FILE_RESUME | frame::FILE_CANCEL => {
            crate::lanchat::transfer::handle_file_control(app, state, &env).await;
        }
        frame::CALL_INVITE
        | frame::CALL_ACCEPT
        | frame::CALL_REJECT
        | frame::CALL_CANCEL
        | frame::CALL_END
        | frame::SIGNAL_SDP
        | frame::SIGNAL_ICE
        | frame::MEETING_JOIN
        | frame::MEETING_LEAVE
        | frame::MEDIA_STATE => {
            // Relay WebRTC signaling to the frontend (lanRtc handles it).
            let _ = app.emit(
                crate::lanchat::events::SIGNAL,
                &json!({ "from": peer_id, "type": env.frame_type, "payload": env.payload }),
            );
        }
        frame::WB_OPEN
        | frame::WB_INVITE
        | frame::WB_JOIN
        | frame::WB_LEAVE
        | frame::WB_OP
        | frame::WB_CURSOR
        | frame::WB_SNAPSHOT_REQ
        | frame::WB_SNAPSHOT => {
            // Relay whiteboard frames to the frontend (Yjs provider handles them).
            let _ = app.emit(
                crate::lanchat::events::WB,
                &json!({ "from": peer_id, "type": env.frame_type, "payload": env.payload }),
            );
        }
        other => {
            log::debug!("lanchat: unhandled frame '{other}' from {peer_id}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    // Real TCP handshake over loopback: both sides learn each other's node id
    // (plus name + advertised control port) through length-delimited JSON
    // frames. Exercises the codec + handshake without mDNS or a Tauri handle.
    #[tokio::test]
    async fn handshake_exchanges_node_ids_over_tcp() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let acceptor = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
            handshake(&mut framed, "node-acceptor", "Acceptor", 5001, None).await
        });

        let stream = TcpStream::connect(addr).await.unwrap();
        let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
        let dialer = handshake(
            &mut framed,
            "node-dialer",
            "Dialer",
            5002,
            Some("node-acceptor".to_string()),
        )
        .await
        .unwrap();

        assert_eq!(dialer.id, "node-acceptor", "dialer learns acceptor id");
        assert_eq!(dialer.name, "Acceptor", "dialer learns acceptor name");
        assert_eq!(dialer.port, Some(5001), "dialer learns acceptor port");

        let accepted = acceptor.await.unwrap().unwrap();
        assert_eq!(accepted.id, "node-dialer", "acceptor learns dialer id");
        assert_eq!(accepted.name, "Dialer", "acceptor learns dialer name");
        assert_eq!(accepted.port, Some(5002), "acceptor learns dialer port");
    }

    // A dialer expecting a specific peer id must reject a mismatched ack.
    #[tokio::test]
    async fn dialer_detects_peer_id_mismatch() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
            let _ = handshake(&mut framed, "node-other", "Other", 5003, None).await;
        });

        let stream = TcpStream::connect(addr).await.unwrap();
        let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
        // handshake() returns the *actual* peer id; setup_connection compares
        // it against the expected one. Here the actual ("node-other") differs
        // from what a caller would expect.
        let learned = handshake(
            &mut framed,
            "node-dialer",
            "Dialer",
            5004,
            Some("node-expected".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(learned.id, "node-other");
        assert_ne!(learned.id, "node-expected");
    }
}
