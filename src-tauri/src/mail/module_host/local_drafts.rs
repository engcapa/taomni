use std::sync::Arc;

use serde::de::DeserializeOwned;
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, LOCAL_DRAFTS,
    imap_exchange::{read_body_frame, write_body_frame},
};
use taomni_mail_engine::{draft_import::DraftImport, drafts::DraftRequest};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::AsyncReadExt;

use super::{PluginRegistry, invoke};

pub(in crate::mail) async fn local_drafts<T: DeserializeOwned + Send + 'static>(
    registry: Arc<PluginRegistry>,
    request: DraftRequest,
    source: impl FnOnce() -> Result<DraftImport, String> + Send + 'static,
) -> Result<T, String> {
    let bytes = tokio::task::spawn_blocking(move || serde_json::to_vec(&request))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let (_route, endpoint, mut peer) = Route::pair().await.map_err(|e| e.to_string())?;
    let transfer = async {
        write_body_frame(&mut peer, &bytes)
            .await
            .map_err(|e| e.to_string())?;
        match peer.read_u8().await.map_err(|e| e.to_string())? {
            0 => (),
            1 => {
                let import = tokio::task::spawn_blocking(move || {
                    serde_json::to_vec(&source()?).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())??;
                write_body_frame(&mut peer, &import)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            _ => return Err("Invalid Mail draft import request".to_owned()),
        }
        read_body_frame(&mut peer).await.map_err(|e| e.to_string())
    };
    let ((), reply) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(invoke::<(), _>(registry, LOCAL_DRAFTS, endpoint), transfer)
    })
    .await
    .map_err(|_| "Mail draft storage timed out".to_string())??;
    tokio::task::spawn_blocking(move || serde_json::from_slice(&reply))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
