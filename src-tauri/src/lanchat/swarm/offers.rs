use super::bitfield::Bitfield;
use super::lifetime::OfferInfo;
use super::lifetime::SwarmFile;
use super::lifetime::SwarmInner;
use super::manifest::Manifest;
use super::manifest::build_manifest;
use super::manifest::mime_for;
use super::scheduling::spawn_leecher;
use crate::lanchat::LanChatState;
use crate::lanchat::events;
use crate::lanchat::protocol::Envelope;
use crate::lanchat::protocol::PIECE_SIZE;
use crate::lanchat::protocol::frame;
use crate::lanchat::transport;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;
use tauri::AppHandle;
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio::sync::Notify;

/// Offer a single file to `targets` and become its seeder. `members` is the full
/// swarm peer set leechers should trade with (for a group); pass the same as
/// `targets` for 1:1. Returns the content-addressed file id (the transfer id).
pub async fn send(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    targets: Vec<String>,
    members: Vec<String>,
    path: PathBuf,
    conv_id: String,
    group_id: Option<String>,
) -> Result<String, String> {
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("stat {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err("only single files are supported here".into());
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let mime = mime_for(&name);
    let manifest = {
        let path = path.clone();
        let name = name.clone();
        tokio::task::spawn_blocking(move || build_manifest(&path, name, PIECE_SIZE))
            .await
            .map_err(|e| e.to_string())??
    };
    let file_id = manifest.file_id.clone();
    let src = std::fs::File::open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let n = manifest.piece_count();

    let sf = Arc::new(SwarmFile {
        manifest: manifest.clone(),
        conv_id: conv_id.clone(),
        group_id: group_id.clone(),
        direction: "send".into(),
        save_path: path.clone(),
        temp_path: path.clone(),
        origin: None,
        file: std::sync::Mutex::new(Some(Arc::new(src))),
        inner: Mutex::new(SwarmInner {
            have: Bitfield::full(n),
            peers: HashMap::new(),
            inflight: HashMap::new(),
        }),
        cancelled: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        resume: Notify::new(),
        wake: Notify::new(),
        started: Instant::now(),
        finalized: AtomicBool::new(false),
    });
    state
        .swarms
        .write()
        .await
        .insert(file_id.clone(), sf.clone());

    let my_id = state.node_id().await;
    let payload = json!({
        "manifest": manifest.to_json(), "kind": "file", "mime": mime,
        "convId": conv_id, "groupId": group_id, "members": members,
    });
    let mut delivered = 0usize;
    for target in &targets {
        let env = Envelope::new(
            frame::SWARM_OFFER,
            &my_id,
            Some(target.clone()),
            payload.clone(),
        );
        match transport::send_to_peer(app, state, target, env).await {
            Ok(()) => delivered += 1,
            Err(e) => log::warn!("lanchat: swarm offer for {file_id} to {target} failed: {e}"),
        }
    }
    // If the offer reached no one (peer offline / unreachable address / firewall),
    // surface a terminal failure instead of leaving the sender stuck on a silent
    // "offering" card, and drop the dead seed so it does not leak.
    if delivered == 0 && !targets.is_empty() {
        sf.emit(app, Some("failed")).await;
        state.swarms.write().await.remove(&file_id);
        return Err("could not reach any recipient (peer offline or unreachable)".into());
    }
    sf.emit(app, Some("offering")).await;
    Ok(file_id)
}

/* ----------------------------- receiving side ----------------------------- */

/// Inbound `swarm-offer`: stash it and surface a prompt to the UI. The
/// conversation id is derived locally (group id, or the sender for a direct
/// chat) — never trusted from the payload, which carries the *sender's* view
/// (`direct:<us>`) and would never match our `direct:<them>` key.
pub async fn handle_offer(app: &AppHandle, state: &Arc<LanChatState>, from: &str, env: &Envelope) {
    let Some(manifest) = env.payload.get("manifest").and_then(Manifest::from_json) else {
        return;
    };
    let kind = env
        .payload
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("file")
        .to_string();
    let mime = env
        .payload
        .get("mime")
        .and_then(|v| v.as_str())
        .unwrap_or("application/octet-stream")
        .to_string();
    let group_id = env
        .payload
        .get("groupId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let members: Vec<String> = env
        .payload
        .get("members")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let conv_id = match &group_id {
        Some(g) => crate::lanchat::store::group_conv_id(g),
        None => crate::lanchat::store::direct_conv_id(from),
    };
    let file_id = manifest.file_id.clone();
    let (name, size) = (manifest.name.clone(), manifest.size);
    state.swarm_offers.write().await.insert(
        file_id.clone(),
        OfferInfo {
            manifest,
            from: from.to_string(),
            conv_id: conv_id.clone(),
            group_id: group_id.clone(),
            kind: kind.clone(),
            members,
            mime: mime.clone(),
        },
    );
    let _ = app.emit(
        events::FILE_OFFER,
        &json!({ "transferId": file_id, "from": from, "name": name, "size": size, "mime": mime, "kind": kind, "convId": conv_id, "groupId": group_id }),
    );
}

/// Accept an inbound offer: allocate the temp file, join the swarm, and start
/// leeching. Empty `save_path` defaults to the OS downloads dir + offer name.
/// Returns the resolved save path.
pub async fn accept_offer(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    file_id: &str,
    save_path: PathBuf,
) -> Result<String, String> {
    let offer = state
        .swarm_offers
        .write()
        .await
        .remove(file_id)
        .ok_or("offer not found or already handled")?;
    if let Some(existing) = state.swarms.read().await.get(file_id) {
        return Ok(existing.save_path.to_string_lossy().to_string());
    }
    let save_path = if save_path.as_os_str().is_empty() {
        let base = dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(std::env::temp_dir);
        base.join(&offer.manifest.name)
    } else {
        save_path
    };
    if let Some(parent) = save_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let temp_path = save_path.with_extension(format!(
        "{}.part",
        save_path
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default()
    ));
    let std_file = {
        let f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&temp_path)
            .map_err(|e| format!("create {}: {e}", temp_path.display()))?;
        f.set_len(offer.manifest.size)
            .map_err(|e| format!("allocate: {e}"))?;
        Arc::new(f)
    };
    let n = offer.manifest.piece_count();
    let my_id = state.node_id().await;
    let mut peers = HashMap::new();
    peers.insert(offer.from.clone(), Bitfield::full(n)); // origin has everything
    for m in &offer.members {
        if *m != my_id && *m != offer.from {
            peers.insert(m.clone(), Bitfield::empty(n));
        }
    }
    let sf = Arc::new(SwarmFile {
        manifest: offer.manifest.clone(),
        conv_id: offer.conv_id.clone(),
        group_id: offer.group_id.clone(),
        direction: "recv".into(),
        save_path: save_path.clone(),
        temp_path,
        origin: Some(offer.from.clone()),
        file: std::sync::Mutex::new(Some(std_file)),
        inner: Mutex::new(SwarmInner {
            have: Bitfield::empty(n),
            peers,
            inflight: HashMap::new(),
        }),
        cancelled: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        resume: Notify::new(),
        wake: Notify::new(),
        started: Instant::now(),
        finalized: AtomicBool::new(false),
    });
    state
        .swarms
        .write()
        .await
        .insert(file_id.to_string(), sf.clone());

    let accept = Envelope::new(
        frame::SWARM_ACCEPT,
        &my_id,
        Some(offer.from.clone()),
        json!({ "fileId": file_id }),
    );
    let _ = transport::send_to_peer(app, state, &offer.from, accept).await;
    // Announce participation to the other members so the swarm can mesh.
    let bits = sf.inner.lock().await.have.to_base64();
    for m in &offer.members {
        if *m != my_id && *m != offer.from {
            let bf = Envelope::new(
                frame::SWARM_BITFIELD,
                &my_id,
                Some(m.clone()),
                json!({ "fileId": file_id, "bits": bits }),
            );
            let _ = transport::send_to_peer(app, state, m, bf).await;
        }
    }
    sf.emit(app, Some("active")).await;
    spawn_leecher(app.clone(), state.clone(), file_id.to_string());
    Ok(save_path.to_string_lossy().to_string())
}

/// Reject an inbound offer and tell the origin.
pub async fn reject_offer(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    file_id: &str,
) -> Result<(), String> {
    if let Some(offer) = state.swarm_offers.write().await.remove(file_id) {
        let my_id = state.node_id().await;
        let env = Envelope::new(
            frame::SWARM_REJECT,
            &my_id,
            Some(offer.from.clone()),
            json!({ "fileId": file_id }),
        );
        let _ = transport::send_to_peer(app, state, &offer.from, env).await;
    }
    Ok(())
}

/* --------------------------- inbound swarm frames ------------------------- */

pub(super) fn payload_file_id(env: &Envelope) -> Option<String> {
    env.payload
        .get("fileId")
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// Origin: a peer accepted — start tracking it as a leecher we serve.
pub async fn handle_accept(app: &AppHandle, state: &Arc<LanChatState>, from: &str, env: &Envelope) {
    let Some(file_id) = payload_file_id(env) else {
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
        .or_insert_with(|| Bitfield::empty(n));
    sf.emit(app, None).await;
}

/// Origin: a peer declined. For a 1:1 transfer this ends it; in a group one
/// decline is ignored (other members still receive).
pub async fn handle_reject(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    _from: &str,
    env: &Envelope,
) {
    let Some(file_id) = payload_file_id(env) else {
        return;
    };
    let Some(sf) = state.swarms.read().await.get(&file_id).cloned() else {
        return;
    };
    if sf.group_id.is_none() {
        sf.emit(app, Some("rejected")).await;
        state.swarms.write().await.remove(&file_id);
    }
}
