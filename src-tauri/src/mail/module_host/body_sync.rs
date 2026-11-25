//! Keep access to user-selected original destinations on the desktop.

use std::{sync::Arc, time::Duration};

use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, SYNC_IMAP_BODIES,
    imap_exchange::{
        ImapExchange,
        sync::{SyncFrame, read_sync_frame, write_save_result},
        write_frame,
    },
    imap_sync::{BodySyncOutcome, BodySyncRequest, BodySyncTask},
};
use taomni_plugin_stream::routed_tcp::Route;

use super::{PluginRegistry, ResolvedMailAccount, decode_imap_reply, invoke_with_incoming};
use crate::mail::save_raw_message;

pub(super) async fn exchange(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    task: BodySyncTask,
) -> Result<BodySyncOutcome, String> {
    let cache = &account.config.cache;
    let request = BodySyncRequest {
        task,
        recent_limit: cache.body_recent_limit,
        max_bytes: cache.body_max_bytes,
        save_original: cache
            .save_directory
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty()),
    };
    let bytes = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    let (_data_route, endpoint, mut peer) =
        Route::pair().await.map_err(|error| error.to_string())?;
    let (_, folder) = request.task.mailbox();
    let receive = async {
        write_frame(&mut peer, &bytes)
            .await
            .map_err(|error| error.to_string())?;
        let account = Arc::new(account.clone());
        loop {
            match read_sync_frame(&mut peer)
                .await
                .map_err(|error| error.to_string())?
            {
                SyncFrame::Reply(frame) => return decode_imap_reply(frame).await,
                SyncFrame::Original { uid, bytes } => {
                    if !request.save_original {
                        return Err("Mail module returned an unsolicited original message".into());
                    }
                    let account = account.clone();
                    let folder = folder.to_owned();
                    let saved = tokio::task::spawn_blocking(move || {
                        save_raw_message(&account, &folder, uid, &bytes)
                    })
                    .await
                    .map_err(|error| format!("Mail original save task failed: {error}"))?;
                    write_save_result(&mut peer, saved)
                        .await
                        .map_err(|error| error.to_string())?;
                }
            }
        }
    };
    let invoke = invoke_with_incoming::<(), _>(registry, account, SYNC_IMAP_BODIES, |connection| {
        ImapExchange {
            connection,
            exchange: endpoint,
        }
    });
    let (_, result) = tokio::time::timeout(HOST_REQUEST_TIMEOUT + Duration::from_secs(5), async {
        tokio::try_join!(invoke, receive)
    })
    .await
    .map_err(|_| "Mail module IMAP request timed out".to_owned())??;
    Ok(result)
}
