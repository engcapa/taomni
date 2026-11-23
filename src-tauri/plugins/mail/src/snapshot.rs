//! The host exports its owned cache through the SDK's authenticated barrier.

use std::io::Read;

use taomni_plugin_api::RpcError;
use taomni_plugin_sdk::{Operation, SnapshotExport, SnapshotProvider};

use super::store::{Store, open_database, open_snapshot_file, unavailable};

impl SnapshotProvider for Store {
    fn freeze(&self, operation: &Operation) -> Result<(), RpcError> {
        let activity = loop {
            operation.check_current()?;
            if let Ok(lease) = self.mutation_activity.clone().try_write_owned() {
                break lease;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        *self.mutation_snapshot.lock().map_err(|_| unavailable())? = Some(activity);
        Ok(())
    }

    fn export(
        &self,
        destination: &mut SnapshotExport,
        operation: &Operation,
    ) -> Result<(), RpcError> {
        let paths: Vec<_> = destination.allowed_paths().map(str::to_owned).collect();
        for relative in paths {
            operation.check_current()?;
            let source = self.snapshot_source(&relative)?;
            let mut file = open_snapshot_file(&source)?;
            let mut header = Vec::with_capacity(16);
            (&mut file)
                .take(16)
                .read_to_end(&mut header)
                .map_err(|_| unavailable())?;
            if !destination.is_opaque_file(&relative)
                && (header == b"SQLite format 3\0"
                    || source
                        .extension()
                        .is_some_and(|extension| extension == "db"))
            {
                destination.sqlite(&relative, &open_database(&source)?)?;
            } else {
                destination.file(&relative, file)?;
            }
        }
        Ok(())
    }

    fn resume(&self) {
        if let Ok(mut lease) = self.mutation_snapshot.lock() {
            lease.take();
        }
    }
}
