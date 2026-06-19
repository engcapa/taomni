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

pub mod beacon;
pub mod commands;
pub mod discovery;
pub mod identity;
pub mod keystore;
pub mod messaging;
pub mod protocol;
pub mod store;
pub mod tls;
pub mod transfer;
pub mod transport;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16};
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
    /// A security event: a peer's presented identity was rejected (spoofed id or
    /// a changed pinned key). Payload `{ peerId, addr, kind }`.
    pub const SECURITY: &str = "lanchat://security";
    /// Service lifecycle change. Payload `{ running: bool }`. Emitted when the
    /// background service starts (boot autostart or manual enable) so every
    /// window can switch the panel from "not enabled" to live.
    pub const SERVICE: &str = "lanchat://service";
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
    /// Machine-bound secret store (OS keychain + file fallback) for the identity
    /// key and the at-rest message-encryption key.
    pub keystore: keystore::KeyStore,
    /// This node's self-certifying identity (cert + private key DER); the TLS
    /// transport (phase 2) builds its rustls config from this.
    pub identity: identity::Identity,
    /// Shared mutual-TLS configs for the control channel (built once from the
    /// identity): server side accepts inbound, client side dials out.
    pub tls_server: std::sync::Arc<rustls::ServerConfig>,
    pub tls_client: std::sync::Arc<rustls::ClientConfig>,
    /// This node's stable identity (loaded/generated on construction).
    pub node_id: RwLock<String>,
    /// Whether the background service (discovery + transport + beacon) has been
    /// started. A one-way latch: set true on first `start_service`, never
    /// cleared while the app runs (there is no runtime "stop"). Guards against
    /// double-start when both boot-autostart and a manual enable race.
    pub running: AtomicBool,
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
        let keystore = keystore::KeyStore::new(app_data_dir);
        // At-rest message encryption: load (or create) the machine key, attach it
        // to the store, and encrypt any legacy plaintext rows. If the key is
        // unavailable, messages stay plaintext rather than failing to start.
        match keystore.load_or_create_random("message-key-v1", 32) {
            Ok(key) => {
                store.set_message_key(&key);
                match store.migrate_message_encryption() {
                    Ok(n) if n > 0 => log::info!("lanchat: encrypted {n} legacy message(s) at rest"),
                    Ok(_) => {}
                    Err(e) => log::warn!("lanchat: message encryption migration failed: {e}"),
                }
            }
            Err(e) => {
                log::error!("lanchat: message key unavailable ({e}); messages stored in plaintext")
            }
        }
        // Bootstrap the self-certifying identity (generates a key pair + cert on
        // first launch, migrates from a legacy UUID identity if present).
        let identity = identity::ensure(&store, &keystore)
            .expect("failed to initialize lanchat identity");
        let node_id = identity.node_id.clone();
        log::info!("lanchat: node identity {}", node_id);
        let tls_server = tls::server_config(&identity).expect("build lanchat server TLS config");
        let tls_client = tls::client_config(&identity).expect("build lanchat client TLS config");
        Self {
            db_path,
            store,
            keystore,
            identity,
            tls_server,
            tls_client,
            node_id: RwLock::new(node_id),
            running: AtomicBool::new(false),
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

/// Launch the LanChat background service (idempotent, one-way).
///
/// Reserves the TCP control port, starts the transport accept loop over that
/// listener, then runs mDNS discovery. Discovery + transport run concurrently
/// for the lifetime of the app — there is no runtime "stop"; the only way to
/// go dark is to not start (see the `start_on_launch` policy) or quit the app.
///
/// Safe to call more than once: the first call latches `running` and proceeds;
/// later calls return immediately. This lets boot-autostart and a manual
/// `lanchat_start_service` from the UI race without double-binding the port.
pub async fn start_service(app: AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri::{Emitter, Manager};

    let lanchat = app.state::<crate::state::AppState>().lanchat.clone();

    // One-way latch: if already started, do nothing.
    if lanchat.running.swap(true, Ordering::SeqCst) {
        return;
    }

    // Reserve an ephemeral control port now so the mDNS TXT can advertise it;
    // the transport accept loop takes over this listener below.
    match TcpListener::bind(("0.0.0.0", 0)).await {
        Ok(listener) => {
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            lanchat.control_port.store(port, Ordering::SeqCst);
            *lanchat.control_listener.lock().await = Some(listener);
            log::info!("lanchat: reserved control port {}", port);

            // Announce the service is now live to every window.
            let _ = app.emit(events::SERVICE, serde_json::json!({ "running": true }));

            // Transport accept loop (takes the reserved listener).
            let app_t = app.clone();
            let state_t = lanchat.clone();
            tokio::spawn(async move {
                transport::run_listener(app_t, state_t).await;
            });

            // UDP broadcast beacon discovery (fallback for WiFi multicast suppression).
            let app_b = app.clone();
            let state_b = lanchat.clone();
            tokio::spawn(async move {
                beacon::run(app_b, state_b, port).await;
            });

            // Historic peer reconnection (in background, delayed slightly).
            let app_r = app.clone();
            let state_r = lanchat.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                // 7 days in ms
                let recent = state_r.store.list_recent_peers(7 * 24 * 3600 * 1000);
                for peer in recent {
                    if state_r.connections.read().await.contains_key(&peer.id) {
                        continue;
                    }
                    if let (Some(addr), Some(p)) = (&peer.addr, peer.port) {
                        log::info!("lanchat: reconnecting to historic peer {} ({}:{})", peer.name, addr, p);
                        if let Err(e) = transport::ensure_connection(&app_r, &state_r, &peer.id).await {
                            log::debug!("lanchat: historic reconnect to {} failed: {}", peer.id, e);
                        }
                    }
                }
            });

            // Periodic retention cleanup: sweep on startup and every 6 hours.
            let state_c = lanchat.clone();
            tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(std::time::Duration::from_secs(6 * 3600));
                loop {
                    interval.tick().await; // fires immediately on the first iteration
                    match state_c.store.apply_retention() {
                        Ok(n) if n > 0 => {
                            log::info!("lanchat: retention removed {n} message(s)");
                            let _ = state_c.store.vacuum();
                        }
                        Ok(_) => {}
                        Err(e) => log::warn!("lanchat: retention sweep failed: {e}"),
                    }
                }
            });

            // mDNS discovery (runs for the app lifetime).
            discovery::run(app, lanchat, port).await;
        }
        Err(e) => {
            log::error!("lanchat: failed to reserve control port: {e}");
            // Roll back the latch so a later manual enable can retry.
            lanchat.running.store(false, Ordering::SeqCst);
            let _ = app.emit(events::SERVICE, serde_json::json!({ "running": false }));
        }
    }
}
