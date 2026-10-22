use super::dav_protocol::collection_url;
use super::dav_sync::sync_collection;
use super::entries::default_book;
use super::entries::delete_entry;
use super::entries::entries;
use super::entries::export_cards;
use super::entries::import_cards;
use super::entries::save_entry;
use super::model::MailAddressBookEntry;
use super::model::MailCardDavSyncResult;
use super::storage::apply_changes;
use super::storage::load_cards;
use crate::mail::MailAccountConfig;
use crate::mail::MailAuthMode;
use crate::mail::now_ts;
use crate::mail::resolve_config;
use crate::mail::webdav::CARDDAV;
use crate::mail::webdav::DavAuth;
use crate::mail::webdav::DavClient;
use crate::mail::with_mail_db;
use crate::state::AppState;
use reqwest::Url;
use rusqlite::OptionalExtension;
use rusqlite::params;
use tauri::State;

#[tauri::command]
pub async fn mail_list_address_book(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailAddressBookEntry>, String> {
    with_mail_db(&state, &account_id, |db| entries(db, &account_id))
}

#[tauri::command]
pub async fn mail_save_address_book_entry(
    config: MailAccountConfig,
    entry: MailAddressBookEntry,
    state: State<'_, AppState>,
) -> Result<MailAddressBookEntry, String> {
    let account_id = config.session_id.clone();
    let book = default_book(&config);
    let db = state.mail_db(&account_id)?;
    let db = db.lock().map_err(|e| e.to_string())?;
    super::super::init_mail_tables(&db).map_err(|e| e.to_string())?;
    save_entry(&db, &account_id, entry, book)
}

#[tauri::command]
pub async fn mail_delete_address_book_entry(
    account_id: String,
    uid: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    with_mail_db(&state, &account_id, |db| {
        delete_entry(db, &account_id, uid.trim())
    })
}

#[tauri::command]
pub async fn mail_import_vcards(
    config: MailAccountConfig,
    source_path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let bytes =
        std::fs::read(source_path.trim()).map_err(|e| format!("failed to read vCard file: {e}"))?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("vCard file is larger than 64 MB".into());
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    let book = default_book(&config);
    let account_id = config.session_id.clone();
    let count = with_mail_db(&state, &account_id, |db| {
        import_cards(db, &account_id, &text, book)
    })?;
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
    let (text, count) = with_mail_db(&state, &account_id, |db| export_cards(db, &account_id))?;
    std::fs::write(target_path.trim(), text)
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
    let cached: Option<(Option<String>, Option<String>)> =
        with_mail_db(&state, &account_id, |db| {
            db.query_row(
                "SELECT collection_url, base_url FROM mail_carddav_state WHERE account_id = ?1",
                params![account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
        })?;
    let collection = match cached {
        Some((Some(url), Some(cached_base))) if cached_base == base => collection_url(&url)?,
        _ => {
            let start = Url::parse(&base).map_err(|e| format!("invalid CardDAV URL: {e}"))?;
            collection_url(client.discover(&start).await?.as_str())?
        }
    };
    let cards = with_mail_db(&state, &account_id, |db| load_cards(db, &account_id))?;
    let (result, changes) = sync_collection(&client, &collection, cards).await;
    let error = result.errors.first().cloned();
    with_mail_db(&state, &account_id, |db| {
        apply_changes(db, &account_id, &changes)?;
        db.execute(
            "INSERT INTO mail_carddav_state (account_id, collection_url, base_url, last_sync, last_error)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(account_id) DO UPDATE SET collection_url = excluded.collection_url,
                base_url = excluded.base_url, last_sync = excluded.last_sync, last_error = excluded.last_error",
            params![account_id, collection.as_str(), base, now_ts(), error],
        )?;
        Ok(())
    })?;
    Ok(result)
}
