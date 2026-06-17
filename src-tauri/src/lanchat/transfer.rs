//! P2P file & screenshot transfer (task 02).
//!
//! Transfers run over the same control channel as messaging: chunks are
//! base64-framed inside `file-chunk` envelopes (simple, reuses the existing
//! length-delimited transport; 64 KiB raw chunks). The cancel/pause/resume
//! primitive mirrors `filebrowser::transfer::TransferHandle` (AtomicBool +
//! Notify). Offer → accept/reject → chunked send → complete, with progress
//! emitted to all windows on `lanchat://transfer`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::lanchat::protocol::{frame, Envelope, BINARY_CHUNK_SIZE};
use crate::lanchat::{events, transport, LanChatState};

/// Cancel / pause primitive for a single transfer (mirrors filebrowser).
pub struct LanTransferHandle {
    cancelled: AtomicBool,
    paused: AtomicBool,
    resume: tokio::sync::Notify,
}

impl LanTransferHandle {
    pub fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            resume: tokio::sync::Notify::new(),
        }
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.resume.notify_waiters();
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }
    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
        self.resume.notify_waiters();
    }
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
    pub async fn wait_while_paused(&self) {
        while self.is_paused() && !self.is_cancelled() {
            self.resume.notified().await;
        }
    }
}

/// Sender-side metadata held until the peer accepts.
#[derive(Clone)]
pub struct OutgoingMeta {
    pub peer_id: String,
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub conv_id: String,
}

/// Inbound offer awaiting the local user's decision.
#[derive(Clone)]
pub struct OfferInfo {
    pub from: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub conv_id: String,
    /// "file" | "dir".
    pub kind: String,
}

/// Sender-side folder metadata held until the peer accepts the folder offer.
#[derive(Clone)]
pub struct DirMeta {
    pub peer_id: String,
    pub root: PathBuf,
    pub name: String,
    pub conv_id: String,
    /// (absolute path, relative path) of each regular file under the folder.
    pub files: Vec<(PathBuf, String)>,
    pub total: u64,
}

/// Receiver-side in-progress write.
pub struct IncomingState {
    pub file: tokio::fs::File,
    pub temp_path: PathBuf,
    pub save_path: PathBuf,
    pub name: String,
    pub size: u64,
    pub received: u64,
    pub from: String,
    pub conv_id: String,
    pub started: Instant,
}

/// Progress / state update sent to the UI on `lanchat://transfer`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    /// "send" | "recv".
    pub direction: String,
    pub name: String,
    pub size: u64,
    pub transferred: u64,
    /// bytes/sec.
    pub rate: f64,
    /// seconds remaining (0 if unknown/done).
    pub eta: f64,
    /// "offering" | "active" | "paused" | "done" | "failed" | "cancelled" | "rejected".
    pub state: String,
    pub conv_id: String,
}

fn emit_progress(app: &AppHandle, p: &TransferProgress) {
    if let Err(e) = app.emit(events::TRANSFER, p) {
        log::warn!("lanchat: emit transfer progress failed: {e}");
    }
}

fn rate_eta(transferred: u64, size: u64, started: Instant) -> (f64, f64) {
    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    let rate = transferred as f64 / elapsed;
    let eta = if rate > 0.0 && size > transferred {
        (size - transferred) as f64 / rate
    } else {
        0.0
    };
    (rate, eta)
}

/// Offer a file to a peer. Reads metadata, registers a handle, sends a
/// `file-offer`, and returns the transfer id. The actual send starts when the
/// peer's `file-accept` arrives.
pub async fn send_file(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    peer_id: &str,
    path: PathBuf,
    conv_id: String,
) -> Result<String, String> {
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("stat {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err("only single files are supported".into());
    }
    let size = meta.len();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let mime = mime_guess_simple(&name);
    let transfer_id = uuid::Uuid::new_v4().to_string();

    state
        .transfers
        .write()
        .await
        .insert(transfer_id.clone(), Arc::new(LanTransferHandle::new()));
    state.outgoing.write().await.insert(
        transfer_id.clone(),
        OutgoingMeta {
            peer_id: peer_id.to_string(),
            path,
            name: name.clone(),
            size,
            conv_id: conv_id.clone(),
        },
    );

    let my_id = state.node_id().await;
    let offer = Envelope::new(
        frame::FILE_OFFER,
        &my_id,
        Some(peer_id.to_string()),
        json!({ "transferId": transfer_id, "name": name, "size": size, "mime": mime, "kind": "file", "convId": conv_id }),
    );
    transport::send_to_peer(app, state, peer_id, offer).await?;
    emit_progress(
        app,
        &TransferProgress {
            transfer_id: transfer_id.clone(),
            direction: "send".into(),
            name,
            size,
            transferred: 0,
            rate: 0.0,
            eta: 0.0,
            state: "offering".into(),
            conv_id,
        },
    );
    Ok(transfer_id)
}

/// Inbound `file-offer`: stash it and surface it to the UI for accept/reject.
/// Files that belong to an already-accepted folder are auto-accepted under the
/// chosen base directory (no per-file prompt).
pub async fn handle_file_offer(app: &AppHandle, state: &Arc<LanChatState>, from: &str, env: &Envelope) {
    let p = &env.payload;
    let Some(transfer_id) = p.get("transferId").and_then(|v| v.as_str()) else {
        return;
    };
    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("file").to_string();
    let size = p.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
    let mime = p.get("mime").and_then(|v| v.as_str()).unwrap_or("application/octet-stream").to_string();
    let kind = p.get("kind").and_then(|v| v.as_str()).unwrap_or("file").to_string();
    let conv_id = p
        .get("convId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| crate::lanchat::store::direct_conv_id(from));

    // A file belonging to an accepted folder: auto-accept under the base dir.
    if let Some(folder_id) = p.get("folderId").and_then(|v| v.as_str()) {
        let base = state.accepted_folders.read().await.get(folder_id).cloned();
        if let Some(base) = base {
            let save_path = base.join(&name); // name is the relative path
            if let Some(parent) = save_path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            if let Ok(file) = tokio::fs::File::create(save_path.with_extension("part")).await {
                state
                    .transfers
                    .write()
                    .await
                    .insert(transfer_id.to_string(), Arc::new(LanTransferHandle::new()));
                state.incoming.lock().await.insert(
                    transfer_id.to_string(),
                    IncomingState {
                        file,
                        temp_path: save_path.with_extension("part"),
                        save_path,
                        name: name.clone(),
                        size,
                        received: 0,
                        from: from.to_string(),
                        conv_id: conv_id.clone(),
                        started: Instant::now(),
                    },
                );
                let my_id = state.node_id().await;
                let accept = Envelope::new(frame::FILE_ACCEPT, &my_id, Some(from.to_string()), json!({ "transferId": transfer_id }));
                transport::try_send(state, from, accept).await;
            }
            return;
        }
    }

    state.offers.write().await.insert(
        transfer_id.to_string(),
        OfferInfo { from: from.to_string(), name: name.clone(), size, mime: mime.clone(), conv_id: conv_id.clone(), kind: kind.clone() },
    );
    let _ = app.emit(
        events::FILE_OFFER,
        &json!({ "transferId": transfer_id, "from": from, "name": name, "size": size, "mime": mime, "kind": kind, "convId": conv_id }),
    );
}

/// Accept an inbound offer, opening a temp file and signalling the sender.
pub async fn accept_offer(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    transfer_id: &str,
    save_path: PathBuf,
) -> Result<(), String> {
    let offer = state
        .offers
        .write()
        .await
        .remove(transfer_id)
        .ok_or("offer not found or already handled")?;

    // Folder offer: record the chosen base dir; per-file offers auto-accept.
    if offer.kind == "dir" {
        let base = save_path.join(&offer.name);
        let _ = tokio::fs::create_dir_all(&base).await;
        state.accepted_folders.write().await.insert(transfer_id.to_string(), base);
        let my_id = state.node_id().await;
        let accept = Envelope::new(frame::FILE_ACCEPT, &my_id, Some(offer.from.clone()), json!({ "transferId": transfer_id }));
        transport::send_to_peer(app, state, &offer.from, accept).await?;
        emit_progress(app, &TransferProgress {
            transfer_id: transfer_id.to_string(),
            direction: "recv".into(),
            name: offer.name,
            size: offer.size,
            transferred: 0,
            rate: 0.0,
            eta: 0.0,
            state: "active".into(),
            conv_id: offer.conv_id,
        });
        return Ok(());
    }

    let temp_path = save_path.with_extension(format!(
        "{}.part",
        save_path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()
    ));
    let file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| format!("create {}: {e}", temp_path.display()))?;
    state
        .transfers
        .write()
        .await
        .insert(transfer_id.to_string(), Arc::new(LanTransferHandle::new()));
    state.incoming.lock().await.insert(
        transfer_id.to_string(),
        IncomingState {
            file,
            temp_path,
            save_path,
            name: offer.name.clone(),
            size: offer.size,
            received: 0,
            from: offer.from.clone(),
            conv_id: offer.conv_id.clone(),
            started: Instant::now(),
        },
    );
    let my_id = state.node_id().await;
    let accept = Envelope::new(
        frame::FILE_ACCEPT,
        &my_id,
        Some(offer.from.clone()),
        json!({ "transferId": transfer_id }),
    );
    transport::send_to_peer(app, state, &offer.from, accept).await?;
    emit_progress(
        app,
        &TransferProgress {
            transfer_id: transfer_id.to_string(),
            direction: "recv".into(),
            name: offer.name,
            size: offer.size,
            transferred: 0,
            rate: 0.0,
            eta: 0.0,
            state: "active".into(),
            conv_id: offer.conv_id,
        },
    );
    Ok(())
}

/// Reject an inbound offer.
pub async fn reject_offer(app: &AppHandle, state: &Arc<LanChatState>, transfer_id: &str) -> Result<(), String> {
    let offer = state.offers.write().await.remove(transfer_id);
    if let Some(offer) = offer {
        let my_id = state.node_id().await;
        let frame_env = Envelope::new(frame::FILE_REJECT, &my_id, Some(offer.from.clone()), json!({ "transferId": transfer_id }));
        let _ = transport::send_to_peer(app, state, &offer.from, frame_env).await;
    }
    Ok(())
}

fn mime_guess_simple(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Sender: peer accepted — spawn the chunked send loop (file or folder).
pub async fn handle_file_accept(app: &AppHandle, state: &Arc<LanChatState>, _from: &str, env: &Envelope) {
    let Some(transfer_id) = env.payload.get("transferId").and_then(|v| v.as_str()) else {
        return;
    };
    // Folder accept?
    if let Some(dir) = state.outgoing_dirs.write().await.remove(transfer_id) {
        let app = app.clone();
        let state = state.clone();
        let transfer_id = transfer_id.to_string();
        tokio::spawn(async move {
            run_dir_send(&app, &state, &transfer_id, dir).await;
        });
        return;
    }
    let Some(meta) = state.outgoing.read().await.get(transfer_id).cloned() else {
        return;
    };
    let handle = state.transfers.read().await.get(transfer_id).cloned();
    let Some(handle) = handle else { return };
    let app = app.clone();
    let state = state.clone();
    let transfer_id = transfer_id.to_string();
    tokio::spawn(async move {
        run_send_loop(&app, &state, &transfer_id, meta, handle).await;
    });
}

async fn run_send_loop(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    transfer_id: &str,
    meta: OutgoingMeta,
    handle: Arc<LanTransferHandle>,
) {
    let my_id = state.node_id().await;
    let started = Instant::now();
    let mut transferred: u64 = 0;
    let result: Result<(), String> = async {
        let mut file = tokio::fs::File::open(&meta.path)
            .await
            .map_err(|e| format!("open {}: {e}", meta.path.display()))?;
        let mut buf = vec![0u8; BINARY_CHUNK_SIZE];
        let mut seq: u64 = 0;
        loop {
            handle.wait_while_paused().await;
            if handle.is_cancelled() {
                let env = Envelope::new(frame::FILE_CANCEL, &my_id, Some(meta.peer_id.clone()), json!({ "transferId": transfer_id }));
                transport::try_send(state, &meta.peer_id, env).await;
                return Err("cancelled".into());
            }
            let n = file.read(&mut buf).await.map_err(|e| format!("read: {e}"))?;
            if n == 0 {
                break;
            }
            let data = BASE64.encode(&buf[..n]);
            let env = Envelope::new(
                frame::FILE_CHUNK,
                &my_id,
                Some(meta.peer_id.clone()),
                json!({ "transferId": transfer_id, "seq": seq, "data": data }),
            );
            if !transport::try_send(state, &meta.peer_id, env).await {
                return Err("connection lost".into());
            }
            transferred += n as u64;
            seq += 1;
            let (rate, eta) = rate_eta(transferred, meta.size, started);
            emit_progress(app, &TransferProgress {
                transfer_id: transfer_id.to_string(),
                direction: "send".into(),
                name: meta.name.clone(),
                size: meta.size,
                transferred,
                rate,
                eta,
                state: if handle.is_paused() { "paused".into() } else { "active".into() },
                conv_id: meta.conv_id.clone(),
            });
            tokio::task::yield_now().await;
        }
        let env = Envelope::new(frame::FILE_COMPLETE, &my_id, Some(meta.peer_id.clone()), json!({ "transferId": transfer_id, "ok": true }));
        if !transport::try_send(state, &meta.peer_id, env).await {
            return Err("connection lost".into());
        }
        Ok(())
    }
    .await;

    let final_state = match &result {
        Ok(()) => "done",
        Err(e) if e == "cancelled" => "cancelled",
        Err(_) => "failed",
    };
    let (rate, _) = rate_eta(transferred, meta.size, started);
    emit_progress(app, &TransferProgress {
        transfer_id: transfer_id.to_string(),
        direction: "send".into(),
        name: meta.name.clone(),
        size: meta.size,
        transferred,
        rate,
        eta: 0.0,
        state: final_state.into(),
        conv_id: meta.conv_id.clone(),
    });
    state.transfers.write().await.remove(transfer_id);
    state.outgoing.write().await.remove(transfer_id);
}

/// Sender: peer rejected the offer.
pub async fn handle_file_reject(app: &AppHandle, state: &Arc<LanChatState>, _from: &str, env: &Envelope) {
    let Some(transfer_id) = env.payload.get("transferId").and_then(|v| v.as_str()) else {
        return;
    };
    let meta = state.outgoing.write().await.remove(transfer_id);
    state.transfers.write().await.remove(transfer_id);
    if let Some(meta) = meta {
        emit_progress(app, &TransferProgress {
            transfer_id: transfer_id.to_string(),
            direction: "send".into(),
            name: meta.name,
            size: meta.size,
            transferred: 0,
            rate: 0.0,
            eta: 0.0,
            state: "rejected".into(),
            conv_id: meta.conv_id,
        });
    }
}

/// Receiver: a chunk arrived — append to the temp file and report progress.
pub async fn handle_file_chunk(app: &AppHandle, state: &Arc<LanChatState>, _from: &str, env: &Envelope) {
    let Some(transfer_id) = env.payload.get("transferId").and_then(|v| v.as_str()) else {
        return;
    };
    let Some(data_b64) = env.payload.get("data").and_then(|v| v.as_str()) else {
        return;
    };
    let bytes = match BASE64.decode(data_b64) {
        Ok(b) => b,
        Err(e) => {
            log::debug!("lanchat: bad chunk base64: {e}");
            return;
        }
    };
    let mut incoming = state.incoming.lock().await;
    let Some(st) = incoming.get_mut(transfer_id) else { return };
    if st.file.write_all(&bytes).await.is_err() {
        return;
    }
    st.received += bytes.len() as u64;
    let (rate, eta) = rate_eta(st.received, st.size, st.started);
    let progress = TransferProgress {
        transfer_id: transfer_id.to_string(),
        direction: "recv".into(),
        name: st.name.clone(),
        size: st.size,
        transferred: st.received,
        rate,
        eta,
        state: "active".into(),
        conv_id: st.conv_id.clone(),
    };
    drop(incoming);
    emit_progress(app, &progress);
}

/// Receiver: sender finished — flush, atomically rename, and report done.
pub async fn handle_file_complete(app: &AppHandle, state: &Arc<LanChatState>, _from: &str, env: &Envelope) {
    let Some(transfer_id) = env.payload.get("transferId").and_then(|v| v.as_str()) else {
        return;
    };
    let st = state.incoming.lock().await.remove(transfer_id);
    state.transfers.write().await.remove(transfer_id);
    if let Some(mut st) = st {
        let _ = st.file.flush().await;
        drop(st.file);
        let ok = tokio::fs::rename(&st.temp_path, &st.save_path).await.is_ok();
        emit_progress(app, &TransferProgress {
            transfer_id: transfer_id.to_string(),
            direction: "recv".into(),
            name: st.name,
            size: st.size,
            transferred: st.received,
            rate: 0.0,
            eta: 0.0,
            state: if ok { "done".into() } else { "failed".into() },
            conv_id: st.conv_id,
        });
    }
}

/// Either side received a pause/resume/cancel control frame from the peer.
pub async fn handle_file_control(app: &AppHandle, state: &Arc<LanChatState>, env: &Envelope) {
    let Some(transfer_id) = env.payload.get("transferId").and_then(|v| v.as_str()) else {
        return;
    };
    if let Some(handle) = state.transfers.read().await.get(transfer_id).cloned() {
        match env.frame_type.as_str() {
            frame::FILE_PAUSE => handle.pause(),
            frame::FILE_RESUME => handle.resume(),
            frame::FILE_CANCEL => handle.cancel(),
            _ => {}
        }
    }
    if env.frame_type == frame::FILE_CANCEL {
        // Receiver: drop the partial file.
        if let Some(st) = state.incoming.lock().await.remove(transfer_id) {
            drop(st.file);
            let _ = tokio::fs::remove_file(&st.temp_path).await;
            emit_progress(app, &TransferProgress {
                transfer_id: transfer_id.to_string(),
                direction: "recv".into(),
                name: st.name,
                size: st.size,
                transferred: st.received,
                rate: 0.0,
                eta: 0.0,
                state: "cancelled".into(),
                conv_id: st.conv_id,
            });
        }
    }
}

/// Resolve the peer on the other end of a transfer (outgoing or incoming).
async fn peer_of(state: &Arc<LanChatState>, transfer_id: &str) -> Option<String> {
    if let Some(m) = state.outgoing.read().await.get(transfer_id) {
        return Some(m.peer_id.clone());
    }
    state.incoming.lock().await.get(transfer_id).map(|s| s.from.clone())
}

/// Pause / resume / cancel a transfer locally and notify the peer.
pub async fn control(app: &AppHandle, state: &Arc<LanChatState>, transfer_id: &str, action: &str) -> Result<(), String> {
    if let Some(handle) = state.transfers.read().await.get(transfer_id).cloned() {
        match action {
            "pause" => handle.pause(),
            "resume" => handle.resume(),
            "cancel" => handle.cancel(),
            _ => return Err(format!("unknown action {action}")),
        }
    }
    let frame_type = match action {
        "pause" => frame::FILE_PAUSE,
        "resume" => frame::FILE_RESUME,
        "cancel" => frame::FILE_CANCEL,
        _ => return Err(format!("unknown action {action}")),
    };
    if let Some(peer) = peer_of(state, transfer_id).await {
        let my_id = state.node_id().await;
        let env = Envelope::new(frame_type, &my_id, Some(peer.clone()), json!({ "transferId": transfer_id }));
        let _ = transport::send_to_peer(app, state, &peer, env).await;
    }
    Ok(())
}

/// Recursively collect regular files under `root` (skipping symlinks/specials),
/// returning (absolute path, forward-slash relative path) pairs + total bytes.
fn walk_dir(root: &std::path::Path) -> (Vec<(PathBuf, String)>, u64) {
    let mut files = Vec::new();
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                if let Ok(rel) = path.strip_prefix(root) {
                    let rel = rel.to_string_lossy().replace('\\', "/");
                    total += meta.len();
                    files.push((path.clone(), rel));
                }
            }
        }
    }
    (files, total)
}

/// Offer a whole folder. The receiver accepts once (choosing a base dir); each
/// file is then streamed and auto-accepted under that base, preserving the
/// relative tree.
pub async fn send_dir(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    peer_id: &str,
    root: PathBuf,
    conv_id: String,
) -> Result<String, String> {
    let meta = tokio::fs::metadata(&root).await.map_err(|e| format!("stat {}: {e}", root.display()))?;
    if !meta.is_dir() {
        return Err("not a directory".into());
    }
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "folder".into());
    let (files, total) = {
        let root = root.clone();
        tokio::task::spawn_blocking(move || walk_dir(&root)).await.map_err(|e| e.to_string())?
    };
    let folder_id = uuid::Uuid::new_v4().to_string();
    state.outgoing_dirs.write().await.insert(
        folder_id.clone(),
        DirMeta { peer_id: peer_id.to_string(), root, name: name.clone(), conv_id: conv_id.clone(), files, total },
    );
    let my_id = state.node_id().await;
    let offer = Envelope::new(
        frame::FILE_OFFER,
        &my_id,
        Some(peer_id.to_string()),
        json!({ "transferId": folder_id, "name": name, "size": total, "mime": "inode/directory", "kind": "dir", "convId": conv_id }),
    );
    transport::send_to_peer(app, state, peer_id, offer).await?;
    emit_progress(app, &TransferProgress {
        transfer_id: folder_id.clone(),
        direction: "send".into(),
        name,
        size: total,
        transferred: 0,
        rate: 0.0,
        eta: 0.0,
        state: "offering".into(),
        conv_id,
    });
    Ok(folder_id)
}

/// Sender: stream every file of an accepted folder, tagging each offer with the
/// folder id so the receiver auto-accepts under its chosen base dir.
async fn run_dir_send(app: &AppHandle, state: &Arc<LanChatState>, folder_id: &str, dir: DirMeta) {
    let my_id = state.node_id().await;
    let started = Instant::now();
    let mut sent_total: u64 = 0;
    for (abs, rel) in &dir.files {
        let size = tokio::fs::metadata(abs).await.map(|m| m.len()).unwrap_or(0);
        let file_id = uuid::Uuid::new_v4().to_string();
        let offer = Envelope::new(
            frame::FILE_OFFER,
            &my_id,
            Some(dir.peer_id.clone()),
            json!({ "transferId": file_id, "folderId": folder_id, "name": rel, "size": size, "mime": "application/octet-stream", "kind": "file", "convId": dir.conv_id }),
        );
        if !transport::try_send(state, &dir.peer_id, offer).await {
            break;
        }
        let meta = OutgoingMeta { peer_id: dir.peer_id.clone(), path: abs.clone(), name: rel.clone(), size, conv_id: dir.conv_id.clone() };
        let handle = Arc::new(LanTransferHandle::new());
        state.transfers.write().await.insert(file_id.clone(), handle.clone());
        run_send_loop(app, state, &file_id, meta, handle).await;
        sent_total += size;
        emit_progress(app, &TransferProgress {
            transfer_id: folder_id.to_string(),
            direction: "send".into(),
            name: dir.name.clone(),
            size: dir.total,
            transferred: sent_total,
            rate: rate_eta(sent_total, dir.total, started).0,
            eta: rate_eta(sent_total, dir.total, started).1,
            state: "active".into(),
            conv_id: dir.conv_id.clone(),
        });
    }
    emit_progress(app, &TransferProgress {
        transfer_id: folder_id.to_string(),
        direction: "send".into(),
        name: dir.name.clone(),
        size: dir.total,
        transferred: sent_total,
        rate: 0.0,
        eta: 0.0,
        state: "done".into(),
        conv_id: dir.conv_id,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_flags_toggle() {
        let h = LanTransferHandle::new();
        assert!(!h.is_cancelled());
        assert!(!h.is_paused());
        h.pause();
        assert!(h.is_paused());
        h.resume();
        assert!(!h.is_paused());
        h.cancel();
        assert!(h.is_cancelled());
    }

    #[tokio::test]
    async fn wait_returns_immediately_when_not_paused() {
        let h = LanTransferHandle::new();
        // Should not block.
        tokio::time::timeout(std::time::Duration::from_millis(200), h.wait_while_paused())
            .await
            .expect("wait_while_paused returned");
    }

    #[test]
    fn mime_guess_basic() {
        assert_eq!(mime_guess_simple("a.png"), "image/png");
        assert_eq!(mime_guess_simple("b.PDF"), "application/pdf");
        assert_eq!(mime_guess_simple("c.bin"), "application/octet-stream");
    }

    #[test]
    fn rate_eta_nonnegative() {
        let started = Instant::now() - std::time::Duration::from_secs(2);
        let (rate, eta) = rate_eta(1000, 5000, started);
        assert!(rate > 0.0);
        assert!(eta >= 0.0);
    }

    #[test]
    fn walk_dir_collects_files_recursively_skipping_symlinks() {
        let base = std::env::temp_dir().join(format!("lanchat-walk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("a.txt"), b"hello").unwrap();
        std::fs::write(base.join("sub/b.txt"), b"world!!").unwrap();
        let (files, total) = walk_dir(&base);
        assert_eq!(files.len(), 2);
        assert_eq!(total, 5 + 7);
        let rels: Vec<&str> = files.iter().map(|(_, r)| r.as_str()).collect();
        assert!(rels.contains(&"a.txt"));
        assert!(rels.iter().any(|r| *r == "sub/b.txt"));
        std::fs::remove_dir_all(&base).ok();
    }
}
