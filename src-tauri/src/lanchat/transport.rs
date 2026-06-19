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
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_rustls::{TlsAcceptor, TlsConnector, TlsStream};
use tokio_util::codec::{Framed, LengthDelimitedCodec};

use crate::lanchat::protocol::{frame, wire, Envelope, PeerRecord, PresenceStatus};
use crate::lanchat::{identity, tls, LanChatState};

/// How often to send a keepalive ping on an idle connection.
const PING_INTERVAL: Duration = Duration::from_secs(15);
/// How long the handshake may take before the connection is abandoned.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Hard cap on a single control frame (hardening: bounds a malicious peer's
/// length prefix so it can't force a huge allocation). Well above any legitimate
/// frame — file pieces are 256 KiB raw (no base64) + a tiny header.
const MAX_FRAME_LEN: usize = 4 * 1024 * 1024;
/// Bounded capacity of a connection's binary-data (file-piece) queue. This is
/// the backpressure point: a seeder's `send_data` awaits a free slot, so a fast
/// disk can never pile the whole file into memory. Control frames use a
/// separate, prioritized queue so pings/text never wait behind piece data.
const DATA_QUEUE_CAP: usize = 8;

/// A length-delimited codec with our explicit frame-length cap.
fn new_codec() -> LengthDelimitedCodec {
    let mut codec = LengthDelimitedCodec::new();
    codec.set_max_frame_length(MAX_FRAME_LEN);
    codec
}

/// A live connection to a peer: its id/address plus two outbound queues drained
/// by the connection's write task — a small unbounded control queue (JSON
/// envelopes) and a bounded binary-data queue (file pieces, the backpressure
/// point). The write task prioritizes control.
pub struct ConnHandle {
    pub peer_id: String,
    pub addr: SocketAddr,
    control_tx: mpsc::UnboundedSender<Envelope>,
    data_tx: mpsc::Sender<bytes::Bytes>,
}

impl ConnHandle {
    /// Queue a control envelope for delivery to this peer.
    pub fn send(&self, env: Envelope) -> Result<(), String> {
        self.control_tx.send(env).map_err(|_| "connection closed".to_string())
    }
}

type LanFramed<T> = Framed<T, LengthDelimitedCodec>;

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
///
/// The `BoxFuture` return type is intentional: it breaks the opaque-type cycle
/// that arises because `setup_connection` (via `dispatch_inbound` →
/// `handle_peer_exchange`) spawns tasks that call back into this function.
/// Without the explicit `Box`, rustc cannot resolve the `Send` auto-trait for
/// the spawned futures and emits E0391.
pub fn ensure_connection<'a>(
    app: &'a AppHandle,
    state: &'a Arc<LanChatState>,
    peer_id: &'a str,
) -> futures::future::BoxFuture<'a, Result<(), String>> {
    Box::pin(ensure_connection_inner(app, state, peer_id))
}

async fn ensure_connection_inner(
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

/// Send a binary data frame (a file piece) to a peer over the bounded data
/// queue, awaiting a free slot if it is full. This `.await` is the swarm's
/// backpressure: a seeder cannot read faster than the network drains. Returns
/// false if there is no live connection.
pub async fn send_data(state: &Arc<LanChatState>, peer_id: &str, bytes: bytes::Bytes) -> bool {
    let sender = match state.connections.read().await.get(peer_id) {
        Some(handle) => handle.data_tx.clone(),
        None => return false,
    };
    sender.send(bytes).await.is_ok()
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

async fn send_frame<T: AsyncWrite + Unpin>(
    framed: &mut LanFramed<T>,
    env: &Envelope,
) -> Result<(), String> {
    let json = env.encode().map_err(|e| e.to_string())?;
    framed.send(wire::frame_control(&json)).await.map_err(|e| e.to_string())
}

async fn recv_frame<T: AsyncRead + Unpin>(framed: &mut LanFramed<T>) -> Result<Envelope, String> {
    match framed.next().await {
        Some(Ok(buf)) => match wire::decode_frame(&buf) {
            Some(wire::Frame::Control(env)) => Ok(env),
            Some(wire::Frame::Piece(..)) => Err("unexpected binary frame during handshake".into()),
            None => Err("undecodable frame".into()),
        },
        Some(Err(e)) => Err(e.to_string()),
        None => Err("connection closed during handshake".into()),
    }
}

/// Emit a security event to the frontend (and log it) when a peer's presented
/// identity is rejected. `kind` is `"spoof"` (claimed id != cert fingerprint) or
/// `"keyChanged"` (a pinned cert changed).
fn emit_security(app: &AppHandle, peer_id: &str, addr: SocketAddr, kind: &str) {
    log::warn!("lanchat: security: {kind} from {peer_id} ({addr})");
    let _ = app.emit(
        crate::lanchat::events::SECURITY,
        &json!({ "peerId": peer_id, "addr": addr.to_string(), "kind": kind }),
    );
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
    /// The peer's protocol version (0 if absent).
    pv: u32,
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
async fn handshake<T: AsyncRead + AsyncWrite + Unpin>(
    framed: &mut LanFramed<T>,
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

/// Handle an inbound `peer-exchange`: learn about peers the sender knows that
/// we haven't discovered yet (e.g. because mDNS multicast was suppressed on
/// our WiFi segment). For each unknown peer with a reachable addr+port, add it
/// to our roster and attempt a TCP connection.
async fn handle_peer_exchange(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    _from: &str,
    env: &Envelope,
) {
    let Some(peers_arr) = env.payload.get("peers").and_then(|v| v.as_array()) else {
        return;
    };
    let my_id = state.node_id().await;
    let mut new_peers = Vec::new();
    for entry in peers_arr {
        let Some(id) = entry.get("id").and_then(|v| v.as_str()) else { continue };
        if id == my_id { continue; }
        // Skip peers we already know or are already connected to.
        if state.peers.read().await.contains_key(id) { continue; }
        if state.connections.read().await.contains_key(id) { continue; }
        let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let addr = entry.get("addr").and_then(|v| v.as_str()).map(String::from);
        let port = entry.get("port").and_then(|v| v.as_u64()).and_then(|n| u16::try_from(n).ok());
        if let (Some(addr_val), Some(port_val)) = (&addr, port) {
            let rec = PeerRecord {
                id: id.to_string(),
                name: if name.is_empty() { id.chars().take(8).collect() } else { name },
                avatar_hash: None,
                signature: String::new(),
                status: PresenceStatus::Online,
                last_seen: chrono::Utc::now().timestamp_millis(),
                addr: Some(addr_val.clone()),
                port: Some(port_val),
            };
            let _ = state.store.store_peer(&rec);
            state.peers.write().await.insert(id.to_string(), rec);
            new_peers.push(id.to_string());
        }
    }
    if !new_peers.is_empty() {
        crate::lanchat::discovery::emit_roster(app, state).await;
        // Attempt connections to newly learned peers in the background.
        for peer_id in new_peers {
            let app = (*app).clone();
            let state = (*state).clone();
            tokio::spawn(async move {
                if let Err(e) = ensure_connection(&app, &state, &peer_id).await {
                    log::debug!("lanchat: peer-exchange connect to {peer_id} failed: {e}");
                }
            });
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

    // Upgrade the raw TCP stream to mutual TLS before any application data: the
    // dialer takes the client role, the acceptor the server role. Both present
    // and require the self-signed identity certificate.
    let tls: TlsStream<TcpStream> = match &expected {
        Some(_) => {
            let connector = TlsConnector::from(state.tls_client.clone());
            let sni = rustls::pki_types::ServerName::try_from(tls::SNI)
                .map_err(|e| format!("bad sni: {e}"))?;
            let s = timeout(HANDSHAKE_TIMEOUT, connector.connect(sni, stream))
                .await
                .map_err(|_| "tls connect timed out".to_string())?
                .map_err(|e| format!("tls connect: {e}"))?;
            TlsStream::from(s)
        }
        None => {
            let acceptor = TlsAcceptor::from(state.tls_server.clone());
            let s = timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream))
                .await
                .map_err(|_| "tls accept timed out".to_string())?
                .map_err(|e| format!("tls accept: {e}"))?;
            TlsStream::from(s)
        }
    };

    // Capture the peer's certificate fingerprint; the claimed identity is bound
    // to it after the application handshake below.
    let peer_cert = {
        let (_, conn) = tls.get_ref();
        tls::peer_cert_der(conn).ok_or("peer presented no TLS certificate")?
    };
    let peer_fp = identity::fingerprint(&peer_cert);

    let mut framed = Framed::new(tls, new_codec());
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

    // Reject pre-v2 peers (defense in depth; v1 plaintext peers already fail the
    // TLS handshake above and never reach here).
    if hello.pv < crate::lanchat::protocol::PROTOCOL_VERSION {
        return Err(format!(
            "unsupported protocol version {} from {peer_id}",
            hello.pv
        ));
    }

    // Anti-spoofing: the claimed node id must equal the presented certificate's
    // fingerprint. Because the id *is* the fingerprint, a peer cannot claim an id
    // without holding its private key (proven by the TLS handshake signature).
    // This is the core identity guarantee.
    if peer_id != peer_fp {
        emit_security(&app, &peer_id, addr, "spoof");
        return Err(format!(
            "identity mismatch: claimed {peer_id} but certificate fingerprint is {peer_fp}"
        ));
    }

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

    // Trust-on-first-use pin (audit + defense in depth): record the cert on first
    // sight, block if a previously pinned cert ever changes. The latter is
    // structurally unreachable while the id==fingerprint check above holds, so a
    // mismatch means that invariant was somehow broken.
    let now = chrono::Utc::now().timestamp_millis();
    match state.store.get_pin(&peer_id) {
        Ok(Some(pinned)) if pinned != peer_cert => {
            emit_security(&app, &peer_id, addr, "keyChanged");
            return Err(format!("pinned identity key changed for {peer_id}"));
        }
        Ok(_) => {
            let _ = state.store.set_pin(&peer_id, &peer_cert, now);
        }
        Err(e) => log::debug!("lanchat: pin lookup for {peer_id} failed: {e}"),
    }

    // Learn this peer from the connection itself — covers peers mDNS never
    // resolved (cross-segment / multicast-pruned Wi-Fi). Re-emit the roster so
    // the UI gains a row to open/reply, even with no prior discovery.
    if learn_peer_from_conn(&state, &peer_id, &hello, addr).await {
        crate::lanchat::discovery::emit_roster(&app, &state).await;
    }

    let (mut sink, mut read) = framed.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Envelope>();
    let (data_tx, mut data_rx) = mpsc::channel::<bytes::Bytes>(DATA_QUEUE_CAP);

    state.connections.write().await.insert(
        peer_id.clone(),
        ConnHandle {
            peer_id: peer_id.clone(),
            addr,
            control_tx: tx.clone(),
            data_tx,
        },
    );
    log::info!("lanchat: connected to {peer_id} ({addr})");

    // Gossip: share our known peers so the new connection can discover nodes
    // that mDNS failed to resolve (e.g. WiFi multicast suppression).
    {
        let mut peers_snapshot = Vec::new();
        {
            let guard = state.peers.read().await;
            for p in guard.values() {
                if p.id != peer_id && p.addr.is_some() && p.port.is_some() {
                    peers_snapshot.push(serde_json::json!({
                        "id": p.id,
                        "name": p.name,
                        "addr": p.addr,
                        "port": p.port,
                    }));
                }
            }
        }
        if !peers_snapshot.is_empty() {
            let env = Envelope::new(
                frame::PEER_EXCHANGE, &my_id, Some(peer_id.clone()),
                serde_json::json!({ "peers": peers_snapshot }),
            );
            let _ = tx.send(env);
        }
    }

    // Write task: drain both queues into the framed sink, prioritizing control
    // frames (biased select) so pings/text never wait behind a piece backlog.
    // Control frames are tagged here; data frames are pre-tagged piece bytes.
    let write_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                ctrl = rx.recv() => match ctrl {
                    Some(env) => match env.encode() {
                        Ok(json) => {
                            if sink.send(wire::frame_control(&json)).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => log::debug!("lanchat: encode frame failed: {e}"),
                    },
                    None => break, // control senders dropped → connection gone
                },
                data = data_rx.recv() => if let Some(bytes) = data {
                    if sink.send(bytes).await.is_err() {
                        break;
                    }
                },
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
            match wire::decode_frame(&buf) {
                Some(wire::Frame::Control(env)) => {
                    Box::pin(dispatch_inbound(&app, &state, &peer_id, &my_id, env)).await
                }
                Some(wire::Frame::Piece(file_id, idx, data)) => {
                    crate::lanchat::swarm::handle_piece(&app, &state, &peer_id, &file_id, idx, data).await
                }
                None => log::debug!("lanchat: bad/unknown frame from {peer_id}"),
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
        frame::SWARM_OFFER => {
            crate::lanchat::swarm::handle_offer(app, state, peer_id, &env).await;
        }
        frame::SWARM_ACCEPT => {
            crate::lanchat::swarm::handle_accept(app, state, peer_id, &env).await;
        }
        frame::SWARM_REJECT => {
            crate::lanchat::swarm::handle_reject(app, state, peer_id, &env).await;
        }
        frame::SWARM_REQUEST => {
            crate::lanchat::swarm::handle_request(state, peer_id, &env).await;
        }
        frame::SWARM_HAVE => {
            crate::lanchat::swarm::handle_have(app, state, peer_id, &env).await;
        }
        frame::SWARM_BITFIELD => {
            crate::lanchat::swarm::handle_bitfield(app, state, peer_id, &env).await;
        }
        frame::SWARM_CANCEL => {
            crate::lanchat::swarm::handle_cancel(app, state, peer_id, &env).await;
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
        frame::PEER_EXCHANGE => {
            handle_peer_exchange(app, state, peer_id, &env).await;
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

    // Real loopback mutual-TLS handshake between two self-signed identities:
    // each side must observe the other's certificate fingerprint, which is the
    // peer's node id. This is the binding the anti-spoofing check relies on.
    #[tokio::test]
    async fn mutual_tls_binds_peer_cert_fingerprint() {
        use crate::lanchat::identity::{fingerprint, Identity};

        let server_id = Identity::generate().unwrap();
        let client_id = Identity::generate().unwrap();
        let (server_fp, client_fp) = (server_id.node_id.clone(), client_id.node_id.clone());
        let server_cfg = tls::server_config(&server_id).unwrap();
        let client_cfg = tls::client_config(&client_id).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let srv = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let tls = TlsStream::from(TlsAcceptor::from(server_cfg).accept(tcp).await.unwrap());
            let (_, conn) = tls.get_ref();
            tls::peer_cert_der(conn).map(|c| fingerprint(&c))
        });

        let tcp = TcpStream::connect(addr).await.unwrap();
        let sni = rustls::pki_types::ServerName::try_from(tls::SNI).unwrap();
        let tls = TlsStream::from(
            TlsConnector::from(client_cfg).connect(sni, tcp).await.unwrap(),
        );
        let seen_server_fp = {
            let (_, conn) = tls.get_ref();
            tls::peer_cert_der(conn).map(|c| fingerprint(&c))
        };

        let seen_client_fp = srv.await.unwrap();
        assert_eq!(seen_client_fp.as_deref(), Some(client_fp.as_str()), "server sees client fp");
        assert_eq!(seen_server_fp.as_deref(), Some(server_fp.as_str()), "client sees server fp");
    }

    // v3 wire over the *real* mutual-TLS + length-delimited transport: a large
    // (256 KiB) binary piece frame interleaved with a JSON control frame must
    // survive the TLS record layer and the codec, and demux correctly by tag.
    #[tokio::test]
    async fn v3_piece_and_control_frames_survive_tls_transport() {
        use crate::lanchat::identity::Identity;

        let server_id = Identity::generate().unwrap();
        let client_id = Identity::generate().unwrap();
        let server_cfg = tls::server_config(&server_id).unwrap();
        let client_cfg = tls::client_config(&client_id).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let file_id = "c".repeat(64);
        let fid = file_id.clone();
        // Server side: receive two frames, demux, and report what it saw.
        let srv = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let tls = TlsStream::from(TlsAcceptor::from(server_cfg).accept(tcp).await.unwrap());
            let mut framed = Framed::new(tls, new_codec());
            let mut ctrl_type = None;
            let mut piece = None;
            for _ in 0..2 {
                let buf = framed.next().await.unwrap().unwrap();
                match wire::decode_frame(&buf) {
                    Some(wire::Frame::Control(env)) => ctrl_type = Some(env.frame_type),
                    Some(wire::Frame::Piece(id, idx, data)) => piece = Some((id, idx, data.len())),
                    None => panic!("undecodable frame"),
                }
            }
            (ctrl_type, piece)
        });

        let tcp = TcpStream::connect(addr).await.unwrap();
        let sni = rustls::pki_types::ServerName::try_from(tls::SNI).unwrap();
        let tls = TlsStream::from(TlsConnector::from(client_cfg).connect(sni, tcp).await.unwrap());
        let mut framed = Framed::new(tls, new_codec());

        let ctrl = Envelope::new(frame::SWARM_REQUEST, "a", Some("b".into()), json!({ "fileId": fid, "piece": 7 }));
        framed.send(wire::frame_control(&ctrl.encode().unwrap())).await.unwrap();
        let data = vec![0xA5u8; 256 * 1024];
        framed.send(wire::frame_piece(&fid, 7, &data)).await.unwrap();
        framed.flush().await.unwrap();

        let (ctrl_type, piece) = srv.await.unwrap();
        assert_eq!(ctrl_type.as_deref(), Some(frame::SWARM_REQUEST));
        assert_eq!(piece, Some((file_id, 7, 256 * 1024)));
    }
}
