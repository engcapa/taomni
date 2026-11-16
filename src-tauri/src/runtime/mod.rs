//! Shared application startup, profile ownership and graceful lifecycle.
pub(crate) mod bootstrap;
pub(crate) mod desktop;
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
        }
    }
    pub(crate) async fn shutdown(&self, state: &AppState) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        self.plugins.shutdown();
        self.tasks.shutdown().await;
        shutdown::stop_business_runtimes(state).await;
    }
}
impl Drop for ApplicationRuntime {
    fn drop(&mut self) {
        // Setup errors and unwinding cannot leave a supervised host running.
        self.plugins.shutdown();
    }
}
