use super::bitfield::Bitfield;
use super::manifest::Manifest;
use super::progress::TransferProgress;
use super::progress::emit_progress;
use super::progress::rate_eta;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tauri::AppHandle;
use tokio::sync::Mutex;
use tokio::sync::Notify;

/* ------------------------------ swarm state ------------------------------ */

/// Inbound offer awaiting the local user's accept/reject.
#[derive(Clone)]
pub struct OfferInfo {
    pub manifest: Manifest,
    pub from: String,
    pub conv_id: String,
    pub group_id: Option<String>,
    /// "file" | "dir".
    pub kind: String,
    /// Other swarm peers (group members); empty for a 1:1 offer.
    pub members: Vec<String>,
    pub mime: String,
}

/// Mutable scheduling state, behind one async mutex to avoid lock ordering.
pub(super) struct SwarmInner {
    pub(super) have: Bitfield,
    /// What each swarm peer holds (origin starts full).
    pub(super) peers: HashMap<String, Bitfield>,
    /// piece -> (peer we asked, deadline).
    pub(super) inflight: HashMap<u32, (String, Instant)>,
}

/// One active transfer on this node (origin seed or leecher), keyed by file id.
pub struct SwarmFile {
    pub manifest: Manifest,
    pub conv_id: String,
    pub group_id: Option<String>,
    /// "send" = we originated (seed only); "recv" = we are leeching.
    pub direction: String,
    pub save_path: PathBuf,
    pub temp_path: PathBuf,
    /// The origin we leech from (`None` when this node *is* the origin). Used to
    /// tell a global abort (origin cancelled) from a peer merely leaving.
    pub(super) origin: Option<String>,
    pub(super) file: std::sync::Mutex<Option<Arc<std::fs::File>>>,
    pub(super) inner: Mutex<SwarmInner>,
    pub(super) cancelled: AtomicBool,
    pub(super) paused: AtomicBool,
    pub(super) resume: Notify,
    /// Wakes the leecher drive loop on piece / have / new-peer events.
    pub(super) wake: Notify,
    pub(super) started: Instant,
    pub(super) finalized: AtomicBool,
}

impl SwarmFile {
    pub(super) fn file_handle(&self) -> Option<Arc<std::fs::File>> {
        self.file.lock().unwrap().clone()
    }
    pub(super) fn set_file(&self, f: Arc<std::fs::File>) {
        *self.file.lock().unwrap() = Some(f);
    }
    pub(super) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    pub(super) fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
    pub(super) async fn wait_while_paused(&self) {
        while self.is_paused() && !self.is_cancelled() {
            self.resume.notified().await;
        }
    }
    /// Bytes "transferred" for the progress card: for a leecher this is what we
    /// hold; for an origin it is the slowest accepted peer (so it reads 100%
    /// only when every member finished).
    pub(super) async fn transferred_bytes(&self) -> u64 {
        let inner = self.inner.lock().await;
        let ps = self.manifest.piece_size as u64;
        let pieces = if self.direction == "recv" {
            inner.have.count() as u64
        } else if inner.peers.is_empty() {
            0
        } else {
            inner
                .peers
                .values()
                .map(|b| b.count() as u64)
                .min()
                .unwrap_or(0)
        };
        (pieces * ps).min(self.manifest.size)
    }
    pub(super) fn progress_state(&self, transferred: u64) -> &'static str {
        if self.is_cancelled() {
            "cancelled"
        } else if self.is_paused() {
            "paused"
        } else if self.direction == "send" && transferred == 0 {
            "offering"
        } else {
            "active"
        }
    }
    pub(super) async fn emit(&self, app: &AppHandle, state_override: Option<&str>) {
        let transferred = self.transferred_bytes().await;
        let (rate, eta) = rate_eta(transferred, self.manifest.size, self.started);
        let state = state_override.unwrap_or_else(|| self.progress_state(transferred));
        emit_progress(
            app,
            &TransferProgress {
                transfer_id: self.manifest.file_id.clone(),
                direction: self.direction.clone(),
                name: self.manifest.name.clone(),
                size: self.manifest.size,
                transferred,
                rate,
                eta,
                state: state.to_string(),
                conv_id: self.conv_id.clone(),
            },
        );
    }
}
