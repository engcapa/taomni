//! LanChat — decentralized LAN messenger module (飞鸽传书-style, modernized).
//!
//! Peer-to-peer, no central server: nodes discover each other on the LAN via
//! mDNS/DNS-SD and connect directly over a length-prefixed JSON TCP control
//! channel. This module owns discovery, transport, the wire protocol, local
//! SQLite persistence, and the Tauri command surface.
//!
//! Naming is deliberately kept distinct from the AI-assistant `chat`/`voice`
//! modules: backend `lanchat`, command prefix `lanchat_*`, events `lanchat://*`,
//! SQLite file `lanchat.sqlite`.
//!
//! Build-out is phased; each submodule's doc notes which phase fills it in.

pub mod commands;
pub mod discovery;
pub mod protocol;
pub mod store;
pub mod transport;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tokio::sync::RwLock;

use protocol::PeerRecord;

/// Shared LanChat runtime state, held by `AppState.lanchat`.
///
/// The backend owns all live P2P state here; frontend windows (main or
/// detached) are pure views that subscribe to `lanchat://*` events and call
/// `lanchat_*` commands. Fields are populated as later phases land.
pub struct LanChatState {
    /// Path to the per-app `lanchat.sqlite` (schema created on open).
    pub db_path: PathBuf,
    /// SQLite-backed persistence (profile / peers / groups / messages).
    pub store: store::LanChatStore,
    /// This node's stable identity (loaded/generated on construction).
    pub node_id: RwLock<String>,
    /// Peers discovered via mDNS, keyed by node id (populated in phase 3).
    pub peers: RwLock<HashMap<String, PeerRecord>>,
}

impl LanChatState {
    /// Build state, opening `lanchat.sqlite` and bootstrapping this node's
    /// stable identity. `app_data_dir` is the resolved Tauri app-data dir; the
    /// SQLite file lives alongside the main `taomni.db` but is separate.
    pub fn new(app_data_dir: &Path) -> Self {
        let db_path = app_data_dir.join("lanchat.sqlite");
        let store = store::LanChatStore::open(&db_path).expect("failed to open lanchat.sqlite");
        let node_id = store
            .ensure_identity()
            .expect("failed to initialize lanchat identity");
        log::info!("lanchat: node identity {}", node_id);
        Self {
            db_path,
            store,
            node_id: RwLock::new(node_id),
            peers: RwLock::new(HashMap::new()),
        }
    }

    /// This node's stable id.
    pub async fn node_id(&self) -> String {
        self.node_id.read().await.clone()
    }

    /// Number of peers currently in the live roster.
    pub async fn peer_count(&self) -> usize {
        self.peers.read().await.len()
    }
}

/// Launch the LanChat background service.
///
/// Phase 1: skeleton that logs and idles — it establishes the startup hook
/// and proves the spawn wiring without changing behavior. Later phases start
/// mDNS discovery (phase 3) and the TCP control listener (phase 4) here.
pub async fn start(_app: AppHandle) {
    log::info!("lanchat: background service started (skeleton)");
}
