//! Hand the verified staged object to the Mail host for the final transaction.

use std::{
    path::Path,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

use taomni_mail_api::{
    archive::{PUBLISH_IMAP_ARCHIVE, PublishArchiveOriginal},
    archive_index::ArchiveKey,
    imap_exchange::{read_frame, write_frame},
};
use taomni_mail_engine::{
    archive::writer::ArchiveMailbox,
    storage::{PreparedMessage, scan::PAUSED},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::{io::AsyncReadExt, runtime::Handle};

use super::{PluginRegistry, invoke};

pub(super) fn publish(
    runtime: &Handle,
    registry: Arc<PluginRegistry>,
    mailbox: &ArchiveMailbox<'_>,
    key: &ArchiveKey,
    prepared: PreparedMessage,
) -> Result<(), String> {
    let (temporary, staged) = prepared.stage()?;
    let result = runtime.block_on(async {
        let (_route, endpoint, mut peer) =
            Route::pair().await.map_err(|error| error.to_string())?;
        let transfer = async {
            if peer.read_u8().await.map_err(|error| error.to_string())? != 1 {
                return Err("Invalid Mail archive publication request".into());
            }
            // Resolve the account's current path. The archive lease excludes
            // relocation while the host acquires its own access lease.
            let database = {
                let db = mailbox.database.lock()?;
                Path::new(db.path().ok_or("Mail storage has no disk path")?)
                    .canonicalize()
                    .map_err(|error| error.to_string())?
            };
            mailbox.progress.update(|_| {})?;
            let request = PublishArchiveOriginal {
                account_id: mailbox.account.to_owned(),
                cache_database: database,
                key: key.clone(),
                staged,
            };
            let request = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
            write_frame(&mut peer, &request)
                .await
                .map_err(|error| error.to_string())?;
            let reply = read_frame(&mut peer)
                .await
                .map_err(|error| error.to_string())?;
            serde_json::from_slice::<Result<(), String>>(&reply)
                .map_err(|_| "Invalid Mail archive publication receipt".to_owned())?
        };
        let publish = async {
            tokio::try_join!(
                invoke::<(), _>(registry, PUBLISH_IMAP_ARCHIVE, endpoint),
                transfer
            )
            .map(drop)
        };
        let pause = async {
            loop {
                mailbox.progress.update(|_| {})?;
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        };
        tokio::select! { biased; result = publish => result, error = pause => error }
    });
    drop(temporary);
    if result.as_ref().is_err_and(|error| error == PAUSED) {
        mailbox.progress.pause.store(true, Ordering::Release);
    }
    result
}
