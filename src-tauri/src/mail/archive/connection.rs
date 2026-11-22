//! Give the archive scan the same operations for old and installed Mail modules.

use std::{future::Future, time::Duration};

use taomni_mail_api::HOST_REQUEST_TIMEOUT;
use taomni_mail_engine::{
    MailFolder,
    archive::{ArchiveQuery, fetch_imap_chunk},
    imap_sync::{FolderStepOutcome, FolderSyncState, HeaderStepRequest, StepParams},
};
use tokio::runtime::Handle;

use super::lifetime::{ArchiveJob, update};
use crate::mail::{ActiveImapSession, ResolvedMailAccount, module_host::HostedArchive};

pub(super) trait ArchiveConnection {
    fn list(&mut self, account_id: &str) -> Result<Vec<MailFolder>, String>;
    fn headers(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
        state: &FolderSyncState,
        step: &StepParams,
    ) -> Result<FolderStepOutcome, String>;
    fn chunk(&mut self, folder: &str, uid: u32, offset: u64)
    -> Result<(u32, u64, Vec<u8>), String>;
}

impl ArchiveConnection for ActiveImapSession {
    fn list(&mut self, account_id: &str) -> Result<Vec<MailFolder>, String> {
        self.list_folders(account_id)
    }

    fn headers(
        &mut self,
        account: &ResolvedMailAccount,
        folder: &str,
        state: &FolderSyncState,
        step: &StepParams,
    ) -> Result<FolderStepOutcome, String> {
        self.sync_folder_step(account, folder, state, step)
    }

    fn chunk(
        &mut self,
        folder: &str,
        uid: u32,
        offset: u64,
    ) -> Result<(u32, u64, Vec<u8>), String> {
        match self {
            Self::Tls { session, .. } => fetch_imap_chunk(session, folder, uid, offset),
            Self::Plain { session, .. } => fetch_imap_chunk(session, folder, uid, offset),
        }
    }
}

pub(super) struct HostedConnection<'a> {
    archive: HostedArchive,
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
        let archive =
            runtime.block_on(while_running(job, HostedArchive::open(registry, account)))?;
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
        account: &ResolvedMailAccount,
        folder: &str,
        state: &FolderSyncState,
        step: &StepParams,
    ) -> Result<FolderStepOutcome, String> {
        let query = ArchiveQuery::Headers(HeaderStepRequest {
            account_id: account.config.session_id.clone(),
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
            update(job, |_| {})?;
        }
    };
    tokio::select! {
        result = check_pause => result,
        result = tokio::time::timeout(HOST_REQUEST_TIMEOUT + Duration::from_secs(5), request) => {
            result.map_err(|_| "Mail archive request timed out".to_string())?
        }
    }
}
