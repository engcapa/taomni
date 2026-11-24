//! Route all desktop uses of an account's cards to the same writer. The
//! collected-address index follows the message cache until it is migrated.
use crate::{
    mail::{local_storage, module_host},
    state::AppState,
};
use serde::de::DeserializeOwned;
use taomni_mail_api::{
    ADDRESS_BOOK, MailboxRequest,
    contact_history::{ContactHistoryAction, MailContactSuggestion},
    pop3_store::LocalMailboxAction,
};
use taomni_mail_storage::contacts::{
    handoff::{self, AddressBookImport},
    mailbox::BookAction,
};

pub(super) async fn run<T: DeserializeOwned + Send + 'static>(
    state: &AppState,
    account: &str,
    action: BookAction,
) -> Result<T, String> {
    if local_storage::is_hosted(state, account, ADDRESS_BOOK).await? {
        return hosted(state, account, action).await;
    }
    let mailbox = state.mail_db(account)?;
    let account = account.to_owned();
    tokio::task::spawn_blocking(move || {
        let db = mailbox.lock()?;
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        let result = action.execute(&tx, &account).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        serde_json::from_value(result).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn hosted<T: DeserializeOwned + Send + 'static>(
    state: &AppState,
    account: &str,
    action: BookAction,
) -> Result<T, String> {
    let core = state.core.clone();
    let registry = state.plugins.clone();
    let migrated = state.legacy.mail.migrated.clone();
    let root = state.mail_cache_root().to_owned();
    let account = account.to_owned();
    let request = MailboxRequest {
        account_id: account.clone(),
        action,
    };
    module_host::local_mailbox::<Result<T, String>, _, _>(
        state.plugins.clone(),
        ADDRESS_BOOK,
        request,
        move || {
            let (replace_staged, snapshot) = local_storage::import_source(
                &core,
                &registry,
                migrated,
                &root,
                &account,
                handoff::read_account,
            )?;
            Ok(AddressBookImport {
                replace_staged,
                snapshot: snapshot.unwrap_or_default(),
            })
        },
    )
    .await?
}

pub(in crate::mail) async fn suggestions(
    state: &tauri::State<'_, AppState>,
    account: &str,
    query: String,
    limit: u32,
) -> Result<Vec<MailContactSuggestion>, String> {
    use taomni_mail_storage::{
        cache::search_contacts,
        contacts::{merge_suggestions, search_recipient_suggestions},
    };
    if !local_storage::is_hosted(state, account, ADDRESS_BOOK).await? {
        return crate::mail::with_mail_db_async(state, account, move |db, account| {
            search_recipient_suggestions(db, account, &query, limit)
        })
        .await;
    }
    let book = hosted(
        state,
        account,
        BookAction::Suggest {
            query: query.clone(),
            limit,
        },
    )
    .await?;
    let collected = crate::mail::pop3_store::with_account_owner(
        state,
        account,
        LocalMailboxAction::SearchContacts {
            query: query.clone(),
            limit,
        },
        async {
            if module_host::manages_contact_history(&state.plugins) {
                return module_host::contact_history(
                    state.plugins.clone(),
                    state.mail_db(account)?,
                    account.to_owned(),
                    ContactHistoryAction::Search { query, limit },
                )
                .await;
            }
            crate::mail::with_mail_db_async(state, account, move |db, account| {
                search_contacts(db, account, &query, limit)
            })
            .await
        },
    )
    .await?;
    Ok(merge_suggestions(book, collected, limit))
}
