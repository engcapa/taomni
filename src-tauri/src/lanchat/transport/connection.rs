use super::framing::new_codec;
use super::handshake::emit_security;
use super::handshake::handshake;
use super::inbound::dispatch_inbound;
use super::limits::DATA_QUEUE_CAP;
use super::limits::HANDSHAKE_TIMEOUT;
use super::limits::PING_INTERVAL;
use super::outgoing::CONN_SEQ;
use super::outgoing::ConnHandle;
use super::outgoing::MediaQueue;
use super::peer_exchange::learn_peer_from_conn;
use crate::lanchat::LanChatState;
use crate::lanchat::identity;
use crate::lanchat::protocol::Envelope;
use crate::lanchat::protocol::frame;
use crate::lanchat::protocol::wire;
use crate::lanchat::tls;
use futures::SinkExt;
use futures::StreamExt;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::AppHandle;
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::TlsConnector;
use tokio_rustls::TlsStream;
use tokio_util::codec::Framed;

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
    log::info!(
        "lanchat: transport listening on {:?}",
        listener.local_addr()
    );
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

pub(super) async fn ensure_connection_inner(
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
    setup_connection(
        app.clone(),
        state.clone(),
        stream,
        sa,
        Some(peer_id.to_string()),
    )
    .await?;
    Ok(())
}

/// Deterministic glare tie-break: should a newly-established connection replace
/// the existing one to the same peer? Both ends compute this identically, so
/// they keep the *same* physical connection when they dialed each other at once.
///
/// Rule: keep the connection dialed by the peer with the smaller node id. A
/// same-direction duplicate (e.g. two outbound dials racing) is always redundant
/// — keep the existing one. For the opposite-direction glare pair, exactly one
/// connection was dialed by the min-id peer; that is the one both ends keep.
pub(super) fn duplicate_replaces_existing(
    new_outbound: bool,
    existing_outbound: bool,
    my_id: &str,
    peer_id: &str,
) -> bool {
    if new_outbound == existing_outbound {
        return false;
    }
    let new_dialer_id = if new_outbound { my_id } else { peer_id };
    new_dialer_id == std::cmp::min(my_id, peer_id)
}

/// Establish a connection (handshake + register + spawn read/write/ping
/// tasks). Returns once registered so callers can send immediately.
pub(super) async fn setup_connection(
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
    let crypto = state.crypto().await?;
    let tls: TlsStream<TcpStream> = match &expected {
        Some(_) => {
            let connector = TlsConnector::from(crypto.tls_client.clone());
            let sni = rustls::pki_types::ServerName::try_from(tls::SNI)
                .map_err(|e| format!("bad sni: {e}"))?;
            let s = timeout(HANDSHAKE_TIMEOUT, connector.connect(sni, stream))
                .await
                .map_err(|_| "tls connect timed out".to_string())?
                .map_err(|e| format!("tls connect: {e}"))?;
            TlsStream::from(s)
        }
        None => {
            let acceptor = TlsAcceptor::from(crypto.tls_server.clone());
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

    // Reject peers whose control-channel framing we can't speak. The gate is the
    // *minimum compatible* version, not the current one: additive bumps (e.g. v4's
    // media tag) must not lock out an otherwise-compatible older peer, or all
    // messaging silently breaks the moment two builds drift by one version while
    // mDNS still shows them online. v1 plaintext peers already fail the TLS
    // handshake above and never reach here.
    if hello.pv < crate::lanchat::protocol::MIN_PROTOCOL_VERSION {
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
    let media = Arc::new(MediaQueue::new());
    let close = Arc::new(Notify::new());
    let outbound = expected.is_some();
    let conn_id = CONN_SEQ.fetch_add(1, Ordering::Relaxed);

    // Single connection per peer, decided atomically. When both peers dial each
    // other at once ("glare"), each side must independently keep the *same* one
    // of the two connections or both tear down and chat silently breaks. The whole
    // check+insert holds the write lock so two concurrent setups can't both
    // register (and then evict each other on close).
    let handle = ConnHandle {
        peer_id: peer_id.clone(),
        addr,
        conn_id,
        outbound,
        close: close.clone(),
        control_tx: tx.clone(),
        data_tx,
        media: media.clone(),
    };
    let displaced = {
        let mut conns = state.connections.write().await;
        let old = match conns.get(&peer_id) {
            Some(existing) => {
                if !duplicate_replaces_existing(outbound, existing.outbound, &my_id, &peer_id) {
                    log::debug!(
                        "lanchat: duplicate connection to {peer_id} dropped (kept existing)"
                    );
                    return Ok(());
                }
                Some(existing.close.clone())
            }
            None => None,
        };
        conns.insert(peer_id.clone(), handle);
        old
    };
    // Tell the displaced connection's read loop to tear down. Its teardown is
    // conn_id-guarded, so it won't evict the entry we just inserted.
    if let Some(old_close) = displaced {
        old_close.notify_one();
    }
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
                frame::PEER_EXCHANGE,
                &my_id,
                Some(peer_id.clone()),
                serde_json::json!({ "peers": peers_snapshot }),
            );
            let _ = tx.send(env);
        }
    }

    // Write task: drain the queues into the framed sink, prioritizing control
    // frames (biased select) so pings/text never wait behind media or a piece
    // backlog. Priority: control > media (drop-oldest, latency-sensitive) >
    // file-data (bounded, backpressured). Control frames are tagged here; media
    // and data frames are pre-tagged bytes.
    let media_write = media.clone();
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
                _ = media_write.notify.notified() => {
                    // Drain all currently-queued media frames (drop-oldest is
                    // enforced at enqueue, so what remains is the freshest set).
                    let mut send_err = false;
                    while let Some(bytes) = media_write.pop() {
                        if sink.send(bytes).await.is_err() {
                            send_err = true;
                            break;
                        }
                    }
                    if send_err {
                        break;
                    }
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

    // Read loop owns teardown: on disconnect (or when displaced by a duplicate)
    // it removes the connection and aborts the write + ping tasks.
    tokio::spawn(async move {
        loop {
            let frame_res = tokio::select! {
                biased;
                // Displaced by a deterministically-preferred duplicate: stop now
                // so we drop our socket without evicting the replacement.
                _ = close.notified() => break,
                f = read.next() => match f {
                    Some(f) => f,
                    None => break,
                },
            };
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
                    crate::lanchat::swarm::handle_piece(&app, &state, &peer_id, &file_id, idx, data)
                        .await
                }
                Some(wire::Frame::Media(frame)) => {
                    crate::lanchat::media::handle_media_frame(&app, &state, &peer_id, frame).await
                }
                None => log::debug!("lanchat: bad/unknown frame from {peer_id}"),
            }
        }
        // Only evict the map entry if it is still *this* connection: a duplicate
        // may have deterministically replaced us, and a stale socket closing must
        // not remove the live replacement.
        {
            let mut conns = state.connections.write().await;
            if conns.get(&peer_id).map(|h| h.conn_id) == Some(conn_id) {
                conns.remove(&peer_id);
            }
        }
        ping_task.abort();
        write_task.abort();
        log::info!("lanchat: disconnected from {peer_id}");
    });

    Ok(())
}
