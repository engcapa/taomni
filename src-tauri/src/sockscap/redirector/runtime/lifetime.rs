use super::bridge::SocketCleanup;
use super::bridge::bind_private_listener;
use super::bridge::launch_bridge;
use super::bridge::random_socket_path;
use super::capture_loop::prepare_file_descriptor_budget;
use super::capture_loop::relay_flow_capacity;
use super::capture_loop::run_capture;
use super::limits::CAPTURE_STOP_TIMEOUT;
use super::telemetry::RedirectorTelemetrySnapshot;
use super::telemetry::RuntimeTelemetry;
use super::telemetry::now_unix;
use crate::sockscap::config::SocksCapConfig;
use crate::sockscap::paths;
use crate::sockscap::redirector::REDIRECTOR_APP_PATH;
use crate::sockscap::redirector::installed_executable_path;
use crate::sockscap::redirector::scope::ScopeSnapshot;
use crate::sockscap::relay::RelayContext;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use tokio::sync::RwLock;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// A running Redirector capture session. Stop is explicit because it must send
/// a nonmatching configuration before the control channel is closed.
pub struct RedirectorCaptureHandle {
    pub(super) stop_tx: Option<oneshot::Sender<()>>,
    pub(super) task: JoinHandle<Result<(), String>>,
    pub(super) telemetry: Arc<RuntimeTelemetry>,
}

/// A failed Start distinguishes errors that happened before any business scope
/// could be written from errors after the Apply frame may have reached the
/// Provider. Only the latter requires durable network recovery.
#[derive(Debug)]
pub struct RedirectorStartError {
    pub(super) message: String,
    pub(super) scope_may_be_active: bool,
}

impl RedirectorStartError {
    pub(super) fn before_scope(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            scope_may_be_active: false,
        }
    }

    pub(super) fn after_apply(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            scope_may_be_active: true,
        }
    }

    pub fn recovery_required(&self) -> bool {
        self.scope_may_be_active
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for RedirectorStartError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl From<String> for RedirectorStartError {
    fn from(message: String) -> Self {
        Self::before_scope(message)
    }
}

impl RedirectorCaptureHandle {
    pub fn telemetry(&self) -> RedirectorTelemetrySnapshot {
        self.telemetry.snapshot()
    }

    pub async fn stop(mut self) -> Result<(), String> {
        if let Some(stop) = self.stop_tx.take() {
            let _ = stop.send(());
        }
        let mut task = self.task;
        match tokio::time::timeout(CAPTURE_STOP_TIMEOUT, &mut task).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => Err(format!("Redirector bridge task failed: {error}")),
            Err(_) => {
                task.abort();
                let _ = task.await;
                Err(format!(
                    "Redirector bridge did not disable capture within {}s",
                    CAPTURE_STOP_TIMEOUT.as_secs()
                ))
            }
        }
    }
}

pub async fn start(
    app: &tauri::AppHandle,
    config: &SocksCapConfig,
    ctx: Arc<RwLock<RelayContext>>,
    session_id: &str,
) -> Result<RedirectorCaptureHandle, RedirectorStartError> {
    preflight(config)?;
    let file_descriptor_limit = prepare_file_descriptor_budget()?;
    let flow_capacity = relay_flow_capacity(file_descriptor_limit);

    let executable = installed_executable_path();
    let mut exclusions = vec![
        std::env::current_exe().map_err(|error| format!("resolve Taomni executable: {error}"))?,
        PathBuf::from(REDIRECTOR_APP_PATH),
    ];
    if let Some(xray) = paths::resolve_xray_exe(app) {
        exclusions.push(xray);
    }
    let scope = Arc::new(ScopeSnapshot::compile(config, exclusions)?);

    let flow_socket_path = random_socket_path("flow");
    let provider_socket_path = random_socket_path("provider");
    let listener = bind_private_listener(&flow_socket_path)?;
    let cleanup = SocketCleanup(flow_socket_path.clone());
    let bridge = launch_bridge(
        &executable,
        &provider_socket_path,
        &flow_socket_path,
        scope.actions(),
        session_id,
    )
    .await?;
    let telemetry = Arc::new(RuntimeTelemetry {
        session_id: session_id.to_string(),
        scope_hash: scope.scope_hash(),
        bridge_pid: bridge.child.id().unwrap_or_default(),
        provider_pid: bridge.provider_pid,
        bridge_healthy: AtomicBool::new(true),
        started_at: now_unix(),
        last_heartbeat_at: AtomicU64::new(now_unix()),
        last_error: Mutex::new(None),
        file_descriptor_limit,
        flow_capacity,
    });

    tracing::info!(
        actions = scope.actions().len(),
        block_quic = config.block_quic,
        provider_pid = bridge.provider_pid,
        provider_socket = %provider_socket_path.display(),
        flow_socket = %flow_socket_path.display(),
        file_descriptor_limit,
        flow_capacity,
        "sockscap: isolated Redirector bridge active"
    );

    let (stop_tx, stop_rx) = oneshot::channel();
    let block_quic = config.block_quic;
    let task_telemetry = Arc::clone(&telemetry);
    let task = tokio::spawn(async move {
        let result = run_capture(
            listener,
            bridge,
            scope,
            block_quic,
            flow_capacity,
            ctx,
            stop_rx,
            cleanup,
            Arc::clone(&task_telemetry),
        )
        .await;
        if let Err(error) = &result {
            task_telemetry.failed(error.clone());
        }
        result
    });

    Ok(RedirectorCaptureHandle {
        stop_tx: Some(stop_tx),
        task,
        telemetry,
    })
}

/// Validate all fail-fast gates before building upstream pools/sidecars.
pub fn preflight(config: &SocksCapConfig) -> Result<(), String> {
    let _ = config;
    super::super::verify_installed()
        .map_err(|error| format!("{error}; no system-proxy fallback is available"))?;
    match super::super::installer::system_extension_state() {
        super::super::installer::RedirectorSystemExtensionState::WaitingForUser => {
            return Err(
                "Mitmproxy Redirector System Extension approval is pending in System Settings. Approve it first, then retry Start or Recover."
                    .into(),
            );
        }
        super::super::installer::RedirectorSystemExtensionState::Enabled
        | super::super::installer::RedirectorSystemExtensionState::NotRegistered
        | super::super::installer::RedirectorSystemExtensionState::Other
        | super::super::installer::RedirectorSystemExtensionState::Unavailable => {}
    }
    prepare_file_descriptor_budget()?;
    Ok(())
}
