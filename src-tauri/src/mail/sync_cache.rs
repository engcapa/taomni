//! Select the account cache writer before synchronization begins.

use taomni_mail_api::{
    imap_index::{AppliedStep, ImapIndexAction, ImapIndexRetention},
    imap_sync::{FolderStepOutcome, MailFolderSyncResult},
};
use taomni_mail_storage::cache::{MailCacheSettings, apply_folder_round, cache_sync_result};
use tauri::State;

use super::{MailFolder, MailMessageCached, module_host, sync, with_mail_db_async};
use crate::state::AppState;

pub(super) struct ImapIndexWriter<'a, 'app> {
    state: &'a State<'app, AppState>,
    account_id: &'a str,
    cache: &'a MailCacheSettings,
    publish_to_host: bool,
}

impl<'a, 'app> ImapIndexWriter<'a, 'app> {
    pub(super) fn new(
        state: &'a State<'app, AppState>,
        account_id: &'a str,
        cache: &'a MailCacheSettings,
    ) -> Self {
        Self {
            state,
            account_id,
            cache,
            publish_to_host: module_host::publishes_imap_index(&state.plugins),
        }
    }

    pub(super) async fn page(
        &self,
        folders: Vec<MailFolder>,
        messages: Vec<MailMessageCached>,
        selected: String,
        listed: bool,
    ) -> Result<(Vec<MailFolder>, Vec<MailMessageCached>), String> {
        if self.publish_to_host {
            let (_, action) = self
                .publish(
                    ImapIndexAction::Page {
                        folders,
                        messages,
                        selected,
                        listed,
                    },
                    0,
                )
                .await?;
            let ImapIndexAction::Page {
                folders, messages, ..
            } = action
            else {
                return Err("Invalid Mail header page receipt".into());
            };
            return Ok((folders, messages));
        }
        let settings = self.cache.clone();
        with_mail_db_async(self.state, self.account_id, move |db, account_id| {
            cache_sync_result(
                db, account_id, &folders, &messages, &selected, &settings, listed,
            )?;
            Ok((folders, messages))
        })
        .await
    }

    pub(super) async fn step(
        &self,
        outcome: FolderStepOutcome,
        started_ms: i64,
    ) -> Result<MailFolderSyncResult, String> {
        if self.publish_to_host {
            let (receipt, action) = self
                .publish(ImapIndexAction::Step { outcome }, started_ms)
                .await?;
            let ImapIndexAction::Step { outcome } = action else {
                return Err("Invalid Mail folder step receipt".into());
            };
            let applied = receipt.ok_or("Missing Mail folder step receipt")?;
            return Ok(sync::step_result(self.account_id, outcome, Some(applied)));
        }
        let settings = self.cache.clone();
        with_mail_db_async(self.state, self.account_id, move |db, account_id| {
            let applied = sync::apply_folder_step(db, account_id, &outcome, &settings, started_ms)?;
            Ok(sync::step_result(account_id, outcome, Some(applied)))
        })
        .await
    }

    pub(super) async fn round(
        &self,
        folder: MailFolder,
        steps: Vec<FolderStepOutcome>,
        started_ms: i64,
        error: Option<String>,
    ) -> Result<(), String> {
        if self.publish_to_host {
            self.publish(
                ImapIndexAction::Round {
                    folder,
                    steps,
                    error,
                },
                started_ms,
            )
            .await?;
            return Ok(());
        }
        let settings = self.cache.clone();
        with_mail_db_async(self.state, self.account_id, move |db, _| {
            apply_folder_round(db, &folder, &steps, &settings, started_ms, error.as_deref())
        })
        .await
    }

    pub(super) async fn record_failure(&self, folder: String, error: String) -> Result<(), String> {
        if self.publish_to_host {
            self.publish(ImapIndexAction::Failure { folder, error }, 0)
                .await?;
            return Ok(());
        }
        with_mail_db_async(self.state, self.account_id, move |db, account_id| {
            sync::record_folder_error(db, account_id, &folder, &error)
        })
        .await
    }

    async fn publish(
        &self,
        action: ImapIndexAction,
        started_ms: i64,
    ) -> Result<(Option<AppliedStep>, ImapIndexAction), String> {
        let cache = self.state.mail_db(self.account_id)?;
        let retention = ImapIndexRetention {
            header_retention_days: self.cache.header_retention_days,
            header_limit_per_folder: self.cache.header_limit_per_folder,
            body_recent_limit: self.cache.body_recent_limit,
        };
        module_host::publish_imap_index(
            self.state.plugins.clone(),
            cache,
            self.account_id.to_owned(),
            retention,
            started_ms,
            action,
        )
        .await
    }
}
