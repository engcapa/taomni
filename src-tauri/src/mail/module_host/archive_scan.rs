//! Delegate archive checkpoints and account cache clearing to verified Mail.

use std::{sync::Arc, time::Duration};

use serde::de::DeserializeOwned;
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT,
    archive_index::ArchiveKey,
    archive_scan::{ArchiveScanAction, ArchiveScanRequest, IMAP_ARCHIVE_SCAN_STATE},
    imap_exchange::{read_body_frame, write_body_frame},
    imap_sync::{FolderStepOutcome, FolderSyncState},
};
use taomni_mail_storage::archive::{progress::ScanProgress, scan_store::ArchiveScanStore};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::runtime::Handle;

use super::{PluginRegistry, invoke, supports};
use crate::{mail::cache_access::canonical_cache_database, state::MailDbHandle};

pub(in crate::mail) fn owns_archive_scan(registry: &PluginRegistry) -> bool {
    supports(registry, IMAP_ARCHIVE_SCAN_STATE)
}

pub(in crate::mail) async fn run_archive_scan<T: DeserializeOwned + Send + 'static>(
    registry: Arc<PluginRegistry>,
    cache: MailDbHandle,
    account_id: String,
    action: ArchiveScanAction,
) -> Result<T, String> {
    let request = tokio::task::spawn_blocking(move || {
        let database = canonical_cache_database(&cache)?;
        serde_json::to_vec(&ArchiveScanRequest {
            account_id,
            database,
            action,
        })
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let (_route, endpoint, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let transfer = async {
        let result = async {
            write_body_frame(&mut peer, &request).await?;
            read_body_frame(&mut peer).await
        }
        .await;
        Ok::<_, String>(result)
    };
    let ((), reply) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(
            invoke::<(), _>(registry, IMAP_ARCHIVE_SCAN_STATE, endpoint),
            transfer
        )
    })
    .await
    .map_err(|_| "Mail archive scan request timed out".to_owned())??;
    let reply = reply.map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || {
        serde_json::from_slice(&reply).map_err(|_| "Invalid Mail archive scan response".to_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(in crate::mail) struct HostedArchiveScan<'a> {
    pub registry: &'a Arc<PluginRegistry>,
    pub cache: &'a MailDbHandle,
    pub runtime: &'a Handle,
    pub progress: &'a ScanProgress,
}

impl HostedArchiveScan<'_> {
    fn run<T: DeserializeOwned + Send + 'static>(
        &self,
        account: &str,
        action: ArchiveScanAction,
    ) -> Result<T, String> {
        self.runtime.block_on(async {
            let pause = async {
                loop {
                    self.progress.update(|_| {})?;
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            };
            tokio::select! {
                biased;
                error = pause => error,
                result = run_archive_scan(
                    self.registry.clone(), self.cache.clone(), account.to_owned(), action,
                ) => result,
            }
        })
    }
}

impl ArchiveScanStore for HostedArchiveScan<'_> {
    fn folder_state(&self, account: &str, folder: &str) -> Result<FolderSyncState, String> {
        self.run(
            account,
            ArchiveScanAction::FolderState {
                folder: folder.into(),
            },
        )
    }

    fn commit_headers(
        &self,
        account: &str,
        outcome: FolderStepOutcome,
        body_recent_limit: u32,
        started_at_ms: i64,
    ) -> Result<u32, String> {
        self.run(
            account,
            ArchiveScanAction::CommitHeaders {
                outcome: Box::new(outcome),
                body_recent_limit,
                started_at_ms,
            },
        )
    }

    fn pending(&self, account: &str, folder: &str) -> Result<(u32, Vec<u32>), String> {
        self.run(
            account,
            ArchiveScanAction::Pending {
                folder: folder.into(),
            },
        )
    }

    fn skip(&self, account: &str, key: &ArchiveKey) -> Result<(), String> {
        self.run(account, ArchiveScanAction::Skip { key: key.clone() })
    }
}
