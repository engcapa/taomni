//! Move recent-body fetches to the Mail host while keeping the current cache readable.

use std::{sync::Arc, time::Duration};

use rusqlite::{Connection, OptionalExtension, params};
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, PREFETCH_IMAP_BODIES,
    imap_exchange::{ImapExchange, PrefetchBodies, read_body_frame, read_frame, write_frame},
};
use taomni_mail_engine::{MailMessageCached, imap_transport::ImapBodyReply};
use taomni_plugin_stream::routed_tcp::Route;
use tauri::State;

use super::{PluginRegistry, ResolvedMailAccount, bind_incoming, invoke, supports};
use crate::mail::{
    MailAccountConfig, cache::cached_header, cache::upsert_message_at, resolve_config,
    save_raw_message, storage, sync, with_mail_db_async,
};
use crate::state::AppState;

pub(in crate::mail) fn prefetches_imap_bodies(registry: &PluginRegistry) -> bool {
    supports(registry, PREFETCH_IMAP_BODIES)
}

pub(in crate::mail) async fn prefetch_imap_bodies(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
    folder: String,
    mut uids: Vec<u32>,
) -> Result<(), String> {
    let cache_folder = folder.clone();
    let (uids, uid_validity) = with_mail_db_async(state, &config.session_id, move |db, account| {
        let mut pending = Vec::new();
        for uid in uids.drain(..) {
            if cached_header(db, account, &cache_folder, uid)?
                .is_some_and(|header| !header.body_cached)
                && storage::lookup(db, account, &cache_folder, uid)
                    .map_err(storage::as_sql_error)?
                    .is_none()
            {
                pending.push(uid);
            }
        }
        Ok((pending, folder_uid_validity(db, account, &cache_folder)?))
    })
    .await?;
    if uids.is_empty() {
        return Ok(());
    }

    let account = resolve_config(state, config)?;
    let request = PrefetchBodies {
        account_id: account.config.session_id.clone(),
        folder,
        uids,
        body_max_bytes: account.config.cache.body_max_bytes,
        save_original: account
            .config
            .cache
            .save_directory
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty()),
    };
    let observed_at = sync::now_ms();
    let (_mail_route, connection) = bind_incoming(&account).await?;
    let (_exchange, endpoint, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    invoke::<(), _>(
        state.plugins.clone(),
        PREFETCH_IMAP_BODIES,
        ImapExchange {
            connection,
            exchange: endpoint,
        },
    )
    .await?;

    tokio::time::timeout(HOST_REQUEST_TIMEOUT + Duration::from_secs(5), async {
        let bytes = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
        write_frame(&mut peer, &bytes)
            .await
            .map_err(|error| error.to_string())?;
        let account = Arc::new(account);
        let mut first_error = None;
        for &uid in &request.uids {
            let frame = read_body_frame(&mut peer)
                .await
                .map_err(|error| error.to_string())?;
            let reply = tokio::task::spawn_blocking(move || {
                serde_json::from_slice::<Result<ImapBodyReply, String>>(&frame)
            })
            .await
            .map_err(|error| error.to_string())?
            .map_err(|_| "Invalid Mail prefetch result")?;
            let reply = match reply {
                Ok(reply) => reply,
                Err(error) => {
                    first_error.get_or_insert(error);
                    continue;
                }
            };
            let header = &reply.message.header;
            if header.account_id != request.account_id
                || header.folder != request.folder
                || header.uid != uid
            {
                return Err("Mail module returned a different prefetched message".into());
            }
            let original = if let Some(size) = reply.original_size {
                if !request.save_original {
                    return Err("Mail module returned an unsolicited original message".into());
                }
                let bytes = read_frame(&mut peer)
                    .await
                    .map_err(|error| error.to_string())?;
                if bytes.len() != size {
                    return Err("Mail module returned an incomplete original message".into());
                }
                Some(bytes)
            } else {
                None
            };
            let applied = with_mail_db_async(state, &request.account_id, move |db, _| {
                cache_body_if_current(db, reply.message, uid_validity, observed_at)
            })
            .await?;
            if let (true, Some(original)) = (applied, original) {
                if let Err(error) =
                    save_original(account.clone(), request.folder.clone(), uid, original).await
                {
                    first_error.get_or_insert(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    })
    .await
    .map_err(|_| "Mail body prefetch timed out".to_owned())?
}

fn folder_uid_validity(
    db: &Connection,
    account: &str,
    folder: &str,
) -> rusqlite::Result<Option<u32>> {
    db.query_row(
        "SELECT uid_validity FROM mail_folders WHERE account_id = ?1 AND name = ?2",
        params![account, folder],
        |row| row.get(0),
    )
    .optional()
    .map(Option::flatten)
}

fn cache_body_if_current(
    db: &Connection,
    mut message: MailMessageCached,
    uid_validity: Option<u32>,
    observed_at: i64,
) -> rusqlite::Result<bool> {
    let header = &mut message.header;
    if folder_uid_validity(db, &header.account_id, &header.folder)? != uid_validity {
        return Ok(false);
    }
    let Some(current) = cached_header(db, &header.account_id, &header.folder, header.uid)? else {
        return Ok(false);
    };
    if current.body_cached
        || matches!((&current.message_id, &header.message_id), (Some(current), Some(fetched)) if current != fetched)
    {
        return Ok(false);
    }
    // Sync and local actions own flags. A late prefetch only fills the body.
    header.flags = current.flags;
    upsert_message_at(db, &message, Some(observed_at))?;
    Ok(true)
}

async fn save_original(
    account: Arc<ResolvedMailAccount>,
    folder: String,
    uid: u32,
    original: Vec<u8>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_raw_message(&account, &folder, uid, &original))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use taomni_mail_engine::{
        cache::{get_cached_body, init_cache_tables},
        parse_body_message,
    };

    #[test]
    fn prefetch_preserves_replaced_headers_read_flags_and_existing_bodies() {
        let db = Connection::open_in_memory().unwrap();
        init_cache_tables(&db).unwrap();
        db.execute(
            "INSERT INTO mail_folders (account_id, name, uid_validity, updated_at)
             VALUES ('qa', 'INBOX', 7, 1)",
            [],
        )
        .unwrap();
        let raw = b"From: qa@example.test\r\nSubject: Warm\r\nMessage-ID: <warm@example.test>\r\n\r\nRecently delivered";
        let mut fetched = parse_body_message("qa", "INBOX", 1, None, raw, raw.len());

        assert!(!cache_body_if_current(&db, fetched.clone(), Some(7), 1).unwrap());

        let mut header_only = fetched.clone();
        header_only.body_cached_at = None;
        header_only.body_text = None;
        header_only.body_html = None;
        header_only.header.flags = vec!["\\Seen".into()];
        upsert_message_at(&db, &header_only, None).unwrap();
        assert!(!cache_body_if_current(&db, fetched.clone(), Some(6), 1).unwrap());
        assert!(cache_body_if_current(&db, fetched.clone(), Some(7), 1).unwrap());
        fetched.body_text = Some("Superseded body".into());
        assert!(!cache_body_if_current(&db, fetched, Some(7), 1).unwrap());

        let current = cached_header(&db, "qa", "INBOX", 1).unwrap().unwrap();
        assert_eq!(current.flags, ["\\Seen"]);
        let body = get_cached_body(&db, "qa", "INBOX", 1).unwrap().unwrap();
        assert_eq!(body.text.as_deref(), Some("Recently delivered"));
    }
}
