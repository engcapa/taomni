use super::model::*;
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct TransferContext {
    pub cancel: CancellationToken,
    pub report: Arc<dyn Fn(&str, u64, Option<u64>) + Send + Sync>,
}
impl TransferContext {
    pub fn check(&self) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            Err("BACKUP_CANCELLED".into())
        } else {
            Ok(())
        }
    }
    pub fn progress(&self, phase: &str, bytes: u64, total: Option<u64>) {
        (self.report)(phase, bytes, total);
    }
}

#[async_trait::async_trait]
pub trait DestinationProvider: Send + Sync {
    fn capabilities(&self) -> ProviderCapabilities;
    async fn list(&self, ctx: &TransferContext) -> Result<Vec<RemoteBackup>, String>;
    async fn upload(
        &self,
        artifact: &Artifact,
        device: &DeviceIdentity,
        checkpoint: &Path,
        ctx: &TransferContext,
    ) -> Result<Receipt, String>;
    async fn download(
        &self,
        remote: &RemoteBackup,
        path: &Path,
        ctx: &TransferContext,
    ) -> Result<(), String>;
}

/// Recognized provider kinds remain explicitly unavailable until their adapters ship.
pub fn require_implemented(kind: ProviderKind) -> Result<(), String> {
    match kind {
        ProviderKind::Local | ProviderKind::Feishu => Ok(()),
        _ => Err("PROVIDER_NOT_IMPLEMENTED".into()),
    }
}
