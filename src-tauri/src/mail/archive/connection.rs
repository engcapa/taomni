//! Give the archive scan the same operations for old and installed Mail modules.

use std::{future::Future, time::Duration};

use taomni_mail_api::{HOST_REQUEST_TIMEOUT, OPEN_IMAP_ARCHIVE};
use taomni_mail_storage::{
    MailFolder,
    archive::{ArchiveQuery, scanner::ArchiveConnection},
    imap_sync::{FolderStepOutcome, FolderSyncState, HeaderStepRequest, StepParams},
};
use tokio::runtime::Handle;

use super::lifetime::ArchiveJob;
use crate::mail::{ResolvedMailAccount, module_host::HostedImap};

#[cfg(any(test, feature = "legacy-mail-imap"))]
use crate::mail::ActiveImapSession;

#[cfg(any(test, feature = "legacy-mail-imap"))]
impl ArchiveConnection for ActiveImapSession {
    fn list(&mut self, account_id: &str) -> Result<Vec<MailFolder>, String> {
        self.list_folders(account_id)
    }

    fn headers(
        &mut self,
        account: &str,
        folder: &str,
        state: &FolderSyncState,
        step: &StepParams,
    ) -> Result<FolderStepOutcome, String> {
        let cache = taomni_mail_storage::cache::MailCacheSettings::default();
        let mut mailbox = taomni_mail_engine::imap_messages::Mailbox {
            account_id: account,
            name: folder,
            cache: &cache,
            save_original: |_, _: &[u8]| Ok(()),
        };
        use taomni_mail_engine::imap_sync::imap_sync_folder_step;
        match self {
            Self::Tls { session, .. } => imap_sync_folder_step(session, &mut mailbox, state, step),
            Self::Plain { session, .. } => {
                imap_sync_folder_step(session, &mut mailbox, state, step)
            }
        }
    }

    fn chunk(
        &mut self,
        folder: &str,
        uid: u32,
        offset: u64,
    ) -> Result<(u32, u64, Vec<u8>), String> {
        use taomni_mail_engine::archive::fetch_imap_chunk;
        match self {
            Self::Tls { session, .. } => fetch_imap_chunk(session, folder, uid, offset),
            Self::Plain { session, .. } => fetch_imap_chunk(session, folder, uid, offset),
        }
    }
}

pub(super) struct HostedConnection<'a> {
    archive: HostedImap,
    runtime: &'a Handle,
    job: &'a ArchiveJob,
}

impl<'a> HostedConnection<'a> {
    pub(super) fn open(
        registry: std::sync::Arc<crate::plugin::PluginRegistry>,
        account: &ResolvedMailAccount,
        runtime: &'a Handle,
        job: &'a ArchiveJob,
    ) -> Result<Self, String> {
        let archive = runtime.block_on(while_running(
            job,
            HostedImap::open(registry, account, OPEN_IMAP_ARCHIVE),
        ))?;
        Ok(Self {
            archive,
            runtime,
            job,
        })
    }
}

impl ArchiveConnection for HostedConnection<'_> {
    fn list(&mut self, account_id: &str) -> Result<Vec<MailFolder>, String> {
        let query = ArchiveQuery::Folders {
            account_id: account_id.into(),
        };
        self.runtime
            .block_on(while_running(self.job, self.archive.query(query)))
    }

    fn headers(
        &mut self,
        account: &str,
        folder: &str,
        state: &FolderSyncState,
        step: &StepParams,
    ) -> Result<FolderStepOutcome, String> {
        let query = ArchiveQuery::Headers(HeaderStepRequest {
            account_id: account.to_owned(),
            folder: folder.into(),
            state: state.clone(),
            mode: step.request,
            limit: step.limit,
        });
        self.runtime
            .block_on(while_running(self.job, self.archive.query(query)))
    }

    fn chunk(
        &mut self,
        folder: &str,
        uid: u32,
        offset: u64,
    ) -> Result<(u32, u64, Vec<u8>), String> {
        let query = ArchiveQuery::Chunk {
            folder: folder.into(),
            uid,
            offset,
        };
        self.runtime
            .block_on(while_running(self.job, self.archive.chunk(query)))
    }
}

async fn while_running<T>(
    job: &ArchiveJob,
    request: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let check_pause = async {
        let mut interval = tokio::time::interval(Duration::from_millis(25));
        loop {
            interval.tick().await;
            job.progress.update(|_| {})?;
        }
    };
    tokio::select! {
        result = check_pause => result,
        result = tokio::time::timeout(HOST_REQUEST_TIMEOUT + Duration::from_secs(5), request) => {
            result.map_err(|_| "Mail archive request timed out".to_string())?
        }
    }
}
