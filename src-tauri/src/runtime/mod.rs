//! Shared application startup, profile ownership and graceful lifecycle.
pub(crate) mod bootstrap;
pub(crate) mod desktop;
pub(crate) mod generation;
pub(crate) mod mail_maintenance;
pub(crate) mod mfa_maintenance;
pub(crate) mod mfa_restart;
pub(crate) mod paths;
pub(crate) mod profile;
mod reaper;
pub(crate) mod shutdown;
pub(crate) mod tasks;

use crate::{plugin::PluginRegistry, state::AppState};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub(crate) struct ApplicationRuntime {
    pub(crate) tasks: tasks::RuntimeTasks,
    plugins: Arc<PluginRegistry>,
    started: AtomicBool,
    stopped: AtomicBool,
}
impl ApplicationRuntime {
    pub(crate) fn new(plugins: Arc<PluginRegistry>) -> Self {
        Self {
            tasks: Default::default(),
            plugins,
            started: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
        }
    }
    pub(crate) fn start(&self) {
        if !self.started.swap(true, Ordering::AcqRel) && !self.stopped.load(Ordering::Acquire) {
            self.plugins.start_supervision();
            self.tasks.spawn_blocking(
                "lsp-cache-prune",
                crate::lsp::LspManager::prune_stale_caches,
            );
        }
    }
    pub(crate) async fn shutdown(&self, state: &AppState) -> Result<(), String> {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        if let Err(error) = self.plugins.shutdown() {
            // No other owner has been torn down yet; keep this cleanup retryable.
            self.stopped.store(false, Ordering::Release);
            return Err(error.to_string());
        }
        state.plugin_downloads.shutdown_and_wait().await;
        self.tasks.shutdown().await;
        shutdown::stop_business_runtimes(state).await;
        Ok(())
    }
}
impl Drop for ApplicationRuntime {
    fn drop(&mut self) {
        // Setup errors and unwinding cannot leave a supervised host running.
        if let Err(error) = self.plugins.shutdown() {
            tracing::warn!(%error, "Plugin termination remained unconfirmed during runtime drop");
        }
    }
}
