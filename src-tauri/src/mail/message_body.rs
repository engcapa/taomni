//! Read cached bodies or fetch and decode them through the signed Mail host.

use super::*;

#[tauri::command]
pub async fn mail_get_message_body(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    state: State<'_, AppState>,
) -> Result<MailMessageBody, String> {
    get_message_body(config, folder, uid, false, state).await
}

/// Warm the disk cache without transferring unused HTML/CID data into the
/// WebView or updating the reader for every prefetched message.
#[tauri::command]
pub async fn mail_prefetch_message_body(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if config.cache.enabled {
        let saved_folder = folder.clone();
        let saved = with_mail_db_async(&state, &config.session_id, move |db, account| {
            storage::lookup(db, account, &saved_folder, uid)
                .map(|entry| entry.is_some())
                .map_err(storage::as_sql_error)
        })
        .await?;
        // A complete original already supplies offline reading. Background
        // warming must not repeatedly decompress and parse its attachments.
        if saved {
            return Ok(());
        }
        get_message_body(config, folder, uid, true, state).await?;
    }
    Ok(())
}

async fn get_message_body(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    background: bool,
    state: State<'_, AppState>,
) -> Result<MailMessageBody, String> {
    if pop3::is_pop3(&config) {
        return local_cmds::get_body(&state, &config.session_id, folder.trim(), uid);
    }
    let account_id = config.session_id.clone();
    let cache_folder = folder.clone();
    let cache_enabled = config.cache.enabled;
    let (original, cached) = with_mail_db_async(&state, &account_id, move |db, account| {
        let original =
            storage::open(db, account, &cache_folder, uid).map_err(storage::as_sql_error)?;
        let cached = if original.is_none() && cache_enabled {
            get_cached_body(db, account, &cache_folder, uid)?
        } else {
            None
        };
        Ok((original, cached))
    })
    .await?;
    if let Some(original) = original {
        return decode_mail_original(move || {
            let raw = original.read()?;
            Ok(cached_to_body(
                parse_body_message(
                    &account_id,
                    &folder,
                    uid,
                    Some(raw.len() as u32),
                    &raw,
                    raw.len(),
                ),
                "archive",
            ))
        })
        .await;
    }
    if let Some(body) = cached {
        return Ok(body);
    }

    let account = resolve_config(&state, config)?;
    let cache_enabled = account.config.cache.enabled;
    let observed_at = sync::now_ms();
    // Keep the pooled background lane until body prefetch can batch requests.
    let mut message = if !background && module_host::fetches_imap_body(&state.plugins) {
        fetch_host_body(state.plugins.clone(), account, folder, uid).await?
    } else {
        fetch_legacy_body(&state, account, folder, uid, background).await?
    };

    if cache_enabled {
        message = with_mail_db_async(&state, &account_id, move |db, _| {
            upsert_message_at(db, &message, Some(observed_at))?;
            Ok(message)
        })
        .await?;
    }

    Ok(cached_to_body(message, "remote"))
}

async fn fetch_host_body(
    registry: Arc<crate::plugin::PluginRegistry>,
    account: ResolvedMailAccount,
    folder: String,
    uid: u32,
) -> Result<MailMessageCached, String> {
    let first = module_host::fetch_imap_body(registry.clone(), &account, &folder, uid).await;
    let (message, original) = if first
        .as_ref()
        .is_err_and(|error| is_imap_transport_error(error))
    {
        module_host::fetch_imap_body(registry, &account, &folder, uid).await?
    } else {
        first?
    };
    if let Some(original) = original {
        tokio::task::spawn_blocking(move || save_raw_message(&account, &folder, uid, &original))
            .await
            .map_err(|error| format!("mail original save task failed: {error}"))??;
    }
    Ok(message)
}

async fn fetch_legacy_body(
    state: &State<'_, AppState>,
    account: ResolvedMailAccount,
    folder: String,
    uid: u32,
    background: bool,
) -> Result<MailMessageCached, String> {
    let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            if background {
                ImapSessionOpts::background()
            } else {
                ImapSessionOpts::default()
            },
            |imap| imap.fetch_body(&account, &folder, uid),
        )
    })
    .await
    .map_err(|e| format!("mail body task failed: {e}"))?
}
