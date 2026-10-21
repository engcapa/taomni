use super::offers::payload_file_id;
use super::offers::reject_offer;
use super::offers::send;
use super::progress::TransferProgress;
use super::progress::emit_progress;
use crate::lanchat::LanChatState;
use crate::lanchat::protocol::Envelope;
use crate::lanchat::protocol::frame;
use crate::lanchat::transport;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::AppHandle;
use tauri::Emitter;

/* --------------------------- pause / resume / cancel ---------------------- */

/// Local pause/resume/cancel from the UI. Cancelling a transfer that is still
/// only "offering" (peer not yet accepted) now emits a terminal `cancelled`
/// progress and tears down state — fixing the stuck "等待对方接收…" card.
pub async fn control(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    file_id: &str,
    action: &str,
) -> Result<(), String> {
    if let Some(sf) = state.swarms.read().await.get(file_id).cloned() {
        match action {
            "pause" => {
                sf.paused.store(true, Ordering::SeqCst);
                sf.emit(app, Some("paused")).await;
            }
            "resume" => {
                sf.paused.store(false, Ordering::SeqCst);
                sf.resume.notify_waiters();
                sf.wake.notify_waiters();
                sf.emit(app, None).await;
            }
            "cancel" => {
                sf.cancelled.store(true, Ordering::SeqCst);
                sf.resume.notify_waiters();
                sf.wake.notify_waiters();
                let peers: Vec<String> = sf.inner.lock().await.peers.keys().cloned().collect();
                let my_id = state.node_id().await;
                for p in &peers {
                    let env = Envelope::new(
                        frame::SWARM_CANCEL,
                        &my_id,
                        Some(p.clone()),
                        json!({ "fileId": file_id }),
                    );
                    let _ = transport::try_send(state, p, env).await;
                }
                if sf.direction == "recv" {
                    *sf.file.lock().unwrap() = None;
                    let _ = tokio::fs::remove_file(&sf.temp_path).await;
                }
                sf.emit(app, Some("cancelled")).await;
                state.swarms.write().await.remove(file_id);
            }
            _ => return Err(format!("unknown action {action}")),
        }
        return Ok(());
    }
    // Not active: a still-pending inbound offer — cancel == reject + clear card.
    if action == "cancel" {
        let conv = state
            .swarm_offers
            .read()
            .await
            .get(file_id)
            .map(|o| (o.conv_id.clone(), o.manifest.name.clone(), o.manifest.size));
        reject_offer(app, state, file_id).await?;
        if let Some((conv_id, name, size)) = conv {
            emit_progress(
                app,
                &TransferProgress {
                    transfer_id: file_id.to_string(),
                    direction: "recv".into(),
                    name,
                    size,
                    transferred: 0,
                    rate: 0.0,
                    eta: 0.0,
                    state: "cancelled".into(),
                    conv_id,
                },
            );
        }
    }
    Ok(())
}

/// Inbound `swarm-cancel`. If our origin cancelled, abort locally and drop the
/// partial file; if a mere peer left the swarm, just stop using it as a source.
pub async fn handle_cancel(app: &AppHandle, state: &Arc<LanChatState>, from: &str, env: &Envelope) {
    let Some(file_id) = payload_file_id(env) else {
        return;
    };
    // Sender rescinded a still-pending offer: clear the receiver's prompt.
    if let Some(offer) = state.swarm_offers.write().await.remove(&file_id) {
        emit_progress(
            app,
            &TransferProgress {
                transfer_id: file_id.clone(),
                direction: "recv".into(),
                name: offer.manifest.name,
                size: offer.manifest.size,
                transferred: 0,
                rate: 0.0,
                eta: 0.0,
                state: "cancelled".into(),
                conv_id: offer.conv_id,
            },
        );
    }
    let Some(sf) = state.swarms.read().await.get(&file_id).cloned() else {
        return;
    };
    let from_origin = sf.origin.as_deref() == Some(from);
    if from_origin {
        sf.cancelled.store(true, Ordering::SeqCst);
        sf.resume.notify_waiters();
        sf.wake.notify_waiters();
        *sf.file.lock().unwrap() = None;
        let _ = tokio::fs::remove_file(&sf.temp_path).await;
        sf.emit(app, Some("cancelled")).await;
        state.swarms.write().await.remove(&file_id);
    } else {
        let mut inner = sf.inner.lock().await;
        inner.peers.remove(from);
        let drop_pieces: Vec<u32> = inner
            .inflight
            .iter()
            .filter(|(_, (p, _))| p == from)
            .map(|(i, _)| *i)
            .collect();
        for i in drop_pieces {
            inner.inflight.remove(&i);
        }
        drop(inner);
        sf.wake.notify_waiters();
    }
}

/* --------------------------------- group --------------------------------- */

/// Offer a single file to every member of a group. Every member that accepts
/// leeches from the origin and trades pieces with the other members.
pub async fn send_to_group(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    group_id: &str,
    path: PathBuf,
) -> Result<String, String> {
    let my_id = state.node_id().await;
    let members: Vec<String> = state
        .store
        .list_group_members(group_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|m| *m != my_id)
        .collect();
    if members.is_empty() {
        return Err("群里没有其他在线成员".into());
    }
    let conv_id = crate::lanchat::store::group_conv_id(group_id);
    send(
        app,
        state,
        members.clone(),
        members,
        path,
        conv_id,
        Some(group_id.to_string()),
    )
    .await
}

/// Offer a whole folder (recursive). Implemented as a one-accept decomposition
/// into per-file swarms (see `send_dir` impl, added after the single-file path
/// is verified).
pub async fn send_dir(
    _app: &AppHandle,
    _state: &Arc<LanChatState>,
    _targets: Vec<String>,
    _root: PathBuf,
    _conv_id: String,
    _group_id: Option<String>,
) -> Result<String, String> {
    Err("文件夹传输正在适配 swarm 引擎（即将恢复）".into())
}
