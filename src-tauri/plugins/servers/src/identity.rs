use std::path::Path;

use taomni_plugin_api::RpcError;
use taomni_plugin_sdk::{Operation, SnapshotExport, SnapshotProvider};
use taomni_server_process::local;

pub(super) struct Data {
    pub(super) settings: local::SettingsFile,
    identity: local::SshIdentity,
}

impl Data {
    pub(super) fn new(profile: &Path) -> Self {
        Self {
            settings: local::SettingsFile::new(profile),
            identity: local::SshIdentity::new(profile),
        }
    }

    pub(super) fn directory(&self) -> Result<&Path, String> {
        self.identity
            .directory()
            .map_err(|error| format!("Local servers SSH identity: {error}"))
    }
}

impl SnapshotProvider for Data {
    fn freeze(&self, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()
    }

    fn export(&self, export: &mut SnapshotExport, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()?;
        if let Some(file) = self
            .identity
            .open()
            .map_err(|error| super::failed(error.to_string()))?
        {
            export.file(local::HOST_KEY, file)?;
        }
        if let Some(file) = self
            .settings
            .open()
            .map_err(|error| super::failed(error.to_string()))?
        {
            export.file(local::CONFIG_FILENAME, file)?;
        }
        Ok(())
    }

    fn resume(&self) {}
}
