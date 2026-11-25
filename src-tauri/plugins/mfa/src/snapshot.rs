use super::store::{Store, snapshot_busy, unavailable};
use std::sync::atomic::Ordering;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{Operation, SnapshotExport, SnapshotProvider};

impl SnapshotProvider for Store {
    fn freeze(&self, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()?;
        if self.frozen.swap(true, Ordering::AcqRel) {
            return Err(snapshot_busy());
        }
        // Every business command runs on the SDK serial actor. MFA has no
        // background writers; acquiring its connection confirms the drain.
        drop(self.lock(operation)?);
        Ok(())
    }

    fn export(
        &self,
        destination: &mut SnapshotExport,
        operation: &Operation,
    ) -> Result<(), RpcError> {
        operation.check_current()?;
        if !self.frozen.load(Ordering::Acquire) {
            return Err(snapshot_busy());
        }
        let paths: Vec<_> = destination.allowed_paths().map(str::to_owned).collect();
        if paths.iter().any(|path| path != "mfa.db") {
            return Err(RpcError::from_code(ErrorCode::InvalidParams));
        }
        let database = self.lock(operation)?;
        if !paths.is_empty() {
            // The startup owner reopened an existing store. Snapshot never
            // initializes a key, creates an unused DB or requests the Vault.
            destination.sqlite("mfa.db", database.as_ref().ok_or_else(unavailable)?)?;
        }
        Ok(())
    }

    fn resume(&self) {
        self.frozen.store(false, Ordering::Release);
    }
}
