//! Isolated production service owners for single-process behavior tests.
use super::{PluginRegistry, services::PluginCoreServices};
use crate::{
    runtime::profile::{ProfileRuntimeLeases, StartupMode},
    vault::Vault,
};
use std::sync::Arc;

pub(crate) const PASSWORD: &str = "qa-snapshot-master";

pub(crate) struct VaultHarness {
    pub(crate) registry: PluginRegistry,
    pub(crate) services: Arc<PluginCoreServices>,
    pub(crate) vault: Arc<Vault>,
    pub(crate) root: tempfile::TempDir,
}

impl VaultHarness {
    pub(crate) fn new() -> Self {
        Self::open(tempfile::tempdir().unwrap())
    }

    pub(crate) fn open(root: tempfile::TempDir) -> Self {
        let profile =
            Arc::new(ProfileRuntimeLeases::acquire(root.path(), StartupMode::Desktop).unwrap());
        let vault = Arc::new(Vault::open(&root.path().join("vault.db")).unwrap());
        let services =
            Arc::new(PluginCoreServices::new(root.path(), vault.clone(), profile).unwrap());
        let registry = PluginRegistry::with_services(root.path().join("plugins"), services.clone());
        Self {
            registry,
            services,
            vault,
            root,
        }
    }

    pub(crate) fn initialize(&self) {
        self.registry
            .initialize_vault(&self.vault, PASSWORD)
            .unwrap();
    }
}
