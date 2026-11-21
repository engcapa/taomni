use std::path::Path;

use taomni_plugin_api::RpcError;
use taomni_plugin_sdk::{Operation, SnapshotExport, SnapshotProvider};
use taomni_server_process::local;

pub(super) struct Identity(local::SshIdentity);

impl Identity {
    pub(super) fn new(profile: &Path) -> Self {
        Self(local::SshIdentity::new(profile))
    }

    pub(super) fn directory(&self) -> Result<&Path, String> {
        self.0
            .directory()
            .map_err(|error| format!("Local servers SSH identity: {error}"))
    }
}

impl SnapshotProvider for Identity {
    fn freeze(&self, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()
    }

    fn export(&self, export: &mut SnapshotExport, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()?;
        if let Some(file) = self
            .0
            .open()
            .map_err(|error| super::failed(error.to_string()))?
        {
            export.file(local::HOST_KEY, file)?;
        }
        Ok(())
    }

    fn resume(&self) {}
}
