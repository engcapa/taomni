use super::connection::ensure_connection;
use super::handshake::PeerHello;
use crate::lanchat::LanChatState;
use crate::lanchat::protocol::Envelope;
use crate::lanchat::protocol::PeerRecord;
use crate::lanchat::protocol::PresenceStatus;
use futures::StreamExt;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::AppHandle;

/// Learn / refresh a peer from a freshly established connection. Peers that
/// mDNS never resolved (cross-segment Wi-Fi, multicast-pruned networks) are
/// synthesized from the connection's source IP + the `hello` identity so they
/// show up in the roster and can be replied to. Returns true if a *new* peer
/// was added (caller should re-emit the roster).
pub(super) async fn learn_peer_from_conn(
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
            // Already known (typically from mDNS). A live connection's remote IP
            // is proven reachable, so adopt it: this corrects a stale or
            // non-routable address that mDNS may have seeded (e.g. a Windows
            // Hyper-V/WSL/VM virtual-adapter IP) and is the only way a peer we
            // could never dial first (we only ever accepted from it) becomes
            // dial-able. The listening port comes from the peer's hello — the
            // socket's source port is ephemeral — so only override it when the
            // hello carried one. Persist so historic reconnect uses the good
            // address across restarts.
            existing.last_seen = now;
            existing.addr = Some(ip);
            if let Some(p) = hello.port {
                existing.port = Some(p);
            }
            let _ = state.store.store_peer(existing);
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
pub(super) async fn handle_peer_exchange(
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
        let Some(id) = entry.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if id == my_id {
            continue;
        }
        // Skip peers we already know or are already connected to.
        if state.peers.read().await.contains_key(id) {
            continue;
        }
        if state.connections.read().await.contains_key(id) {
            continue;
        }
        let name = entry
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let addr = entry.get("addr").and_then(|v| v.as_str()).map(String::from);
        let port = entry
            .get("port")
            .and_then(|v| v.as_u64())
            .and_then(|n| u16::try_from(n).ok());
        if let (Some(addr_val), Some(port_val)) = (&addr, port) {
            let rec = PeerRecord {
                id: id.to_string(),
                name: if name.is_empty() {
                    id.chars().take(8).collect()
                } else {
                    name
                },
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
