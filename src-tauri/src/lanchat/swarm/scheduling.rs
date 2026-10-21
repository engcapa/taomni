use super::lifetime::SwarmFile;
use super::limits::DRIVE_TICK;
use super::limits::MAX_INFLIGHT;
use super::limits::PER_PEER_WINDOW;
use super::limits::PIECE_TIMEOUT;
use crate::lanchat::LanChatState;
use crate::lanchat::protocol::Envelope;
use crate::lanchat::protocol::frame;
use crate::lanchat::transport;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;

/* ------------------------------ leecher loop ------------------------------ */

pub(super) fn spawn_leecher(app: AppHandle, state: Arc<LanChatState>, file_id: String) {
    tokio::spawn(async move {
        run_leecher(&app, &state, &file_id).await;
    });
}

/// Drive a leech to completion: schedule piece requests under a bounded window
/// (rarest-source-balanced, random scan), reap timeouts, and sleep until a
/// piece/have/new-peer event or the drive tick. The window is what keeps memory
/// flat regardless of file size.
pub(super) async fn run_leecher(_app: &AppHandle, state: &Arc<LanChatState>, file_id: &str) {
    let Some(sf) = state.swarms.read().await.get(file_id).cloned() else {
        return;
    };
    let my_id = state.node_id().await;
    let n = sf.manifest.piece_count();
    loop {
        if sf.is_cancelled() {
            break;
        }
        sf.wait_while_paused().await;
        if sf.is_cancelled() {
            break;
        }
        let requests = schedule_requests(&sf, n).await;
        for (peer, idx) in &requests {
            let env = Envelope::new(
                frame::SWARM_REQUEST,
                &my_id,
                Some(peer.clone()),
                json!({ "fileId": file_id, "piece": idx }),
            );
            let _ = transport::try_send(state, peer, env).await;
        }
        if sf.inner.lock().await.have.is_complete() {
            break;
        }
        tokio::select! {
            _ = sf.wake.notified() => {}
            _ = tokio::time::sleep(DRIVE_TICK) => {}
        }
    }
}

/// Pick which pieces to request from which peers, respecting the global and
/// per-peer in-flight windows. Reaps expired requests so they can be retried
/// (possibly from a different source).
pub(super) async fn schedule_requests(sf: &Arc<SwarmFile>, n: usize) -> Vec<(String, u32)> {
    let mut inner = sf.inner.lock().await;
    let now = Instant::now();
    let expired: Vec<u32> = inner
        .inflight
        .iter()
        .filter(|(_, (_, dl))| *dl <= now)
        .map(|(p, _)| *p)
        .collect();
    for p in expired {
        inner.inflight.remove(&p);
    }
    let mut per_peer: HashMap<String, usize> = HashMap::new();
    for (peer, _) in inner.inflight.values() {
        *per_peer.entry(peer.clone()).or_default() += 1;
    }
    let mut total = inner.inflight.len();
    let mut reqs = Vec::new();
    for idx in 0..n {
        if total >= MAX_INFLIGHT {
            break;
        }
        if inner.have.get(idx) || inner.inflight.contains_key(&(idx as u32)) {
            continue;
        }
        let mut best: Option<(String, usize)> = None;
        for (peer, bf) in inner.peers.iter() {
            if !bf.get(idx) {
                continue;
            }
            let c = *per_peer.get(peer).unwrap_or(&0);
            if c >= PER_PEER_WINDOW {
                continue;
            }
            if best.as_ref().map(|(_, bc)| c < *bc).unwrap_or(true) {
                best = Some((peer.clone(), c));
            }
        }
        if let Some((peer, _)) = best {
            inner
                .inflight
                .insert(idx as u32, (peer.clone(), now + PIECE_TIMEOUT));
            *per_peer.entry(peer.clone()).or_default() += 1;
            total += 1;
            reqs.push((peer, idx as u32));
        }
    }
    reqs
}
