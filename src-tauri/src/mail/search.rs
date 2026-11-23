//! Desktop search commands for the account cache and the authorized IMAP route.

#[cfg(any(test, feature = "legacy-mail-imap"))]
use std::sync::Arc;

use taomni_mail_api::{message::MailMessageHeader, search::ImapSearchRequest};
use taomni_mail_engine::search::search_cached_messages;
#[cfg(any(test, feature = "legacy-mail-imap"))]
use taomni_mail_engine::search::search_imap_messages;
use tauri::State;

pub use taomni_mail_api::search::{MailSearchField, MailSearchQuery};

#[cfg(any(test, feature = "legacy-mail-imap"))]
use super::{ActiveImapSession, ImapSessionOpts, with_imap_session};
use super::{MailAccountConfig, module_host, resolve_config, with_mail_db_async};
use crate::state::AppState;

/// Search the local index (headers of every cached message, bodies that are
/// cached). Returns newest first.
#[tauri::command]
pub async fn mail_search_messages(
    account_id: String,
    query: MailSearchQuery,
    state: State<'_, AppState>,
) -> Result<Vec<MailMessageHeader>, String> {
    with_mail_db_async(&state, &account_id, move |db, account_id| {
        search_cached_messages(db, account_id, &query)
    })
    .await
}

/// Search one folder on the server (finds mail whose body is not cached).
/// Results are not written to the cache (the cached span stays contiguous).
#[tauri::command]
pub async fn mail_search_server(
    config: MailAccountConfig,
    folder: String,
    query: MailSearchQuery,
    state: State<'_, AppState>,
) -> Result<Vec<MailMessageHeader>, String> {
    if super::pop3::is_pop3(&config) {
        // Local mailbox: the "server" is the local store.
        let local = MailSearchQuery {
            folder: Some(folder),
            ..query
        };
        return with_mail_db_async(&state, &config.session_id, move |db, account_id| {
            search_cached_messages(db, account_id, &local)
        })
        .await;
    }
    let account = resolve_config(&state, config)?;
    let request = ImapSearchRequest {
        account_id: account.config.session_id.clone(),
        folder,
        query,
    };
    if module_host::searches_imap(&state.plugins) {
        return module_host::search_imap(state.plugins.clone(), &account, &request).await;
    }
    legacy_imap!({
        let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
        let handle = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            with_imap_session(
                &pool,
                &account,
                &handle,
                ImapSessionOpts::default(),
                |imap| match imap {
                    ActiveImapSession::Tls { session, .. } => {
                        search_imap_messages(session, &request)
                    }
                    ActiveImapSession::Plain { session, .. } => {
                        search_imap_messages(session, &request)
                    }
                },
            )
        })
        .await
        .map_err(|e| format!("mail search task failed: {e}"))?
    })
}
