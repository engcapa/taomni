//! Move recent-body fetches to the Mail host while keeping the current cache readable.

use std::{sync::Arc, time::Duration};

use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, PREFETCH_IMAP_BODIES,
    body_cache::ImapBodyCacheSource,
    imap_exchange::{
        ImapBodyReply, ImapExchange, PrefetchBodies, read_body_frame, read_frame, write_frame,
    },
};
use taomni_mail_engine::cache::{cache_body_if_current, pending_bodies};
use taomni_plugin_stream::routed_tcp::Route;
use tauri::State;

use super::{
    PluginRegistry, ResolvedMailAccount, bind_incoming, invoke, publish_body_cache,
    publishes_body_cache, supports,
};
use crate::mail::{MailAccountConfig, resolve_config, save_raw_message, sync, with_mail_db_async};
use crate::state::AppState;

pub(in crate::mail) fn prefetches_imap_bodies(registry: &PluginRegistry) -> bool {
    supports(registry, PREFETCH_IMAP_BODIES)
}

pub(in crate::mail) async fn prefetch_imap_bodies(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
    folder: String,
    uids: Vec<u32>,
) -> Result<(), String> {
    let cache_folder = folder.clone();
    let (uids, uid_validity) = with_mail_db_async(state, &config.session_id, move |db, account| {
        pending_bodies(db, account, &cache_folder, uids)
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
    let publish_to_host = publishes_body_cache(&state.plugins);
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
            let applied = if publish_to_host {
                publish_body_cache(
                    state.plugins.clone(),
                    state.mail_db(&request.account_id)?,
                    request.account_id.clone(),
                    reply.message,
                    observed_at,
                    ImapBodyCacheSource::Prefetched { uid_validity },
                )
                .await?
                .0
            } else {
                with_mail_db_async(state, &request.account_id, move |db, _| {
                    cache_body_if_current(db, reply.message, uid_validity, observed_at)
                })
                .await?
            };
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
