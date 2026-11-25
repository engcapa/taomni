use super::book_store;
use super::dav_protocol::collection_url;
use super::dav_sync::sync_collection;
use super::model::MailCardDavSyncResult;
use crate::mail::MailAccountConfig;
use crate::mail::MailAuthMode;
use crate::mail::now_ts;
use crate::mail::resolve_config;
use crate::mail::webdav::CARDDAV;
use crate::mail::webdav::DavAuth;
use crate::mail::webdav::DavClient;
use crate::state::AppState;
use reqwest::Url;
use taomni_mail_storage::contacts::{
    MailAddressBookEntry, StoredCard,
    mailbox::{BookAction, DavState},
};
use tauri::State;

fn uses_carddav(config: &MailAccountConfig) -> bool {
    config
        .carddav
        .as_ref()
        .is_some_and(|settings| !settings.url.trim().is_empty())
}

#[tauri::command]
pub async fn mail_list_address_book(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailAddressBookEntry>, String> {
    book_store::run(&state, &account_id, BookAction::List).await
}

#[tauri::command]
pub async fn mail_save_address_book_entry(
    config: MailAccountConfig,
    entry: MailAddressBookEntry,
    state: State<'_, AppState>,
) -> Result<MailAddressBookEntry, String> {
    book_store::run(
        &state,
        &config.session_id,
        BookAction::Save {
            entry,
            carddav: uses_carddav(&config),
        },
    )
    .await
}

#[tauri::command]
pub async fn mail_delete_address_book_entry(
    account_id: String,
    uid: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    book_store::run(&state, &account_id, BookAction::Delete { uid }).await
}

#[tauri::command]
pub async fn mail_import_vcards(
    config: MailAccountConfig,
    source_path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    use tokio::io::AsyncReadExt;
    const LIMIT: u64 = 64 * 1024 * 1024;
    let file = tokio::fs::File::open(source_path.trim())
        .await
        .map_err(|e| format!("failed to read vCard file: {e}"))?;
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| format!("failed to read vCard file: {e}"))?;
    if bytes.len() as u64 > LIMIT {
        return Err("vCard file is larger than 64 MB".into());
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let count = book_store::run(
        &state,
        &config.session_id,
        BookAction::Import {
            text,
            carddav: uses_carddav(&config),
        },
    )
    .await?;
    if count == 0 {
        return Err("no contacts found in the file".into());
    }
    Ok(count)
}

#[tauri::command]
pub async fn mail_export_vcards(
    account_id: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let (text, count): (String, usize) =
        book_store::run(&state, &account_id, BookAction::Export).await?;
    tokio::fs::write(target_path.trim(), text)
        .await
        .map_err(|e| format!("failed to write vCard file: {e}"))?;
    Ok(count)
}

/// Two-way sync with the account's CardDAV address book (AC-60).
#[tauri::command]
pub async fn mail_carddav_sync(
    config: MailAccountConfig,
    state: State<'_, AppState>,
) -> Result<MailCardDavSyncResult, String> {
    let settings = config
        .carddav
        .clone()
        .filter(|c| !c.url.trim().is_empty())
        .ok_or_else(|| "no CardDAV address book is configured for this account".to_string())?;
    let account_id = config.session_id.clone();
    let account = resolve_config(&state, config)?;
    let auth = if account.auth_mode == MailAuthMode::OAuth2 {
        DavAuth::Bearer(account.imap_password.clone())
    } else {
        let user = settings
            .username
            .clone()
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(|| account.imap_username.clone());
        DavAuth::Basic(user, account.imap_password.clone())
    };
    let client = DavClient::new(CARDDAV, auth, false)?;
    let base = settings.url.trim().to_string();
    let (cached, cards): (Option<DavState>, Vec<StoredCard>) =
        book_store::run(&state, &account_id, BookAction::StartSync).await?;
    let collection = match cached {
        Some(DavState {
            collection_url: Some(url),
            base_url: Some(cached_base),
            ..
        }) if cached_base == base => collection_url(&url)?,
        _ => {
            let start = Url::parse(&base).map_err(|e| format!("invalid CardDAV URL: {e}"))?;
            collection_url(client.discover(&start).await?.as_str())?
        }
    };
    let (result, changes) = sync_collection(&client, &collection, cards.clone()).await;
    book_store::run::<()>(
        &state,
        &account_id,
        BookAction::FinishSync {
            original: cards,
            changes,
            state: DavState {
                collection_url: Some(collection.to_string()),
                base_url: Some(base),
                last_sync: Some(now_ts()),
                last_error: result.errors.first().cloned(),
            },
        },
    )
    .await?;
    Ok(result)
}
