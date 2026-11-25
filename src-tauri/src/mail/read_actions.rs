//! Apply bounded read-flag batches and commit each confirmed batch to the cache.
use super::*;
use crate::{plugin::PluginRegistry, state::MailDbHandle};
use std::future::Future;

use taomni_mail_api::{
    ImapFlagUpdate, imap_flag_cache::ImapFlagCacheAction, imap_mutation::UID_BATCH_SIZE,
};
#[cfg(any(test, feature = "legacy-mail-imap"))]
pub(super) use taomni_mail_engine::imap_mutations::unread_uids;
use taomni_mail_storage::cache::reconcile_cached_read;

pub(super) struct ReadFlagTransport {
    #[cfg(any(test, feature = "legacy-mail-imap"))]
    pool: Arc<MailImapPool>,
    account: Arc<ResolvedMailAccount>,
    registry: Option<Arc<PluginRegistry>>,
    publish_to_host: bool,
}

impl ReadFlagTransport {
    pub(super) fn new(
        #[cfg(any(test, feature = "legacy-mail-imap"))] pool: Arc<MailImapPool>,
        account: ResolvedMailAccount,
        registry: Option<Arc<PluginRegistry>>,
    ) -> Self {
        let registry = registry.filter(|registry| {
            module_host::sets_imap_flags(registry) && module_host::lists_imap_unread(registry)
        });
        let publish_to_host = registry
            .as_deref()
            .is_some_and(module_host::publishes_imap_flags);
        Self {
            #[cfg(any(test, feature = "legacy-mail-imap"))]
            pool,
            account: Arc::new(account),
            registry,
            publish_to_host,
        }
    }

    async fn commit_read(
        &self,
        db: MailDbHandle,
        folder: String,
        uids: Vec<u32>,
        remaining: Option<usize>,
    ) -> Result<(), String> {
        let account_id = self.account.config.session_id.clone();
        if let Some(registry) = self.registry.as_ref().filter(|_| self.publish_to_host) {
            return module_host::publish_imap_flags(
                registry.clone(),
                db,
                account_id,
                ImapFlagCacheAction::Read {
                    folder,
                    uids,
                    remaining,
                },
            )
            .await;
        }
        mail_db_task(db, account_id, move |conn, account_id| {
            let tx = conn.unchecked_transaction()?;
            reconcile_cached_read(&tx, account_id, &folder, &uids, remaining)?;
            tx.commit()
        })
        .await
    }

    async fn list_unread(&self, folder: &str) -> Result<Vec<u32>, String> {
        if let Some(registry) = &self.registry {
            return retry_host_read(|| {
                module_host::list_imap_unread(registry.clone(), &self.account, folder)
            })
            .await;
        }
        legacy_imap!({
            let folder = folder.to_owned();
            self.with_legacy(move |imap| imap.unread_uids(&folder))
                .await
        })
    }

    async fn mark_read(&self, folder: &str, uids: &[u32]) -> Result<(), String> {
        if let Some(registry) = &self.registry {
            let update = ImapFlagUpdate {
                folder: folder.to_owned(),
                uids: uids.to_vec(),
                add: vec!["\\Seen".into()],
                remove: Vec::new(),
            };
            return retry_host_read(|| {
                module_host::set_imap_flags(registry.clone(), &self.account, &update)
            })
            .await;
        }
        legacy_imap!({
            let folder = folder.to_owned();
            let uids = uids.to_vec();
            self.with_legacy(move |imap| imap.mark_read(&folder, &uids).map(|_| ()))
                .await
        })
    }

    #[cfg(any(test, feature = "legacy-mail-imap"))]
    async fn with_legacy<T: Send + 'static>(
        &self,
        run: impl FnMut(&mut ActiveImapSession) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let pool = self.pool.clone();
        let account = self.account.clone();
        let runtime = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            with_imap_session(&pool, &account, &runtime, ImapSessionOpts::default(), run)
        })
        .await
        .map_err(|error| format!("mail mark read task failed: {error}"))?
    }
}

async fn retry_host_read<T, F: Future<Output = Result<T, String>>>(
    call: impl Fn() -> F,
) -> Result<T, String> {
    match call().await {
        Err(error) if is_imap_transport_error(&error) => call().await,
        result => result,
    }
}

pub(super) async fn mark_read_cached(
    transport: ReadFlagTransport,
    db: MailDbHandle,
    folder: &str,
    uids: Vec<u32>,
    all: bool,
) -> Result<MailMarkReadResult, String> {
    let account_id = &transport.account.config.session_id;
    // Capture existing cached rows before the network operation: later arrivals
    // must not be swept into the local update when a folder operation finishes.
    let cached_folder = folder.to_owned();
    let cached_unread = mail_db_task(db.clone(), account_id.clone(), move |conn, account_id| {
        init_mail_tables(conn)?;
        if all {
            unread_cached_uids(conn, account_id, &cached_folder)
        } else {
            Ok(Vec::new())
        }
    })
    .await?;
    let mut targets = if all {
        transport.list_unread(folder).await?
    } else {
        uids
    };
    targets.retain(|uid| *uid > 0);
    targets.sort_unstable();
    targets.dedup();

    let mut marked = 0;
    for batch in targets.chunks(UID_BATCH_SIZE) {
        // Release the account gate and cache mutex between batches, and retry
        // only this idempotent STORE if the server loses a response.
        transport.mark_read(folder, batch).await.map_err(|e| {
            format!(
                "Marked {marked}/{} messages as read; {e}. Retry to finish the remaining messages.",
                targets.len()
            )
        })?;
        transport
            .commit_read(db.clone(), folder.to_owned(), batch.to_vec(), None)
            .await?;
        marked += batch.len();
    }

    let unread = if all {
        // This also corrects stale local flags for messages another client had
        // already read, and keeps the remote count when history is incomplete.
        let remaining = transport.list_unread(folder).await?;
        let remaining_count = remaining.len();
        let remaining_set: HashSet<u32> = remaining.iter().copied().collect();
        let reconciled: Vec<u32> = cached_unread
            .into_iter()
            .filter(|uid| !remaining_set.contains(uid))
            .collect();
        transport
            .commit_read(db, folder.to_owned(), reconciled, Some(remaining_count))
            .await?;
        Some(remaining_count)
    } else {
        None
    };
    Ok(MailMarkReadResult {
        folder: folder.into(),
        marked,
        unread,
    })
}
