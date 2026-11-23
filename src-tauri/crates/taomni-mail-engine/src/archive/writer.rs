use super::{MessageObject, compress_message};
use super::{download_imap_original, progress::ScanProgress, scanner::ArchiveConnection};
use crate::{
    database::MailDatabase,
    storage::{self, query::ArchiveKey, scan},
};
use std::{fs::File, io::Read, path::Path, sync::atomic::Ordering};

pub(super) fn publish_original(
    handle: &MailDatabase,
    account: &str,
    key: &ArchiveKey,
    prepared: storage::PreparedMessage,
    job: &ScanProgress,
) -> Result<(), String> {
    let db = handle.lock().map_err(|error| error.to_string())?;
    let published = scan::publish_original(&db, account, key, prepared, || job.update(|_| {}));
    if published.as_ref().is_err_and(|error| error == scan::PAUSED) {
        job.pause.store(true, Ordering::Release);
    }
    published.map(drop)
}

pub trait OriginalEncoder {
    fn encode(
        &self,
        input: &mut dyn Read,
        size: u64,
        output: &mut File,
        progress: &ScanProgress,
    ) -> Result<MessageObject, String>;

    fn publish_imap(
        &self,
        mailbox: &ArchiveMailbox<'_>,
        target: &ArchiveKey,
        prepared: storage::PreparedMessage,
    ) -> Result<(), String> {
        mailbox.publish_prepared(target, prepared)
    }
}

pub struct LocalEncoder;

impl OriginalEncoder for LocalEncoder {
    fn encode(
        &self,
        input: &mut dyn Read,
        _: u64,
        output: &mut File,
        progress: &ScanProgress,
    ) -> Result<MessageObject, String> {
        compress_message(input, output, || progress.update(|_| {}))
    }
}

pub struct ArchiveMailbox<'a> {
    pub account: &'a str,
    pub database: &'a MailDatabase,
    pub progress: &'a ScanProgress,
    pub encoder: &'a dyn OriginalEncoder,
}

impl ArchiveMailbox<'_> {
    pub(super) fn prepare(
        &self,
        root: &Path,
        input: &mut dyn Read,
        size: u64,
    ) -> Result<storage::PreparedMessage, String> {
        storage::prepare_with(root, |output| {
            self.encoder.encode(input, size, output, self.progress)
        })
    }

    pub fn publish_prepared(
        &self,
        target: &ArchiveKey,
        prepared: storage::PreparedMessage,
    ) -> Result<(), String> {
        publish_original(self.database, self.account, target, prepared, self.progress)
    }

    pub fn download_one(
        &self,
        imap: &mut dyn ArchiveConnection,
        folder: &str,
        uid: u32,
        validity: u32,
    ) -> Result<(), String> {
        let (id, handle, job) = (self.account, self.database, self.progress);
        let root = {
            let db = handle.lock().map_err(|e| e.to_string())?;
            storage::account_root(&db, id)?
        };
        let message = ArchiveKey {
            folder: folder.into(),
            uid,
            uid_validity: validity,
        };
        download_imap_original(
            &root,
            &message,
            |offset| imap.chunk(folder, uid, offset),
            |bytes, total| {
                job.update(|status| {
                    status.phase = "downloading".into();
                    status.bytes = bytes;
                    status.total_bytes = total;
                })
            },
            || job.update(|_| {}),
            |mut raw, size| {
                job.update(|status| {
                    status.phase = "verifying".into();
                    status.bytes = size;
                    status.total_bytes = Some(size);
                })?;
                let prepared = self.prepare(&root, &mut raw, size)?;
                self.encoder.publish_imap(self, &message, prepared)
            },
        )
    }
}
