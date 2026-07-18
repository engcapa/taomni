//! Shared, bounded SSH `direct-tcpip` control-connection pool.
//!
//! Tunnel and Sockscap callers share this implementation. A returned stream
//! owns its channel-capacity permit for its entire lifetime, so concurrency
//! limits remain strict even when a flow is long-lived or abandoned.

use async_trait::async_trait;
use futures::future::join_all;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::hostkey::canonical_host;
use super::network::NetworkSettings;
use super::ssh::{
    KbdInteractivePrompter, SSH_AGENT_UNAVAILABLE_ERROR, SSH_AUTH_CANCELLED_ERROR,
    SSH_AUTH_REJECTED_ERROR, SSH_CREDENTIAL_ERROR, SSH_HOST_KEY_CHANGED_ERROR,
    SSH_HOST_KEY_STORE_ERROR, SSH_HOST_KEY_UNKNOWN_ERROR, SSH_MFA_REQUIRED_ERROR, SshAuth,
    SshHandler, connect_ssh_authenticated_with_prompter,
};
use crate::vault::{ERR_VAULT_LOCKED, ERR_VAULT_NOT_FOUND, VAULT_REF_PREFIX, Vault};

const MAX_CONTROL_CONNECTIONS: usize = 16;
const MAX_CHANNELS_PER_CONNECTION: usize = 4096;
const MAX_KEEPALIVE: Duration = Duration::from_secs(3600);
const MAX_CONNECT_TIMEOUT: Duration = Duration::from_secs(300);

pub trait SshChannelStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T> SshChannelStream for T where T: AsyncRead + AsyncWrite + Unpin + Send {}
pub type BoxedSshChannelStream = Box<dyn SshChannelStream>;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SshPoolError {
    #[error("invalid SSH pool configuration: {0}")]
    InvalidConfig(String),
    #[error("invalid SSH pool key: {0}")]
    InvalidKey(String),
    #[error("invalid SSH direct-tcpip target: {0}")]
    InvalidTarget(String),
    #[error("SSH pool operation timed out during {stage}")]
    Timeout { stage: &'static str },
    #[error("SSH pool operation was cancelled")]
    Cancelled,
    #[error("SSH pool is shut down")]
    Closed,
    #[error("SSH connection failed: {0}")]
    Connect(String),
    #[error("SSH direct-tcpip channel open failed: {0}")]
    ChannelOpen(String),
    #[error("SSH user action required ({code}): {message}")]
    UserActionRequired { code: String, message: String },
}

impl SshPoolError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidConfig(_) => "ssh_pool_invalid_config",
            Self::InvalidKey(_) => "ssh_pool_invalid_key",
            Self::InvalidTarget(_) => "ssh_target_invalid",
            Self::Timeout { .. } => "ssh_pool_timeout",
            Self::Cancelled => "ssh_pool_cancelled",
            Self::Closed => "ssh_pool_closed",
            Self::Connect(_) => "ssh_connect_failed",
            Self::ChannelOpen(_) => "ssh_channel_open_failed",
            Self::UserActionRequired { .. } => "ssh_user_action_required",
        }
    }

    pub fn is_user_action_required(&self) -> bool {
        matches!(self, Self::UserActionRequired { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshPoolConfig {
    pub max_control_connections: usize,
    pub max_channels_per_connection: usize,
    pub keepalive_interval: Duration,
    pub connect_timeout: Duration,
    pub idle_ttl: Duration,
    pub max_reconnect_attempts: u8,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
}

impl Default for SshPoolConfig {
    fn default() -> Self {
        Self {
            max_control_connections: 2,
            max_channels_per_connection: 128,
            keepalive_interval: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(15),
            idle_ttl: Duration::from_secs(300),
            max_reconnect_attempts: 2,
            initial_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(2),
        }
    }
}

impl SshPoolConfig {
    pub fn validate(&self) -> Result<(), SshPoolError> {
        if !(1..=MAX_CONTROL_CONNECTIONS).contains(&self.max_control_connections) {
            return Err(SshPoolError::InvalidConfig(format!(
                "max_control_connections must be between 1 and {MAX_CONTROL_CONNECTIONS}"
            )));
        }
        if !(1..=MAX_CHANNELS_PER_CONNECTION).contains(&self.max_channels_per_connection) {
            return Err(SshPoolError::InvalidConfig(format!(
                "max_channels_per_connection must be between 1 and {MAX_CHANNELS_PER_CONNECTION}"
            )));
        }
        if self.keepalive_interval < Duration::from_secs(1)
            || self.keepalive_interval > MAX_KEEPALIVE
        {
            return Err(SshPoolError::InvalidConfig(
                "keepalive_interval must be between 1 second and 1 hour".to_string(),
            ));
        }
        if self.connect_timeout.is_zero() || self.connect_timeout > MAX_CONNECT_TIMEOUT {
            return Err(SshPoolError::InvalidConfig(
                "connect_timeout must be between 1 millisecond and 5 minutes".to_string(),
            ));
        }
        if self.idle_ttl.is_zero() {
            return Err(SshPoolError::InvalidConfig(
                "idle_ttl must be greater than zero".to_string(),
            ));
        }
        if self.max_reconnect_attempts > 8 {
            return Err(SshPoolError::InvalidConfig(
                "max_reconnect_attempts must not exceed 8".to_string(),
            ));
        }
        if self.initial_backoff.is_zero()
            || self.max_backoff.is_zero()
            || self.initial_backoff > self.max_backoff
        {
            return Err(SshPoolError::InvalidConfig(
                "reconnect backoff bounds are invalid".to_string(),
            ));
        }
        self.max_control_connections
            .checked_mul(self.max_channels_per_connection)
            .ok_or_else(|| SshPoolError::InvalidConfig("channel capacity overflow".to_string()))?;
        Ok(())
    }

    fn total_channel_capacity(&self) -> usize {
        self.max_control_connections * self.max_channels_per_connection
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SshPoolKey {
    identity: String,
    host: String,
    port: u16,
    username: String,
}

impl SshPoolKey {
    pub fn new(
        identity: impl Into<String>,
        host: impl Into<String>,
        port: u16,
        username: impl Into<String>,
    ) -> Result<Self, SshPoolError> {
        let identity = identity.into().trim().to_string();
        if identity.is_empty() || identity.len() > 512 || identity.chars().any(char::is_control) {
            return Err(SshPoolError::InvalidKey(
                "identity must be non-empty, bounded, and free of control characters".to_string(),
            ));
        }
        let raw_host = host.into();
        let host = canonical_host(&raw_host, port).map_err(SshPoolError::InvalidKey)?;
        let username = username.into().trim().to_string();
        if username.is_empty() || username.len() > 256 || username.chars().any(char::is_control) {
            return Err(SshPoolError::InvalidKey(
                "username must be non-empty, bounded, and free of control characters".to_string(),
            ));
        }
        Ok(Self {
            identity,
            host,
            port,
            username,
        })
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

impl fmt::Debug for SshPoolKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshPoolKey")
            .field("identity", &self.identity)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("account_configured", &!self.username.is_empty())
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshDirectTcpipTarget {
    host: String,
    port: u16,
    originator_host: String,
    originator_port: u16,
}

impl SshDirectTcpipTarget {
    pub fn new(host: impl Into<String>, port: u16) -> Result<Self, SshPoolError> {
        Self::with_originator(host, port, "127.0.0.1", 0)
    }

    pub fn with_originator(
        host: impl Into<String>,
        port: u16,
        originator_host: impl Into<String>,
        originator_port: u16,
    ) -> Result<Self, SshPoolError> {
        let raw_host = host.into();
        let host = canonical_host(&raw_host, port).map_err(SshPoolError::InvalidTarget)?;
        let originator_host = originator_host.into();
        if originator_host.parse::<std::net::IpAddr>().is_err() {
            return Err(SshPoolError::InvalidTarget(
                "originator_host must be an IP address".to_string(),
            ));
        }
        Ok(Self {
            host,
            port,
            originator_host,
            originator_port,
        })
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

#[derive(Debug)]
pub struct ControlOpenError {
    pub message: String,
    pub connection_lost: bool,
}

enum OpenOnControlError {
    Pool(SshPoolError),
    Control(ControlOpenError),
}

#[async_trait]
pub trait SshControlConnection: Send + Sync {
    fn is_closed(&self) -> bool;

    async fn close(&self) {}

    async fn open_direct_tcpip(
        &self,
        target: &SshDirectTcpipTarget,
    ) -> Result<BoxedSshChannelStream, ControlOpenError>;
}

#[async_trait]
pub trait SshConnectionFactory: Send + Sync {
    async fn connect(
        &self,
        key: &SshPoolKey,
        keepalive_interval: Duration,
    ) -> Result<Arc<dyn SshControlConnection>, SshPoolError>;
}

pub enum SshCredentialSource {
    VaultPassword {
        vault: Arc<Vault>,
        reference: String,
    },
    TransientPassword(Zeroizing<String>),
    PrivateKey(String),
    Agent,
}

impl SshCredentialSource {
    pub fn password(vault: Arc<Vault>, value: impl Into<String>) -> Result<Self, SshPoolError> {
        let value = value.into();
        if value.is_empty() {
            return Err(SshPoolError::InvalidKey(
                "SSH password credential is empty".to_string(),
            ));
        }
        if value.starts_with(VAULT_REF_PREFIX) {
            if value.len() == VAULT_REF_PREFIX.len() {
                return Err(SshPoolError::InvalidKey(
                    "SSH Vault reference is empty".to_string(),
                ));
            }
            Ok(Self::VaultPassword {
                vault,
                reference: value,
            })
        } else {
            Ok(Self::TransientPassword(Zeroizing::new(value)))
        }
    }

    fn resolve(&self) -> Result<SshAuth, SshPoolError> {
        match self {
            Self::VaultPassword { vault, reference } => {
                let password = vault
                    .resolve(reference)
                    .map_err(classify_connection_error)?;
                password.map(SshAuth::Password).ok_or_else(|| {
                    SshPoolError::Connect("Vault reference did not resolve as a secret".to_string())
                })
            }
            Self::TransientPassword(password) => Ok(SshAuth::Password(Zeroizing::new(
                password.as_str().to_string(),
            ))),
            Self::PrivateKey(path) => Ok(SshAuth::PrivateKey(path.clone())),
            Self::Agent => Ok(SshAuth::Agent),
        }
    }
}

impl fmt::Debug for SshCredentialSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            Self::VaultPassword { .. } => "vault_password",
            Self::TransientPassword(_) => "transient_password",
            Self::PrivateKey(_) => "private_key",
            Self::Agent => "agent",
        };
        formatter
            .debug_struct("SshCredentialSource")
            .field("kind", &kind)
            .finish()
    }
}

pub struct RusshConnectionFactory {
    credentials: SshCredentialSource,
    initial_prompter: StdMutex<Option<KbdInteractivePrompter>>,
}

impl RusshConnectionFactory {
    pub fn background(credentials: SshCredentialSource) -> Self {
        Self {
            credentials,
            initial_prompter: StdMutex::new(None),
        }
    }

    pub fn with_initial_prompter(
        credentials: SshCredentialSource,
        prompter: KbdInteractivePrompter,
    ) -> Self {
        Self {
            credentials,
            initial_prompter: StdMutex::new(Some(prompter)),
        }
    }
}

impl fmt::Debug for RusshConnectionFactory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RusshConnectionFactory")
            .field("credentials", &self.credentials)
            .field(
                "has_initial_prompter",
                &mutex_has_value(&self.initial_prompter),
            )
            .finish()
    }
}

#[async_trait]
impl SshConnectionFactory for RusshConnectionFactory {
    async fn connect(
        &self,
        key: &SshPoolKey,
        keepalive_interval: Duration,
    ) -> Result<Arc<dyn SshControlConnection>, SshPoolError> {
        let auth = self.credentials.resolve()?;
        let prompter = take_mutex_value(&self.initial_prompter);
        let mut network = NetworkSettings::default();
        network.proxy_kind = "none".to_string();
        network.keep_alive = true;
        network.keep_alive_interval_secs = keepalive_interval.as_secs().max(1);
        let handle = connect_ssh_authenticated_with_prompter(
            &key.host,
            key.port,
            &key.username,
            auth,
            Some(&network),
            prompter.as_ref(),
        )
        .await
        .map_err(classify_connection_error)?;
        Ok(Arc::new(RusshControlConnection {
            handle: Arc::new(handle),
        }))
    }
}

struct RusshControlConnection {
    handle: Arc<russh::client::Handle<SshHandler>>,
}

#[async_trait]
impl SshControlConnection for RusshControlConnection {
    fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    async fn close(&self) {
        let _ = self
            .handle
            .disconnect(
                russh::Disconnect::ByApplication,
                "SSH channel pool stopped",
                "en",
            )
            .await;
    }

    async fn open_direct_tcpip(
        &self,
        target: &SshDirectTcpipTarget,
    ) -> Result<BoxedSshChannelStream, ControlOpenError> {
        self.handle
            .channel_open_direct_tcpip(
                target.host.clone(),
                target.port as u32,
                target.originator_host.clone(),
                target.originator_port as u32,
            )
            .await
            .map(|channel| Box::new(channel.into_stream()) as BoxedSshChannelStream)
            .map_err(|error| ControlOpenError {
                connection_lost: russh_connection_lost(&error),
                message: error.to_string(),
            })
    }
}

fn russh_connection_lost(error: &russh::Error) -> bool {
    matches!(
        error,
        russh::Error::Disconnect
            | russh::Error::HUP
            | russh::Error::ConnectionTimeout
            | russh::Error::KeepaliveTimeout
            | russh::Error::InactivityTimeout
            | russh::Error::SendError
            | russh::Error::RecvError
            | russh::Error::WrongChannel
            | russh::Error::IO(_)
    )
}

fn classify_connection_error(message: String) -> SshPoolError {
    let action_code = [
        SSH_HOST_KEY_UNKNOWN_ERROR,
        SSH_HOST_KEY_CHANGED_ERROR,
        SSH_HOST_KEY_STORE_ERROR,
        SSH_MFA_REQUIRED_ERROR,
        SSH_AGENT_UNAVAILABLE_ERROR,
        SSH_AUTH_REJECTED_ERROR,
        SSH_AUTH_CANCELLED_ERROR,
        SSH_CREDENTIAL_ERROR,
        ERR_VAULT_LOCKED,
        ERR_VAULT_NOT_FOUND,
    ]
    .into_iter()
    .find(|code| message.contains(code));
    if let Some(code) = action_code {
        SshPoolError::UserActionRequired {
            code: code.to_string(),
            message,
        }
    } else {
        SshPoolError::Connect(message)
    }
}

fn mutex_has_value<T>(mutex: &StdMutex<Option<T>>) -> bool {
    match mutex.lock() {
        Ok(guard) => guard.is_some(),
        Err(poisoned) => poisoned.into_inner().is_some(),
    }
}

fn take_mutex_value<T>(mutex: &StdMutex<Option<T>>) -> Option<T> {
    match mutex.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum SshPoolHealthState {
    Disconnected = 0,
    Connecting = 1,
    Healthy = 2,
    Degraded = 3,
    UserActionRequired = 4,
    Stopped = 5,
}

impl SshPoolHealthState {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Connecting,
            2 => Self::Healthy,
            3 => Self::Degraded,
            4 => Self::UserActionRequired,
            5 => Self::Stopped,
            _ => Self::Disconnected,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPoolSnapshot {
    pub state: SshPoolHealthState,
    pub active_control_connections: u64,
    pub active_channels: u64,
    pub last_handshake_rtt_ms: Option<u64>,
    pub channel_open_errors: u64,
    pub reconnects: u64,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub last_error_code: Option<String>,
    pub last_host_key_status: Option<String>,
}

#[derive(Default)]
struct MetricsDetail {
    last_error_code: Option<String>,
    last_host_key_status: Option<String>,
}

struct PoolMetrics {
    state: AtomicU8,
    active_controls: AtomicU64,
    active_channels: AtomicU64,
    handshake_rtt_ms: AtomicU64,
    has_handshake_rtt: AtomicBool,
    channel_open_errors: AtomicU64,
    reconnects: AtomicU64,
    bytes_up: AtomicU64,
    bytes_down: AtomicU64,
    detail: StdMutex<MetricsDetail>,
}

impl Default for PoolMetrics {
    fn default() -> Self {
        Self {
            state: AtomicU8::new(SshPoolHealthState::Disconnected as u8),
            active_controls: AtomicU64::new(0),
            active_channels: AtomicU64::new(0),
            handshake_rtt_ms: AtomicU64::new(0),
            has_handshake_rtt: AtomicBool::new(false),
            channel_open_errors: AtomicU64::new(0),
            reconnects: AtomicU64::new(0),
            bytes_up: AtomicU64::new(0),
            bytes_down: AtomicU64::new(0),
            detail: StdMutex::new(MetricsDetail::default()),
        }
    }
}

impl PoolMetrics {
    fn set_state(&self, state: SshPoolHealthState) {
        self.state.store(state as u8, Ordering::Release);
    }

    fn set_error(&self, error: &SshPoolError) {
        let mut detail = lock_unpoisoned(&self.detail);
        detail.last_error_code = Some(match error {
            SshPoolError::UserActionRequired { code, .. } => code.clone(),
            other => other.code().to_string(),
        });
        if let SshPoolError::UserActionRequired { code, .. } = error {
            detail.last_host_key_status = match code.as_str() {
                SSH_HOST_KEY_UNKNOWN_ERROR => Some("unknown".to_string()),
                SSH_HOST_KEY_CHANGED_ERROR => Some("changed".to_string()),
                SSH_HOST_KEY_STORE_ERROR => Some("store_error".to_string()),
                _ => detail.last_host_key_status.clone(),
            };
        }
    }

    fn mark_connected(&self, elapsed: Duration, was_reconnect: bool) {
        self.handshake_rtt_ms.store(
            elapsed.as_millis().min(u64::MAX as u128) as u64,
            Ordering::Release,
        );
        self.has_handshake_rtt.store(true, Ordering::Release);
        if was_reconnect {
            self.reconnects.fetch_add(1, Ordering::Relaxed);
        }
        let mut detail = lock_unpoisoned(&self.detail);
        detail.last_error_code = None;
        detail.last_host_key_status = Some("verified".to_string());
        self.set_state(SshPoolHealthState::Healthy);
    }

    fn snapshot(&self) -> SshPoolSnapshot {
        let detail = lock_unpoisoned(&self.detail);
        SshPoolSnapshot {
            state: SshPoolHealthState::from_u8(self.state.load(Ordering::Acquire)),
            active_control_connections: self.active_controls.load(Ordering::Acquire),
            active_channels: self.active_channels.load(Ordering::Acquire),
            last_handshake_rtt_ms: self
                .has_handshake_rtt
                .load(Ordering::Acquire)
                .then(|| self.handshake_rtt_ms.load(Ordering::Acquire)),
            channel_open_errors: self.channel_open_errors.load(Ordering::Acquire),
            reconnects: self.reconnects.load(Ordering::Acquire),
            bytes_up: self.bytes_up.load(Ordering::Acquire),
            bytes_down: self.bytes_down.load(Ordering::Acquire),
            last_error_code: detail.last_error_code.clone(),
            last_host_key_status: detail.last_host_key_status.clone(),
        }
    }
}

fn lock_unpoisoned<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

struct PoolEntry {
    controls: Mutex<Vec<Arc<PooledControl>>>,
    connect_lock: Mutex<()>,
    reconnect_pending: AtomicBool,
}

impl PoolEntry {
    fn new() -> Self {
        Self {
            controls: Mutex::new(Vec::new()),
            connect_lock: Mutex::new(()),
            reconnect_pending: AtomicBool::new(false),
        }
    }
}

struct PooledControl {
    connection: Arc<dyn SshControlConnection>,
    active_channels: AtomicUsize,
    last_used: StdMutex<Instant>,
    listed: AtomicBool,
    metrics: Arc<PoolMetrics>,
    control_permit: StdMutex<Option<OwnedSemaphorePermit>>,
}

impl PooledControl {
    fn unlist(&self) {
        if self.listed.swap(false, Ordering::AcqRel) {
            self.metrics.active_controls.fetch_sub(1, Ordering::AcqRel);
            lock_unpoisoned(&self.control_permit).take();
        }
    }
}

impl Drop for PooledControl {
    fn drop(&mut self) {
        self.unlist();
    }
}

struct ChannelReservation {
    control: Arc<PooledControl>,
    metrics: Arc<PoolMetrics>,
    _channel_permit: OwnedSemaphorePermit,
}

impl Drop for ChannelReservation {
    fn drop(&mut self) {
        self.control.active_channels.fetch_sub(1, Ordering::AcqRel);
        *lock_unpoisoned(&self.control.last_used) = Instant::now();
        self.metrics.active_channels.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct PooledSshStream {
    inner: BoxedSshChannelStream,
    reservation: ChannelReservation,
}

impl fmt::Debug for PooledSshStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PooledSshStream")
            .field("stream", &"SSH direct-tcpip channel")
            .finish()
    }
}

impl AsyncRead for PooledSshStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buffer.filled().len();
        let result = Pin::new(&mut *self.inner).poll_read(context, buffer);
        if matches!(result, Poll::Ready(Ok(()))) {
            let read = buffer.filled().len().saturating_sub(before);
            self.reservation
                .metrics
                .bytes_down
                .fetch_add(read as u64, Ordering::Relaxed);
        }
        result
    }
}

impl AsyncWrite for PooledSshStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut *self.inner).poll_write(context, buffer);
        if let Poll::Ready(Ok(written)) = result {
            self.reservation
                .metrics
                .bytes_up
                .fetch_add(written as u64, Ordering::Relaxed);
        }
        result
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.inner).poll_flush(context)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.inner).poll_shutdown(context)
    }
}

pub struct SshChannelPool {
    config: SshPoolConfig,
    entries: Mutex<HashMap<SshPoolKey, Arc<PoolEntry>>>,
    control_capacity: Arc<Semaphore>,
    channel_capacity: Arc<Semaphore>,
    metrics: Arc<PoolMetrics>,
    shutdown: CancellationToken,
    closed: AtomicBool,
}

impl fmt::Debug for SshChannelPool {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshChannelPool")
            .field("config", &self.config)
            .field("snapshot", &self.snapshot())
            .finish()
    }
}

impl SshChannelPool {
    pub fn new(config: SshPoolConfig) -> Result<Self, SshPoolError> {
        config.validate()?;
        Ok(Self {
            control_capacity: Arc::new(Semaphore::new(config.max_control_connections)),
            channel_capacity: Arc::new(Semaphore::new(config.total_channel_capacity())),
            config,
            entries: Mutex::new(HashMap::new()),
            metrics: Arc::new(PoolMetrics::default()),
            shutdown: CancellationToken::new(),
            closed: AtomicBool::new(false),
        })
    }

    pub fn snapshot(&self) -> SshPoolSnapshot {
        self.metrics.snapshot()
    }

    pub fn connect_timeout(&self) -> Duration {
        self.config.connect_timeout
    }

    pub async fn warm_up(
        &self,
        key: &SshPoolKey,
        factory: &dyn SshConnectionFactory,
        cancellation: &CancellationToken,
    ) -> Result<(), SshPoolError> {
        self.ensure_open()?;
        let deadline = tokio::time::Instant::now() + self.config.connect_timeout;
        let entry = self.entry(key).await;
        if self.has_live_control(&entry).await {
            return Ok(());
        }
        let _connect_guard = self.lock_connect(&entry, deadline, cancellation).await?;
        if self.has_live_control(&entry).await {
            return Ok(());
        }
        self.connect_control(&entry, key, factory, deadline, cancellation)
            .await?;
        Ok(())
    }

    pub async fn open_direct_tcpip(
        &self,
        key: &SshPoolKey,
        factory: &dyn SshConnectionFactory,
        target: &SshDirectTcpipTarget,
        cancellation: &CancellationToken,
    ) -> Result<PooledSshStream, SshPoolError> {
        self.ensure_open()?;
        let deadline = tokio::time::Instant::now() + self.config.connect_timeout;
        let entry = self.entry(key).await;

        for open_attempt in 0..=1 {
            let permit = self.acquire_channel(deadline, cancellation).await?;
            let reservation = self
                .reserve_control(&entry, key, factory, permit, deadline, cancellation)
                .await?;
            let open = self
                .open_on_control(&reservation.control, target, deadline, cancellation)
                .await;
            match open {
                Ok(inner) => {
                    self.metrics.set_state(SshPoolHealthState::Healthy);
                    return Ok(PooledSshStream { inner, reservation });
                }
                Err(OpenOnControlError::Pool(error)) => {
                    drop(reservation);
                    self.metrics.set_error(&error);
                    return Err(error);
                }
                Err(OpenOnControlError::Control(error)) => {
                    self.metrics
                        .channel_open_errors
                        .fetch_add(1, Ordering::Relaxed);
                    if error.connection_lost {
                        entry.reconnect_pending.store(true, Ordering::Release);
                        self.invalidate_control(&entry, &reservation.control).await;
                        self.metrics.set_state(SshPoolHealthState::Degraded);
                        let pool_error = SshPoolError::Connect(error.message);
                        self.metrics.set_error(&pool_error);
                        drop(reservation);
                        if open_attempt == 0 {
                            continue;
                        }
                        return Err(pool_error);
                    }
                    drop(reservation);
                    let pool_error = SshPoolError::ChannelOpen(error.message);
                    self.metrics.set_error(&pool_error);
                    return Err(pool_error);
                }
            }
        }
        unreachable!("bounded channel-open loop returns on every branch")
    }

    pub async fn shutdown(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.shutdown.cancel();
        let entries = {
            let mut entries = self.entries.lock().await;
            std::mem::take(&mut *entries)
        };
        let mut closing = Vec::new();
        for entry in entries.into_values() {
            let controls = {
                let mut controls = entry.controls.lock().await;
                controls.drain(..).collect::<Vec<_>>()
            };
            for control in controls {
                control.unlist();
                closing.push(control);
            }
        }
        join_all(closing.into_iter().map(|control| async move {
            let _ = tokio::time::timeout(Duration::from_secs(1), control.connection.close()).await;
        }))
        .await;
        self.metrics.set_state(SshPoolHealthState::Stopped);
    }

    fn ensure_open(&self) -> Result<(), SshPoolError> {
        if self.closed.load(Ordering::Acquire) {
            Err(SshPoolError::Closed)
        } else {
            Ok(())
        }
    }

    async fn entry(&self, key: &SshPoolKey) -> Arc<PoolEntry> {
        let mut entries = self.entries.lock().await;
        entries
            .entry(key.clone())
            .or_insert_with(|| Arc::new(PoolEntry::new()))
            .clone()
    }

    async fn has_live_control(&self, entry: &PoolEntry) -> bool {
        let mut controls = entry.controls.lock().await;
        self.prune_controls(&mut controls);
        !controls.is_empty()
    }

    async fn reserve_control(
        &self,
        entry: &Arc<PoolEntry>,
        key: &SshPoolKey,
        factory: &dyn SshConnectionFactory,
        channel_permit: OwnedSemaphorePermit,
        deadline: tokio::time::Instant,
        cancellation: &CancellationToken,
    ) -> Result<ChannelReservation, SshPoolError> {
        let channel_permit = match self.try_reserve_existing(entry, channel_permit).await {
            Ok(reservation) => return Ok(reservation),
            Err(channel_permit) => channel_permit,
        };
        let _connect_guard = self.lock_connect(entry, deadline, cancellation).await?;
        let channel_permit = match self.try_reserve_existing(entry, channel_permit).await {
            Ok(reservation) => return Ok(reservation),
            Err(channel_permit) => channel_permit,
        };
        let control = self
            .connect_control(entry, key, factory, deadline, cancellation)
            .await?;
        Ok(self.reserve_specific(control, channel_permit))
    }

    async fn try_reserve_existing(
        &self,
        entry: &PoolEntry,
        channel_permit: OwnedSemaphorePermit,
    ) -> Result<ChannelReservation, OwnedSemaphorePermit> {
        let mut controls = entry.controls.lock().await;
        self.prune_controls(&mut controls);
        let Some(control) = controls
            .iter()
            .filter(|control| {
                control.active_channels.load(Ordering::Acquire)
                    < self.config.max_channels_per_connection
            })
            .min_by_key(|control| control.active_channels.load(Ordering::Acquire))
            .cloned()
        else {
            return Err(channel_permit);
        };
        Ok(self.reserve_specific(control, channel_permit))
    }

    fn reserve_specific(
        &self,
        control: Arc<PooledControl>,
        channel_permit: OwnedSemaphorePermit,
    ) -> ChannelReservation {
        control.active_channels.fetch_add(1, Ordering::AcqRel);
        self.metrics.active_channels.fetch_add(1, Ordering::AcqRel);
        ChannelReservation {
            control,
            metrics: self.metrics.clone(),
            _channel_permit: channel_permit,
        }
    }

    fn prune_controls(&self, controls: &mut Vec<Arc<PooledControl>>) {
        let idle_ttl = self.config.idle_ttl;
        controls.retain(|control| {
            let active = control.active_channels.load(Ordering::Acquire);
            let idle = active == 0 && lock_unpoisoned(&control.last_used).elapsed() >= idle_ttl;
            let keep = !control.connection.is_closed() && !idle;
            if !keep {
                control.unlist();
            }
            keep
        });
    }

    async fn connect_control(
        &self,
        entry: &PoolEntry,
        key: &SshPoolKey,
        factory: &dyn SshConnectionFactory,
        deadline: tokio::time::Instant,
        cancellation: &CancellationToken,
    ) -> Result<Arc<PooledControl>, SshPoolError> {
        let control_permit = self.acquire_control(deadline, cancellation).await?;
        let mut backoff = self.config.initial_backoff;
        for attempt in 0..=self.config.max_reconnect_attempts {
            self.metrics.set_state(SshPoolHealthState::Connecting);
            let started = Instant::now();
            let result = tokio::select! {
                biased;
                _ = self.shutdown.cancelled() => Err(SshPoolError::Closed),
                _ = cancellation.cancelled() => Err(SshPoolError::Cancelled),
                result = tokio::time::timeout_at(
                    deadline,
                    factory.connect(key, self.config.keepalive_interval),
                ) => result.unwrap_or(Err(SshPoolError::Timeout { stage: "control connect" })),
            };
            match result {
                Ok(connection) => {
                    self.ensure_open()?;
                    let was_reconnect = entry.reconnect_pending.swap(false, Ordering::AcqRel);
                    self.metrics
                        .mark_connected(started.elapsed(), was_reconnect);
                    self.metrics.active_controls.fetch_add(1, Ordering::AcqRel);
                    let control = Arc::new(PooledControl {
                        connection,
                        active_channels: AtomicUsize::new(0),
                        last_used: StdMutex::new(Instant::now()),
                        listed: AtomicBool::new(true),
                        metrics: self.metrics.clone(),
                        control_permit: StdMutex::new(Some(control_permit)),
                    });
                    entry.controls.lock().await.push(control.clone());
                    return Ok(control);
                }
                Err(error) if error.is_user_action_required() => {
                    self.metrics.set_error(&error);
                    self.metrics
                        .set_state(SshPoolHealthState::UserActionRequired);
                    return Err(error);
                }
                Err(error) => {
                    entry.reconnect_pending.store(true, Ordering::Release);
                    self.metrics.set_error(&error);
                    self.metrics.set_state(SshPoolHealthState::Degraded);
                    if attempt == self.config.max_reconnect_attempts
                        || matches!(
                            error,
                            SshPoolError::Timeout { .. }
                                | SshPoolError::Cancelled
                                | SshPoolError::Closed
                        )
                    {
                        return Err(error);
                    }
                    self.sleep_backoff(backoff, deadline, cancellation).await?;
                    backoff = backoff.saturating_mul(2).min(self.config.max_backoff);
                }
            }
        }
        unreachable!("bounded reconnect loop returns on every branch")
    }

    async fn invalidate_control(&self, entry: &PoolEntry, failed: &Arc<PooledControl>) {
        let mut controls = entry.controls.lock().await;
        if let Some(index) = controls
            .iter()
            .position(|control| Arc::ptr_eq(control, failed))
        {
            controls.remove(index).unlist();
        }
    }

    async fn open_on_control(
        &self,
        control: &PooledControl,
        target: &SshDirectTcpipTarget,
        deadline: tokio::time::Instant,
        cancellation: &CancellationToken,
    ) -> Result<BoxedSshChannelStream, OpenOnControlError> {
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => Err(OpenOnControlError::Pool(SshPoolError::Closed)),
            _ = cancellation.cancelled() => Err(OpenOnControlError::Pool(SshPoolError::Cancelled)),
            result = tokio::time::timeout_at(deadline, control.connection.open_direct_tcpip(target)) => {
                match result {
                    Ok(Ok(stream)) => Ok(stream),
                    Ok(Err(error)) => Err(OpenOnControlError::Control(error)),
                    Err(_) => Err(OpenOnControlError::Pool(SshPoolError::Timeout { stage: "channel open" })),
                }
            },
        }
    }

    async fn lock_connect<'a>(
        &self,
        entry: &'a PoolEntry,
        deadline: tokio::time::Instant,
        cancellation: &CancellationToken,
    ) -> Result<tokio::sync::MutexGuard<'a, ()>, SshPoolError> {
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => Err(SshPoolError::Closed),
            _ = cancellation.cancelled() => Err(SshPoolError::Cancelled),
            result = tokio::time::timeout_at(deadline, entry.connect_lock.lock()) => {
                result.map_err(|_| SshPoolError::Timeout { stage: "connection coordination" })
            },
        }
    }

    async fn acquire_channel(
        &self,
        deadline: tokio::time::Instant,
        cancellation: &CancellationToken,
    ) -> Result<OwnedSemaphorePermit, SshPoolError> {
        let semaphore = self.channel_capacity.clone();
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => Err(SshPoolError::Closed),
            _ = cancellation.cancelled() => Err(SshPoolError::Cancelled),
            result = tokio::time::timeout_at(deadline, semaphore.acquire_owned()) => {
                result
                    .map_err(|_| SshPoolError::Timeout { stage: "channel capacity" })?
                    .map_err(|_| SshPoolError::Closed)
            },
        }
    }

    async fn acquire_control(
        &self,
        deadline: tokio::time::Instant,
        cancellation: &CancellationToken,
    ) -> Result<OwnedSemaphorePermit, SshPoolError> {
        let semaphore = self.control_capacity.clone();
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => Err(SshPoolError::Closed),
            _ = cancellation.cancelled() => Err(SshPoolError::Cancelled),
            result = tokio::time::timeout_at(deadline, semaphore.acquire_owned()) => {
                result
                    .map_err(|_| SshPoolError::Timeout { stage: "control capacity" })?
                    .map_err(|_| SshPoolError::Closed)
            },
        }
    }

    async fn sleep_backoff(
        &self,
        delay: Duration,
        deadline: tokio::time::Instant,
        cancellation: &CancellationToken,
    ) -> Result<(), SshPoolError> {
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => Err(SshPoolError::Closed),
            _ = cancellation.cancelled() => Err(SshPoolError::Cancelled),
            result = tokio::time::timeout_at(deadline, tokio::time::sleep(delay)) => {
                result.map_err(|_| SshPoolError::Timeout { stage: "reconnect backoff" })
            },
        }
    }
}

impl Drop for SshChannelPool {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        self.shutdown.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct MockControl {
        closed: AtomicBool,
        fail_lost_opens: AtomicUsize,
    }

    #[async_trait]
    impl SshControlConnection for MockControl {
        fn is_closed(&self) -> bool {
            self.closed.load(Ordering::Acquire)
        }

        async fn close(&self) {
            self.closed.store(true, Ordering::Release);
        }

        async fn open_direct_tcpip(
            &self,
            _target: &SshDirectTcpipTarget,
        ) -> Result<BoxedSshChannelStream, ControlOpenError> {
            if self
                .fail_lost_opens
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                self.closed.store(true, Ordering::Release);
                return Err(ControlOpenError {
                    message: "simulated disconnect".to_string(),
                    connection_lost: true,
                });
            }
            let (stream, _peer) = tokio::io::duplex(1024);
            Ok(Box::new(stream))
        }
    }

    struct MockFactory {
        connects: AtomicUsize,
        fail_connects: AtomicUsize,
        first_open_lost: AtomicBool,
        delay: Duration,
        user_action: bool,
    }

    impl MockFactory {
        fn healthy() -> Self {
            Self {
                connects: AtomicUsize::new(0),
                fail_connects: AtomicUsize::new(0),
                first_open_lost: AtomicBool::new(false),
                delay: Duration::ZERO,
                user_action: false,
            }
        }
    }

    #[derive(Default)]
    struct CloseableFactory {
        connects: AtomicUsize,
        controls: StdMutex<Vec<Arc<MockControl>>>,
    }

    #[async_trait]
    impl SshConnectionFactory for CloseableFactory {
        async fn connect(
            &self,
            _key: &SshPoolKey,
            _keepalive_interval: Duration,
        ) -> Result<Arc<dyn SshControlConnection>, SshPoolError> {
            self.connects.fetch_add(1, Ordering::AcqRel);
            let control = Arc::new(MockControl {
                closed: AtomicBool::new(false),
                fail_lost_opens: AtomicUsize::new(0),
            });
            self.controls.lock().unwrap().push(control.clone());
            Ok(control)
        }
    }

    #[async_trait]
    impl SshConnectionFactory for MockFactory {
        async fn connect(
            &self,
            _key: &SshPoolKey,
            _keepalive_interval: Duration,
        ) -> Result<Arc<dyn SshControlConnection>, SshPoolError> {
            self.connects.fetch_add(1, Ordering::AcqRel);
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            if self.user_action {
                return Err(SshPoolError::UserActionRequired {
                    code: SSH_MFA_REQUIRED_ERROR.to_string(),
                    message: "MFA required".to_string(),
                });
            }
            if self
                .fail_connects
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Err(SshPoolError::Connect(
                    "simulated transient connect failure".to_string(),
                ));
            }
            Ok(Arc::new(MockControl {
                closed: AtomicBool::new(false),
                fail_lost_opens: AtomicUsize::new(
                    self.first_open_lost.swap(false, Ordering::AcqRel) as usize,
                ),
            }))
        }
    }

    fn config(max_controls: usize, max_channels: usize) -> SshPoolConfig {
        SshPoolConfig {
            max_control_connections: max_controls,
            max_channels_per_connection: max_channels,
            connect_timeout: Duration::from_secs(2),
            idle_ttl: Duration::from_secs(60),
            initial_backoff: Duration::from_millis(1),
            max_backoff: Duration::from_millis(4),
            ..SshPoolConfig::default()
        }
    }

    fn key() -> SshPoolKey {
        SshPoolKey::new("session:test", "EXAMPLE.test.", 22, "user").unwrap()
    }

    fn target() -> SshDirectTcpipTarget {
        SshDirectTcpipTarget::new("service.internal", 443).unwrap()
    }

    #[test]
    fn validates_pool_bounds_and_redacts_key_debug() {
        let mut invalid = config(0, 1);
        assert!(invalid.validate().is_err());
        invalid.max_control_connections = 1;
        invalid.max_channels_per_connection = 0;
        assert!(invalid.validate().is_err());
        invalid.max_channels_per_connection = 1;
        invalid.keepalive_interval = Duration::from_millis(999);
        assert!(invalid.validate().is_err());

        let key = key();
        assert_eq!(key.host(), "example.test");
        let debug = format!("{key:?}");
        assert!(!debug.contains("user"));
    }

    #[tokio::test]
    async fn concurrent_warmups_deduplicate_control_connect() {
        let pool = Arc::new(SshChannelPool::new(config(1, 16)).unwrap());
        let factory = Arc::new(MockFactory {
            delay: Duration::from_millis(25),
            ..MockFactory::healthy()
        });
        let mut tasks = Vec::new();
        for _ in 0..16 {
            let pool = pool.clone();
            let factory = factory.clone();
            tasks.push(tokio::spawn(async move {
                pool.warm_up(&key(), factory.as_ref(), &CancellationToken::new())
                    .await
            }));
        }
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        assert_eq!(factory.connects.load(Ordering::Acquire), 1);
        assert_eq!(pool.snapshot().active_control_connections, 1);
    }

    #[tokio::test]
    async fn channel_permit_is_held_until_stream_drop() {
        let pool = Arc::new(SshChannelPool::new(config(1, 1)).unwrap());
        let factory = Arc::new(MockFactory::healthy());
        let first = pool
            .open_direct_tcpip(
                &key(),
                factory.as_ref(),
                &target(),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(pool.snapshot().active_channels, 1);

        let second_pool = pool.clone();
        let second_factory = factory.clone();
        let mut second = tokio::spawn(async move {
            second_pool
                .open_direct_tcpip(
                    &key(),
                    second_factory.as_ref(),
                    &target(),
                    &CancellationToken::new(),
                )
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut second)
                .await
                .is_err()
        );
        drop(first);
        let second_stream = tokio::time::timeout(Duration::from_secs(1), second)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(pool.snapshot().active_channels, 1);
        drop(second_stream);
        assert_eq!(pool.snapshot().active_channels, 0);
    }

    #[tokio::test]
    async fn expands_controls_but_never_exceeds_total_capacity() {
        let pool = Arc::new(SshChannelPool::new(config(2, 1)).unwrap());
        let factory = Arc::new(MockFactory::healthy());
        let first = pool
            .open_direct_tcpip(
                &key(),
                factory.as_ref(),
                &target(),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let second = pool
            .open_direct_tcpip(
                &key(),
                factory.as_ref(),
                &target(),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(factory.connects.load(Ordering::Acquire), 2);
        assert_eq!(pool.snapshot().active_control_connections, 2);
        assert_eq!(pool.snapshot().active_channels, 2);
        drop((first, second));
    }

    #[tokio::test]
    async fn connection_loss_reconnects_once_and_retries_channel() {
        let pool = SshChannelPool::new(config(1, 4)).unwrap();
        let factory = MockFactory {
            first_open_lost: AtomicBool::new(true),
            ..MockFactory::healthy()
        };
        let stream = pool
            .open_direct_tcpip(&key(), &factory, &target(), &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(factory.connects.load(Ordering::Acquire), 2);
        assert_eq!(pool.snapshot().reconnects, 1);
        assert_eq!(pool.snapshot().channel_open_errors, 1);
        drop(stream);
    }

    #[tokio::test]
    async fn closed_control_releases_capacity_before_old_stream_drops() {
        let pool = SshChannelPool::new(config(1, 4)).unwrap();
        let factory = CloseableFactory::default();
        let first = pool
            .open_direct_tcpip(&key(), &factory, &target(), &CancellationToken::new())
            .await
            .unwrap();
        factory.controls.lock().unwrap()[0]
            .closed
            .store(true, Ordering::Release);

        let second = pool
            .open_direct_tcpip(&key(), &factory, &target(), &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(factory.connects.load(Ordering::Acquire), 2);
        assert_eq!(pool.snapshot().active_control_connections, 1);
        assert_eq!(pool.snapshot().active_channels, 2);
        drop((first, second));
    }

    #[tokio::test]
    async fn shutdown_closes_controls_even_while_stream_is_held() {
        let pool = SshChannelPool::new(config(1, 1)).unwrap();
        let factory = CloseableFactory::default();
        let stream = pool
            .open_direct_tcpip(&key(), &factory, &target(), &CancellationToken::new())
            .await
            .unwrap();
        let control = factory.controls.lock().unwrap()[0].clone();

        pool.shutdown().await;

        assert!(control.closed.load(Ordering::Acquire));
        assert_eq!(pool.snapshot().state, SshPoolHealthState::Stopped);
        drop(stream);
    }

    #[test]
    fn deterministic_auth_and_vault_errors_require_user_action() {
        for code in [
            SSH_AUTH_REJECTED_ERROR,
            SSH_AUTH_CANCELLED_ERROR,
            SSH_CREDENTIAL_ERROR,
            ERR_VAULT_LOCKED,
            ERR_VAULT_NOT_FOUND,
        ] {
            let error = classify_connection_error(format!("{code}: test detail"));
            assert!(error.is_user_action_required(), "{code}");
        }
    }

    #[tokio::test]
    async fn user_action_required_is_not_retried() {
        let pool = SshChannelPool::new(config(1, 1)).unwrap();
        let factory = MockFactory {
            user_action: true,
            ..MockFactory::healthy()
        };
        let error = pool
            .warm_up(&key(), &factory, &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.is_user_action_required());
        assert_eq!(factory.connects.load(Ordering::Acquire), 1);
        assert_eq!(
            pool.snapshot().state,
            SshPoolHealthState::UserActionRequired
        );
    }

    #[tokio::test]
    async fn cancellation_interrupts_capacity_wait_without_leaking_permits() {
        let pool = Arc::new(SshChannelPool::new(config(1, 1)).unwrap());
        let factory = Arc::new(MockFactory::healthy());
        let first = pool
            .open_direct_tcpip(
                &key(),
                factory.as_ref(),
                &target(),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let cancellation = CancellationToken::new();
        let wait_pool = pool.clone();
        let wait_factory = factory.clone();
        let wait_cancel = cancellation.clone();
        let waiting = tokio::spawn(async move {
            wait_pool
                .open_direct_tcpip(&key(), wait_factory.as_ref(), &target(), &wait_cancel)
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancellation.cancel();
        assert_eq!(waiting.await.unwrap().unwrap_err(), SshPoolError::Cancelled);
        assert_eq!(pool.snapshot().active_channels, 1);
        drop(first);
        assert_eq!(pool.snapshot().active_channels, 0);
    }

    #[tokio::test]
    async fn transient_connect_failures_use_bounded_retry() {
        let mut cfg = config(1, 1);
        cfg.max_reconnect_attempts = 2;
        let pool = SshChannelPool::new(cfg).unwrap();
        let factory = MockFactory {
            fail_connects: AtomicUsize::new(2),
            ..MockFactory::healthy()
        };
        pool.warm_up(&key(), &factory, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(factory.connects.load(Ordering::Acquire), 3);
        assert_eq!(pool.snapshot().reconnects, 1);
    }
}
