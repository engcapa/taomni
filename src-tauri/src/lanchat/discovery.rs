//! mDNS / DNS-SD discovery (phase 3).
//!
//! Registers this node's `_taomni-lan._tcp.local.` service (TXT per
//! `protocol`), browses for peers, and derives presence from announce +
//! removal events. Roster changes are debounced and pushed to the frontend
//! over the `lanchat://roster` event. Local IPv4 addresses are enumerated via
//! `if-addrs` (multi-NIC aware) and mDNS auto-address tracking is enabled so
//! address changes keep the announcement fresh.
//!
//! Heartbeat-based `away` demotion arrives with the control channel (phase 4);
//! here presence is online (resolved) / offline (removed/TTL-expired).

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use tauri::{AppHandle, Emitter};

use crate::lanchat::protocol::{self, PeerRecord, PresenceStatus};
use crate::lanchat::{events, LanChatState};

/// Short, stable suffix derived from the node id (used in instance/host names).
fn short_id(node_id: &str) -> String {
    node_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect()
}

/// Non-loopback IPv4 addresses on this host (multi-NIC aware).
fn local_ipv4s() -> Vec<Ipv4Addr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(v4) => Some(v4),
            std::net::IpAddr::V6(_) => None,
        })
        .collect()
}

/// Build the `ServiceInfo` advertised for this node from its current profile.
fn build_service_info(state: &LanChatState, control_port: u16) -> Result<ServiceInfo, String> {
    let profile = state
        .store
        .get_profile()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "lanchat profile not initialized".to_string())?;

    let short = short_id(&profile.id);
    let instance = format!("{}@{}", profile.name, short);
    let host = format!("taomni-{short}.local.");

    let mut txt: HashMap<String, String> = HashMap::new();
    txt.insert("id".into(), profile.id.clone());
    txt.insert("name".into(), profile.name.clone());
    if let Some(avh) = &profile.avatar_hash {
        txt.insert("avh".into(), avh.clone());
    }
    // TXT values are length-limited; keep the signature short.
    let sig: String = profile.signature.chars().take(60).collect();
    txt.insert("sig".into(), sig);
    txt.insert("st".into(), profile.status.as_txt().to_string());
    // Phase 01 advertises text capability only; later tasks widen this.
    txt.insert("caps".into(), "text".into());
    txt.insert("port".into(), control_port.to_string());
    txt.insert("pv".into(), protocol::PROTOCOL_VERSION.to_string());

    let ips = local_ipv4s();
    let ip_csv = ips
        .iter()
        .map(|ip| ip.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let info = ServiceInfo::new(
        protocol::SERVICE_TYPE,
        &instance,
        &host,
        ip_csv.as_str(),
        control_port,
        txt,
    )
    .map_err(|e| format!("build ServiceInfo: {e}"))?
    // Track host IP changes so the announcement stays accurate on multi-NIC
    // / DHCP hosts even though we seeded addresses from if-addrs above.
    .enable_addr_auto();

    Ok(info)
}

/// (Re-)announce this node's mDNS service from the current profile. Safe to
/// call repeatedly — `register` re-announces in place. Invoked on startup and
/// after profile edits.
pub fn reregister(state: &LanChatState) -> Result<(), String> {
    let port = state.control_port.load(Ordering::SeqCst);
    let guard = state.daemon.lock().unwrap();
    let Some(daemon) = guard.as_ref() else {
        return Ok(()); // discovery not started yet (e.g. before service start)
    };
    let info = build_service_info(state, port)?;
    daemon
        .register(info)
        .map_err(|e| format!("mDNS register: {e}"))
}

/// Build a `PeerRecord` from a resolved mDNS service, or `None` if it lacks a
/// usable id (or is our own service).
fn peer_from_resolved(resolved: &mdns_sd::ResolvedService, my_id: &str) -> Option<PeerRecord> {
    let id = resolved.get_property_val_str("id")?.to_string();
    if id == my_id {
        return None;
    }
    let name = resolved
        .get_property_val_str("name")
        .unwrap_or("")
        .to_string();
    let addr = resolved
        .get_addresses_v4()
        .iter()
        .next()
        .map(|ip| ip.to_string());
    let port = resolved
        .get_property_val_str("port")
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or_else(|| resolved.get_port());
    Some(PeerRecord {
        id,
        name,
        avatar_hash: resolved.get_property_val_str("avh").map(|s| s.to_string()),
        signature: resolved
            .get_property_val_str("sig")
            .unwrap_or("")
            .to_string(),
        status: resolved
            .get_property_val_str("st")
            .map(PresenceStatus::from_txt)
            .unwrap_or(PresenceStatus::Online),
        last_seen: chrono::Utc::now().timestamp_millis(),
        addr,
        port: Some(port),
    })
}

/// Emit the current roster snapshot to all frontend windows. Public so the
/// transport can re-emit when it learns a peer from a connection (rather than
/// from mDNS).
pub async fn emit_roster(app: &AppHandle, state: &LanChatState) {
    let mut roster: Vec<PeerRecord> = state.peers.read().await.values().cloned().collect();
    roster.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    if let Err(e) = app.emit(events::ROSTER, &roster) {
        log::warn!("lanchat: emit roster failed: {e}");
    }
}

/// Run mDNS discovery: register self, browse peers, maintain the roster, and
/// emit debounced `lanchat://roster` updates. Runs until the daemon stops.
pub async fn run(app: AppHandle, state: Arc<LanChatState>, control_port: u16) {
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            log::error!("lanchat: mDNS daemon init failed: {e}");
            return;
        }
    };
    *state.daemon.lock().unwrap() = Some(daemon.clone());

    if let Err(e) = reregister(&state) {
        log::error!("lanchat: initial mDNS register failed: {e}");
    }

    let receiver = match daemon.browse(protocol::SERVICE_TYPE) {
        Ok(r) => r,
        Err(e) => {
            log::error!("lanchat: mDNS browse failed: {e}");
            return;
        }
    };
    log::info!("lanchat: discovery running (control port {control_port})");

    let my_id = state.node_id().await;
    // Map mDNS instance fullname -> node id, so ServiceRemoved can locate the
    // roster entry to drop without re-parsing the instance name.
    let mut fullname_to_id: HashMap<String, String> = HashMap::new();
    let mut dirty = false;
    let mut ticker = tokio::time::interval(Duration::from_millis(500));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            event = receiver.recv_async() => {
                match event {
                    Ok(ServiceEvent::ServiceResolved(resolved)) => {
                        if let Some(peer) = peer_from_resolved(&resolved, &my_id) {
                            fullname_to_id.insert(resolved.get_fullname().to_string(), peer.id.clone());
                            let _ = state.store.store_peer(&peer);
                            state.peers.write().await.insert(peer.id.clone(), peer);
                            dirty = true;
                        }
                    }
                    Ok(ServiceEvent::ServiceRemoved(_ty, fullname)) => {
                        if let Some(id) = fullname_to_id.remove(&fullname) {
                            if state.peers.write().await.remove(&id).is_some() {
                                let _ = state.store.mark_peer_offline(&id);
                                dirty = true;
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(_) => {
                        log::info!("lanchat: discovery channel closed");
                        break;
                    }
                }
            }
            _ = ticker.tick() => {
                if dirty {
                    emit_roster(&app, &state).await;
                    dirty = false;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lanchat::LanChatState;

    fn temp_state() -> (std::path::PathBuf, LanChatState) {
        let dir = std::env::temp_dir().join(format!("lanchat-disc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = LanChatState::new(&dir);
        (dir, state)
    }

    #[test]
    fn short_id_is_alphanumeric_and_bounded() {
        let s = short_id("9f28a22a-1dea-35f0-93b0-aa84762457bb");
        assert!(s.len() <= 8);
        assert!(s.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn build_service_info_carries_profile_txt() {
        let (dir, state) = temp_state();
        state
            .store
            .update_profile("赵敏", None, "设计即沟通", PresenceStatus::Busy)
            .unwrap();

        let info = build_service_info(&state, 4711).expect("service info builds");
        assert_eq!(info.get_property_val_str("name"), Some("赵敏"));
        assert_eq!(info.get_property_val_str("st"), Some("busy"));
        assert_eq!(info.get_property_val_str("port"), Some("4711"));
        assert_eq!(
            info.get_property_val_str("pv").map(str::to_string),
            Some(protocol::PROTOCOL_VERSION.to_string())
        );
        assert_eq!(info.get_property_val_str("caps"), Some("text"));
        assert!(info.get_property_val_str("id").is_some_and(|v| !v.is_empty()));
        assert!(info.get_fullname().ends_with("._taomni-lan._tcp.local."));

        std::fs::remove_dir_all(&dir).ok();
    }
}
