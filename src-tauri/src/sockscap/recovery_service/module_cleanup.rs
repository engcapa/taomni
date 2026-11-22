use super::teardown::{clear_capture_journal, stop_capture};
use crate::sockscap::{SocksCapRuntime, orchestrator::EnginePhase, recovery};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Weak},
};

/// Keep the capture resources still owned by the desktop in sync with the
/// signed module's lifecycle. The registry does not own the desktop runtime.
#[derive(Debug)]
pub(crate) struct ModuleCleanup {
    runtime: Weak<SocksCapRuntime>,
    journal: PathBuf,
}

impl ModuleCleanup {
    pub(crate) fn new(runtime: &Arc<SocksCapRuntime>, profile: &Path) -> Self {
        Self {
            runtime: Arc::downgrade(runtime),
            journal: recovery::journal_path(&profile.join("sockscap")),
        }
    }
}

impl crate::plugin::ModuleCleanup for ModuleCleanup {
    fn prepare_stop(&self, slug: &str) -> Result<(), String> {
        if slug != taomni_sockscap_api::SLUG {
            return Ok(());
        }
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(());
        };
        // Start and Recover may be waiting for the lifecycle guard that called
        // this hook. Leave the current activation intact if either owns it.
        let _operation = runtime.operation.try_lock().map_err(|_| {
            "SocksCap is changing capture state. Retry the module operation shortly".to_owned()
        })?;
        #[cfg(windows)]
        runtime.helper.confirm_shutdown()?;
        if !runtime.has_activation_lock() {
            if let Some(manager) = runtime.xray() {
                manager.shutdown_all_blocking();
            }
            return Ok(());
        }
        // Registry mutations run on a blocking worker. The capture teardown
        // operates on its existing handles without dispatching new host RPCs.
        tauri::async_runtime::block_on(async {
            if runtime.orch.read().await.status().phase == EnginePhase::RecoveryRequired {
                return Err("Recover the SocksCap network before changing the module".into());
            }
            stop_capture(&runtime, &self.journal, false, true).await?;
            clear_capture_journal(&runtime, &self.journal).await?;
            runtime.release_activation_lock();
            Ok(())
        })
    }
}
