//! Shared SSH channel pool for SSH-jump egress (plan §4.3, §16.5-18).
//!
//! One saved SSH session is the egress; each TCP flow opens a `direct-tcpip`
//! channel on a bounded, shared control-connection pool (keepalive, channel
//! limit, exponential-backoff reconnect). Host keys are verified via the
//! Sockscap known_hosts store (plan §16.5-19) — a changed key aborts the
//! handshake. Standard `direct-tcpip` carries TCP only; UDP/QUIC is decided by
//! the policy layer (default BLOCK), never smuggled here (plan §7, §16.2-6).
//!
//! The pure helpers (slot selection, backoff, health, host-key verdict wiring)
//! are unit-tested; opening a real channel needs a live SSH server and is gated
//! behind an env-var live test.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex as StdMutex;
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use russh::client;
use russh::keys::PublicKey;
use russh::ChannelStream;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::Mutex as AsyncMutex;

use crate::terminal::ssh::{
    connect_ssh_egress, HostKeyCheck, HostKeyVerifier, SshAuth, SshHandler,
};

use super::egress::{
    BoxedEgressStream, DnsResolution, EgressConnector, EgressKindLabel, EgressMetadata, Endpoint,
};
use super::known_hosts::{HostKeyStore, HostKeyVerdict};

/// Bounded pool tuning (mirrors `model::SshPoolOptions`, no secrets).
#[derive(Debug, Clone)]
pub struct PoolLimits {
    pub max_control_connections: usize,
    pub max_channels_per_control: usize,
    pub keepalive_secs: u64,
    pub connect_timeout_secs: u64,
}

impl Default for PoolLimits {
    fn default() -> Self {
        PoolLimits {
            max_control_connections: 2,
            max_channels_per_control: 64,
            keepalive_secs: 30,
            connect_timeout_secs: 15,
        }
    }
}

/// Health of an SSH egress (plan §4.3-3, §16.5-20). A dropped control
/// connection moves the profile to `Degraded`; auth/host-key/MFA problems that
/// need a human move it to `UserActionRequired` — never a silent switch to
/// another upstream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoolHealth {
    Healthy,
    Degraded { reason: String },
    UserActionRequired { reason: String },
}

/// The static egress definition (no secrets beyond what a connect needs; the
/// SSH session + credentials live in taomni.db + Vault).
#[derive(Clone)]
pub struct SshEgressConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuthSpec,
    pub limits: PoolLimits,
}

/// Auth material for a connect. Mirrors `terminal::ssh::SshAuth` but is `Clone`
/// so the pool can reconnect (Agent / private-key / already-resolved password).
#[derive(Clone)]
pub enum SshAuthSpec {
    Password(String),
    PrivateKey(String),
    Agent,
}

impl SshAuthSpec {
    fn to_ssh_auth(&self) -> SshAuth {
        match self {
            SshAuthSpec::Password(p) => SshAuth::Password(p.clone()),
            SshAuthSpec::PrivateKey(p) => SshAuth::PrivateKey(p.clone()),
            SshAuthSpec::Agent => SshAuth::Agent,
        }
    }
}

/// Host-key verifier backed by the Sockscap known_hosts store. Records the last
/// offered key and verdict so the caller can raise a first-use confirmation or
/// a MITM alarm (plan §16.5-19).
pub struct StoreHostKeyVerifier {
    store: Arc<StdMutex<HostKeyStore>>,
    host: String,
    port: u16,
    last_verdict: Arc<StdMutex<Option<HostKeyVerdict>>>,
    last_key: Arc<StdMutex<Option<PublicKey>>>,
}

impl StoreHostKeyVerifier {
    pub fn new(store: Arc<StdMutex<HostKeyStore>>, host: impl Into<String>, port: u16) -> Self {
        StoreHostKeyVerifier {
            store,
            host: host.into(),
            port,
            last_verdict: Arc::new(StdMutex::new(None)),
            last_key: Arc::new(StdMutex::new(None)),
        }
    }

    /// The verdict from the most recent `check` (for the caller to act on after
    /// a rejected handshake).
    pub fn last_verdict(&self) -> Option<HostKeyVerdict> {
        self.last_verdict.lock().unwrap().clone()
    }

    /// The offered key from the most recent `check` (e.g. to trust on first use).
    pub fn last_key(&self) -> Option<PublicKey> {
        self.last_key.lock().unwrap().clone()
    }
}

impl HostKeyCheck for StoreHostKeyVerifier {
    fn check(&self, key: &PublicKey) -> bool {
        let verdict = self
            .store
            .lock()
            .unwrap()
            .verify(&self.host, self.port, key);
        *self.last_key.lock().unwrap() = Some(key.clone());
        let trusted = verdict.is_trusted();
        *self.last_verdict.lock().unwrap() = Some(verdict);
        trusted
    }
}

/// Exponential backoff with a cap. `attempt` 0 → `base`, doubling each retry.
pub fn backoff_delay(attempt: u32, base_ms: u64, cap_ms: u64) -> Duration {
    let shift = attempt.min(16);
    let ms = base_ms.saturating_mul(1u64 << shift).min(cap_ms);
    Duration::from_millis(ms)
}

/// One control connection and its live channel count.
struct ControlSlot {
    handle: Arc<client::Handle<SshHandler>>,
    active: Arc<AtomicUsize>,
    alive: bool,
}

/// Pick the least-loaded alive slot with spare channel capacity, given a view
/// of `(alive, active_channels)` per slot. Pure so it can be unit-tested
/// without live SSH handles.
fn choose_slot(view: &[(bool, usize)], max_channels: usize) -> Option<usize> {
    view.iter()
        .enumerate()
        .filter(|(_, (alive, active))| *alive && *active < max_channels)
        .min_by_key(|(_, (_, active))| *active)
        .map(|(i, _)| i)
}

/// Decrements a slot's active-channel counter when the flow's stream is dropped.
struct SlotGuard {
    counter: Arc<AtomicUsize>,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A flow stream that keeps its slot's channel count accurate on drop.
pub struct GuardedStream<S> {
    inner: S,
    _guard: SlotGuard,
}

impl<S: AsyncRead + Unpin> AsyncRead for GuardedStream<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for GuardedStream<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// The shared, bounded SSH channel pool for one jump-host egress.
pub struct SshChannelPool {
    config: SshEgressConfig,
    store: Arc<StdMutex<HostKeyStore>>,
    slots: AsyncMutex<Vec<ControlSlot>>,
    health: StdMutex<PoolHealth>,
}

impl SshChannelPool {
    pub fn new(config: SshEgressConfig, store: Arc<StdMutex<HostKeyStore>>) -> Arc<SshChannelPool> {
        Arc::new(SshChannelPool {
            config,
            store,
            slots: AsyncMutex::new(Vec::new()),
            health: StdMutex::new(PoolHealth::Healthy),
        })
    }

    pub fn health(&self) -> PoolHealth {
        self.health.lock().unwrap().clone()
    }

    fn set_health(&self, h: PoolHealth) {
        *self.health.lock().unwrap() = h;
    }

    /// The jump endpoint (`host:port`) — also a hard-bypass target for the
    /// engine so the control connection can't be re-captured (plan §4.3-6).
    pub fn jump_endpoint(&self) -> String {
        format!("{}:{}", self.config.host, self.config.port)
    }

    /// Open a new control connection, verifying the host key. Maps host-key /
    /// timeout / auth failures to the right health state.
    async fn connect_new(&self) -> Result<ControlSlot, String> {
        let verifier = Arc::new(StoreHostKeyVerifier::new(
            self.store.clone(),
            &self.config.host,
            self.config.port,
        ));
        let verifier_dyn: HostKeyVerifier = verifier.clone();
        let auth = self.config.auth.to_ssh_auth();
        let fut = connect_ssh_egress(
            &self.config.host,
            self.config.port,
            &self.config.username,
            auth,
            None,
            Some(verifier_dyn),
            None,
        );
        let timeout = Duration::from_secs(self.config.limits.connect_timeout_secs);
        let handle = match tokio::time::timeout(timeout, fut).await {
            Err(_) => {
                self.set_health(PoolHealth::Degraded {
                    reason: "ssh connect timeout".into(),
                });
                return Err("ssh connect timeout".into());
            }
            Ok(Err(e)) => {
                // A rejected host key surfaces via the verifier's last verdict.
                match verifier.last_verdict() {
                    Some(HostKeyVerdict::Changed { .. }) => {
                        self.set_health(PoolHealth::UserActionRequired {
                            reason: "ssh host key changed — possible MITM".into(),
                        });
                        return Err(format!("ssh host key changed: {e}"));
                    }
                    Some(HostKeyVerdict::Unknown { .. }) => {
                        self.set_health(PoolHealth::UserActionRequired {
                            reason: "ssh host key not trusted (first-use confirmation)".into(),
                        });
                        return Err(format!("ssh host key not trusted: {e}"));
                    }
                    _ => {
                        self.set_health(PoolHealth::Degraded { reason: e.clone() });
                        return Err(e);
                    }
                }
            }
            Ok(Ok(h)) => h,
        };
        self.set_health(PoolHealth::Healthy);
        Ok(ControlSlot {
            handle: Arc::new(handle),
            active: Arc::new(AtomicUsize::new(0)),
            alive: true,
        })
    }

    /// Open a `direct-tcpip` channel for one flow, reusing or growing the pool.
    pub async fn open_direct_tcpip(
        &self,
        target_host: &str,
        target_port: u16,
    ) -> Result<GuardedStream<ChannelStream<client::Msg>>, String> {
        let mut slots = self.slots.lock().await;
        slots.retain(|s| s.alive);
        let view: Vec<(bool, usize)> = slots
            .iter()
            .map(|s| (s.alive, s.active.load(Ordering::Relaxed)))
            .collect();
        let idx = match choose_slot(&view, self.config.limits.max_channels_per_control) {
            Some(i) => i,
            None => {
                if slots.len() >= self.config.limits.max_control_connections {
                    self.set_health(PoolHealth::Degraded {
                        reason: "ssh channel pool at capacity".into(),
                    });
                    return Err("ssh channel pool at capacity".into());
                }
                let slot = self.connect_new().await?;
                slots.push(slot);
                slots.len() - 1
            }
        };
        let slot = &slots[idx];
        slot.active.fetch_add(1, Ordering::SeqCst);
        let counter = slot.active.clone();
        let handle = slot.handle.clone();
        drop(slots);

        // Guard created before the channel open so an open failure still
        // decrements the slot's active count.
        let guard = SlotGuard { counter };
        let channel = handle
            .channel_open_direct_tcpip(target_host, target_port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| {
                self.set_health(PoolHealth::Degraded {
                    reason: format!("direct-tcpip: {e}"),
                });
                format!("direct-tcpip open failed: {e}")
            })?;
        Ok(GuardedStream {
            inner: channel.into_stream(),
            _guard: guard,
        })
    }

    pub async fn active_channels(&self) -> usize {
        self.slots
            .lock()
            .await
            .iter()
            .map(|s| s.active.load(Ordering::Relaxed))
            .sum()
    }

    pub async fn control_connections(&self) -> usize {
        self.slots.lock().await.len()
    }
}

/// SSH-jump egress connector (plan §4.3 SshJumpConnector). TCP only — UDP is the
/// policy layer's decision (default BLOCK).
pub struct SshJumpConnector {
    pool: Arc<SshChannelPool>,
}

impl SshJumpConnector {
    pub fn new(pool: Arc<SshChannelPool>) -> SshJumpConnector {
        SshJumpConnector { pool }
    }
}

#[async_trait]
impl EgressConnector for SshJumpConnector {
    async fn connect_tcp(
        &self,
        target: &Endpoint,
    ) -> Result<(BoxedEgressStream, EgressMetadata), String> {
        // Prefer handing the hostname to the SSH server for remote resolution
        // (UI shows "DNS: SSH remote"); fall back to the IP (plan §4.3-4).
        let host = target.connect_host()?;
        let stream = self.pool.open_direct_tcpip(&host, target.port).await?;
        let dns = if target.is_ip_only() {
            DnsResolution::IpOnly
        } else {
            DnsResolution::SshRemote
        };
        Ok((
            Box::new(stream),
            EgressMetadata {
                kind: EgressKindLabel::SshJump,
                dns,
                upstream: Some(self.pool.jump_endpoint()),
            },
        ))
    }

    fn label(&self) -> EgressKindLabel {
        EgressKindLabel::SshJump
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::public::{Ed25519PublicKey, KeyData};

    fn key(seed: u8) -> PublicKey {
        PublicKey::new(KeyData::Ed25519(Ed25519PublicKey([seed; 32])), "test")
    }

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff_delay(0, 500, 30_000), Duration::from_millis(500));
        assert_eq!(backoff_delay(1, 500, 30_000), Duration::from_millis(1000));
        assert_eq!(backoff_delay(2, 500, 30_000), Duration::from_millis(2000));
        // Caps and never overflows for huge attempts.
        assert_eq!(backoff_delay(100, 500, 30_000), Duration::from_millis(30_000));
    }

    #[test]
    fn choose_slot_picks_least_loaded_with_capacity() {
        // slot0 full, slot1 has 2, slot2 has 1 → pick slot2.
        let view = [(true, 64), (true, 2), (true, 1)];
        assert_eq!(choose_slot(&view, 64), Some(2));
        // All at capacity → None (caller must grow the pool or degrade).
        let full = [(true, 64), (true, 64)];
        assert_eq!(choose_slot(&full, 64), None);
        // Dead slots are skipped.
        let mixed = [(false, 0), (true, 5)];
        assert_eq!(choose_slot(&mixed, 64), Some(1));
    }

    #[test]
    fn verifier_reports_unknown_then_verifies_after_trust() {
        let store = Arc::new(StdMutex::new(HostKeyStore::in_memory()));
        let v = StoreHostKeyVerifier::new(store.clone(), "jump.example", 22);
        // First use: not trusted, verdict recorded as Unknown.
        assert!(!v.check(&key(1)));
        assert!(matches!(v.last_verdict(), Some(HostKeyVerdict::Unknown { .. })));
        assert!(v.last_key().is_some());
        // Trust it, then the same key verifies.
        store.lock().unwrap().trust("jump.example", 22, key(1)).unwrap();
        assert!(v.check(&key(1)));
        assert!(v.last_verdict().unwrap().is_trusted());
    }

    #[test]
    fn verifier_flags_changed_key() {
        let store = Arc::new(StdMutex::new(HostKeyStore::in_memory()));
        store.lock().unwrap().trust("h", 22, key(1)).unwrap();
        let v = StoreHostKeyVerifier::new(store, "h", 22);
        assert!(!v.check(&key(2)));
        assert!(matches!(v.last_verdict(), Some(HostKeyVerdict::Changed { .. })));
    }

    #[test]
    fn pool_starts_healthy() {
        let store = Arc::new(StdMutex::new(HostKeyStore::in_memory()));
        let cfg = SshEgressConfig {
            host: "jump.example".into(),
            port: 22,
            username: "u".into(),
            auth: SshAuthSpec::Agent,
            limits: PoolLimits::default(),
        };
        let pool = SshChannelPool::new(cfg, store);
        assert_eq!(pool.health(), PoolHealth::Healthy);
        assert_eq!(pool.jump_endpoint(), "jump.example:22");
    }
}
