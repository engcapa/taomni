use super::connection::ensure_connection;
use super::limits::MEDIA_QUEUE_CAP;
use crate::lanchat::LanChatState;
use crate::lanchat::protocol::Envelope;
use futures::StreamExt;
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicU64;
use tauri::AppHandle;
use tokio::sync::Notify;
use tokio::sync::mpsc;

/// Monotonic per-process connection id. Stamped onto every [`ConnHandle`] so the
/// read loop's teardown only removes the map entry if it is still *its own*
/// connection — a replaced/older socket closing later must not evict the live one.
pub(super) static CONN_SEQ: AtomicU64 = AtomicU64::new(1);

/// A live connection to a peer: its id/address plus three outbound queues
/// drained by the connection's write task — a small unbounded control queue
/// (JSON envelopes), a bounded blocking binary-data queue (file pieces, the
/// backpressure point), and a bounded **drop-oldest** real-time media queue
/// (TAG_MEDIA frames). The write task prioritizes control > media > file-data.
pub struct ConnHandle {
    pub peer_id: String,
    pub addr: SocketAddr,
    /// Unique id for this physical connection (see [`CONN_SEQ`]).
    pub(super) conn_id: u64,
    /// True if we dialed this connection, false if we accepted it. Drives the
    /// deterministic glare tie-break when both peers connect simultaneously.
    pub(super) outbound: bool,
    /// Signals the connection's read loop to tear down (used when a duplicate
    /// connection deterministically replaces this one).
    pub(super) close: Arc<Notify>,
    pub(super) control_tx: mpsc::UnboundedSender<Envelope>,
    pub(super) data_tx: mpsc::Sender<bytes::Bytes>,
    /// Drop-oldest media queue + its wake signal (see [`MediaQueue`]). Read by
    /// [`send_media`] (wired by the native-media commands in a later phase).
    #[allow(dead_code)]
    pub(super) media: Arc<MediaQueue>,
}

/// A bounded, drop-oldest queue for real-time media frames. Producers
/// ([`send_media`]) never block: when full, the oldest frame is discarded.
/// The connection's write task drains it on `notify`.
pub(super) struct MediaQueue {
    pub(super) inner: StdMutex<VecDeque<bytes::Bytes>>,
    pub(super) notify: Notify,
}

impl MediaQueue {
    pub(super) fn new() -> Self {
        Self {
            inner: StdMutex::new(VecDeque::with_capacity(MEDIA_QUEUE_CAP)),
            notify: Notify::new(),
        }
    }

    /// Enqueue a media frame, dropping the oldest if the queue is at capacity.
    /// Non-blocking; returns the number of frames dropped (0 normally, 1 on
    /// overflow) for diagnostics.
    #[allow(dead_code)] // called by send_media, wired by native-media commands
    pub(super) fn push(&self, bytes: bytes::Bytes) -> usize {
        let dropped = {
            let mut q = self.inner.lock().unwrap();
            let dropped = if q.len() >= MEDIA_QUEUE_CAP {
                q.pop_front().is_some() as usize
            } else {
                0
            };
            q.push_back(bytes);
            dropped
        };
        self.notify.notify_one();
        dropped
    }

    pub(super) fn pop(&self) -> Option<bytes::Bytes> {
        self.inner.lock().unwrap().pop_front()
    }
}

impl ConnHandle {
    /// Queue a control envelope for delivery to this peer.
    pub fn send(&self, env: Envelope) -> Result<(), String> {
        self.control_tx
            .send(env)
            .map_err(|_| "connection closed".to_string())
    }
}

/// Send to a peer over an already-established connection, without dialing.
/// Returns false if there is no live connection. Used by tight loops (file
/// transfer) that run after a connection is known to exist, avoiding the
/// dial machinery (which would create a non-Send type cycle with dispatch).
pub async fn try_send(state: &Arc<LanChatState>, peer_id: &str, env: Envelope) -> bool {
    match state.connections.read().await.get(peer_id) {
        Some(handle) => handle.send(env).is_ok(),
        None => false,
    }
}

/// Send a binary data frame (a file piece) to a peer over the bounded data
/// queue, awaiting a free slot if it is full. This `.await` is the swarm's
/// backpressure: a seeder cannot read faster than the network drains. Returns
/// false if there is no live connection.
pub async fn send_data(state: &Arc<LanChatState>, peer_id: &str, bytes: bytes::Bytes) -> bool {
    let sender = match state.connections.read().await.get(peer_id) {
        Some(handle) => handle.data_tx.clone(),
        None => return false,
    };
    sender.send(bytes).await.is_ok()
}

/// Enqueue a real-time media frame (a pre-tagged TAG_MEDIA body) to a peer over
/// the drop-oldest media queue. Never blocks: if the queue is full the oldest
/// frame is discarded so the encoder is never throttled and latency stays
/// bounded. Returns false if there is no live connection. Intended for the hot
/// path of [`crate::lanchat::media`], so it only takes the connections read lock
/// briefly and does no `.await` on the queue itself.
#[allow(dead_code)] // hot path of lanchat::media, wired by native-media commands
pub async fn send_media(state: &Arc<LanChatState>, peer_id: &str, bytes: bytes::Bytes) -> bool {
    let media = match state.connections.read().await.get(peer_id) {
        Some(handle) => handle.media.clone(),
        None => return false,
    };
    media.push(bytes);
    true
}

/// Queue an envelope to a peer, dialing on demand if not yet connected.
pub async fn send_to_peer(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    peer_id: &str,
    env: Envelope,
) -> Result<(), String> {
    ensure_connection(app, state, peer_id).await?;
    let conns = state.connections.read().await;
    let handle = conns
        .get(peer_id)
        .ok_or_else(|| format!("no live connection to {peer_id}"))?;
    handle.send(env)
}
