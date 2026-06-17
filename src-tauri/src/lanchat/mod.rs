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
pub mod messaging;
pub mod protocol;
pub mod store;
pub mod transfer;
pub mod transport;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU16;
use std::sync::Mutex as StdMutex;

use mdns_sd::ServiceDaemon;
use tauri::AppHandle;
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::RwLock;

use protocol::PeerRecord;

/// Tauri event channel names emitted to the frontend (all windows).
pub mod events {
    /// Full roster snapshot (`Vec<PeerRecord>`) after a debounced change.
    pub const ROSTER: &str = "lanchat://roster";
    /// A new or updated message (`LanMessage`); the UI upserts by id.
    pub const MESSAGE: &str = "lanchat://message";
    /// A conversation whose unread count / last activity changed.
    pub const CONVERSATION: &str = "lanchat://conversation";
    /// A group whose membership/name changed (`Group`).
    pub const GROUP: &str = "lanchat://group";
    /// An inbound file offer awaiting accept/reject.
    pub const FILE_OFFER: &str = "lanchat://file-offer";
    /// A transfer progress / state update (`TransferProgress`).
    pub const TRANSFER: &str = "lanchat://transfer";
    /// A WebRTC signaling frame from a peer (`{from,type,payload}`).
    pub const SIGNAL: &str = "lanchat://signal";
    /// A whiteboard frame from a peer (`{from,type,payload}`).
    pub const WB: &str = "lanchat://wb";
}

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
    /// Peers discovered via mDNS, keyed by node id.
    pub peers: RwLock<HashMap<String, PeerRecord>>,
    /// Live control-channel connections, keyed by remote node id.
    pub connections: RwLock<HashMap<String, transport::ConnHandle>>,
    /// mDNS service daemon handle (set when discovery starts). Cloneable; kept
    /// so profile edits can re-announce the TXT record.
    pub daemon: StdMutex<Option<ServiceDaemon>>,
    /// TCP control-channel port (reserved at startup, advertised in mDNS TXT).
    pub control_port: AtomicU16,
    /// Reserved control listener, handed to the transport accept loop (phase 4).
    pub control_listener: AsyncMutex<Option<TcpListener>>,
    /// Active file transfers, keyed by transfer id (cancel/pause handles).
    pub transfers: RwLock<HashMap<String, std::sync::Arc<transfer::LanTransferHandle>>>,
    /// Outgoing transfers awaiting the peer's accept, keyed by transfer id.
    pub outgoing: RwLock<HashMap<String, transfer::OutgoingMeta>>,
    /// Inbound offers awaiting the local user's accept/reject, by transfer id.
    pub offers: RwLock<HashMap<String, transfer::OfferInfo>>,
    /// In-progress inbound writes, keyed by transfer id.
    pub incoming: AsyncMutex<HashMap<String, transfer::IncomingState>>,
    /// Receiver: accepted folder transfers → chosen base dir, keyed by folder id.
    pub accepted_folders: RwLock<HashMap<String, std::path::PathBuf>>,
    /// Sender: folder transfers awaiting accept, keyed by folder id.
    pub outgoing_dirs: RwLock<HashMap<String, transfer::DirMeta>>,
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
            connections: RwLock::new(HashMap::new()),
            daemon: StdMutex::new(None),
            control_port: AtomicU16::new(0),
            control_listener: AsyncMutex::new(None),
            transfers: RwLock::new(HashMap::new()),
            outgoing: RwLock::new(HashMap::new()),
            offers: RwLock::new(HashMap::new()),
            incoming: AsyncMutex::new(HashMap::new()),
            accepted_folders: RwLock::new(HashMap::new()),
            outgoing_dirs: RwLock::new(HashMap::new()),
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
/// Reserves the TCP control port, starts the transport accept loop over that
/// listener, then runs mDNS discovery. Discovery + transport run concurrently
/// for the lifetime of the app.
pub async fn start(app: AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri::Manager;

    let lanchat = app.state::<crate::state::AppState>().lanchat.clone();

    // Reserve an ephemeral control port now so the mDNS TXT can advertise it;
    // the transport accept loop takes over this listener below.
    match TcpListener::bind(("0.0.0.0", 0)).await {
        Ok(listener) => {
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            lanchat.control_port.store(port, Ordering::SeqCst);
            *lanchat.control_listener.lock().await = Some(listener);
            log::info!("lanchat: reserved control port {}", port);

            // Transport accept loop (takes the reserved listener).
            let app_t = app.clone();
            let state_t = lanchat.clone();
            tokio::spawn(async move {
                transport::run_listener(app_t, state_t).await;
            });

            // mDNS discovery (runs for the app lifetime).
            discovery::run(app, lanchat, port).await;
        }
        Err(e) => {
            log::error!("lanchat: failed to reserve control port: {e}");
        }
    }
}
