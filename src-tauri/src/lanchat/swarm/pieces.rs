use super::bitfield::Bitfield;
#[cfg(any(unix, windows))]
use super::file_io::pread_exact;
#[cfg(any(unix, windows))]
use super::file_io::pwrite_all;
use super::lifetime::SwarmFile;
use super::offers::payload_file_id;
use crate::lanchat::LanChatState;
use crate::lanchat::protocol::Envelope;
use crate::lanchat::protocol::frame;
use crate::lanchat::protocol::wire;
use crate::lanchat::transport;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::AppHandle;
use tauri::Emitter;

/// A peer announced it now holds a piece — record it as a potential source.
pub async fn handle_have(app: &AppHandle, state: &Arc<LanChatState>, from: &str, env: &Envelope) {
    let Some(file_id) = payload_file_id(env) else {
        return;
    };
    let Some(piece) = env.payload.get("piece").and_then(|v| v.as_u64()) else {
        return;
    };
    let Some(sf) = state.swarms.read().await.get(&file_id).cloned() else {
        return;
    };
    let n = sf.manifest.piece_count();
    sf.inner
        .lock()
        .await
        .peers
        .entry(from.to_string())
        .or_insert_with(|| Bitfield::empty(n))
        .set(piece as usize);
    sf.wake.notify_waiters();
    sf.emit(app, None).await;
    maybe_finalize_origin(app, state, &sf, &file_id).await;
}

/// A peer sent its full bitfield (on join) — record what it can serve.
pub async fn handle_bitfield(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    from: &str,
    env: &Envelope,
) {
    let Some(file_id) = payload_file_id(env) else {
        return;
    };
    let Some(bits) = env.payload.get("bits").and_then(|v| v.as_str()) else {
        return;
    };
    let Some(sf) = state.swarms.read().await.get(&file_id).cloned() else {
        return;
    };
    let n = sf.manifest.piece_count();
    sf.inner
        .lock()
        .await
        .peers
        .insert(from.to_string(), Bitfield::from_base64(bits, n));
    sf.wake.notify_waiters();
    sf.emit(app, None).await;
    maybe_finalize_origin(app, state, &sf, &file_id).await;
}

/// Origin send completes when every accepted peer holds the whole file.
pub(super) async fn maybe_finalize_origin(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    sf: &Arc<SwarmFile>,
    file_id: &str,
) {
    if sf.direction != "send" || sf.finalized.load(Ordering::SeqCst) {
        return;
    }
    let done = {
        let inner = sf.inner.lock().await;
        !inner.peers.is_empty() && inner.peers.values().all(|b| b.is_complete())
    };
    if done {
        sf.finalized.store(true, Ordering::SeqCst);
        sf.emit(app, Some("done")).await;
        state.swarms.write().await.remove(file_id);
    }
}

/// Broadcast a `swarm-have` for `piece` to every known swarm peer.
pub(super) async fn broadcast_have(
    state: &Arc<LanChatState>,
    sf: &Arc<SwarmFile>,
    my_id: &str,
    piece: usize,
) {
    let peers: Vec<String> = sf.inner.lock().await.peers.keys().cloned().collect();
    for p in peers {
        let env = Envelope::new(
            frame::SWARM_HAVE,
            my_id,
            Some(p.clone()),
            json!({ "fileId": sf.manifest.file_id, "piece": piece }),
        );
        let _ = transport::try_send(state, &p, env).await;
    }
}

/// A peer asked for a piece: read it (positioned, O(piece)) and ship it on the
/// bounded binary channel. `send_data` awaits channel capacity, so a fast disk
/// can never outrun the network — this is the backpressure guarantee.
pub async fn handle_request(state: &Arc<LanChatState>, from: &str, env: &Envelope) {
    let Some(file_id) = payload_file_id(env) else {
        return;
    };
    let Some(piece) = env.payload.get("piece").and_then(|v| v.as_u64()) else {
        return;
    };
    let Some(sf) = state.swarms.read().await.get(&file_id).cloned() else {
        return;
    };
    if sf.is_paused() {
        return;
    }
    let idx = piece as usize;
    if !sf.inner.lock().await.have.get(idx) {
        return;
    }
    let Some(f) = sf.file_handle() else { return };
    let off = idx as u64 * sf.manifest.piece_size as u64;
    let len = sf.manifest.piece_len(idx);
    let data = match tokio::task::spawn_blocking(move || pread_exact(&f, off, len)).await {
        Ok(Ok(d)) => d,
        _ => return,
    };
    transport::send_data(
        state,
        from,
        wire::frame_piece(&file_id, piece as u32, &data),
    )
    .await;
}

/// A binary piece arrived: verify its SHA-256, write it at the right offset,
/// advertise it, and finalize when the file is whole.
pub async fn handle_piece(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    _from: &str,
    file_id: &str,
    piece: u32,
    data: bytes::Bytes,
) {
    let Some(sf) = state.swarms.read().await.get(file_id).cloned() else {
        return;
    };
    let idx = piece as usize;
    if sf.inner.lock().await.have.get(idx) {
        return; // duplicate
    }
    let mut h = Sha256::new();
    h.update(&data);
    let got = hex::encode(h.finalize());
    if sf.manifest.pieces.get(idx) != Some(&got) {
        log::debug!("lanchat: piece {idx} of {file_id} failed hash check, re-requesting");
        sf.inner.lock().await.inflight.remove(&piece);
        sf.wake.notify_waiters();
        return;
    }
    let Some(f) = sf.file_handle() else { return };
    let off = idx as u64 * sf.manifest.piece_size as u64;
    let dvec = data.to_vec();
    let wrote = tokio::task::spawn_blocking(move || pwrite_all(&f, off, &dvec))
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false);
    if !wrote {
        return;
    }
    {
        let mut inner = sf.inner.lock().await;
        inner.have.set(idx);
        inner.inflight.remove(&piece);
    }
    let my_id = state.node_id().await;
    broadcast_have(state, &sf, &my_id, idx).await;
    sf.wake.notify_waiters();
    sf.emit(app, None).await;
    if sf.inner.lock().await.have.is_complete() {
        finalize_leecher(app, state, &sf).await;
    }
}

/// Leecher reached 100%: fsync, atomically rename `.part` → final, then reopen
/// read-only so this node keeps seeding the file to the rest of the swarm. For a
/// 1:1 transfer there is no one left to seed to, so the entry is dropped (frees
/// the open file handle) rather than retained.
pub(super) async fn finalize_leecher(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    sf: &Arc<SwarmFile>,
) {
    if sf.finalized.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(f) = sf.file_handle() {
        let _ = tokio::task::spawn_blocking(move || f.sync_all()).await;
    }
    *sf.file.lock().unwrap() = None;
    let ok = tokio::fs::rename(&sf.temp_path, &sf.save_path)
        .await
        .is_ok();
    if ok && sf.group_id.is_some() {
        // Group: keep seeding to the rest of the swarm.
        if let Ok(rf) = std::fs::File::open(&sf.save_path) {
            sf.set_file(Arc::new(rf));
        }
    } else {
        // 1:1 (or rename failed): nothing more to serve — release the entry.
        state.swarms.write().await.remove(&sf.manifest.file_id);
    }
    sf.emit(app, Some(if ok { "done" } else { "failed" })).await;
}
