use std::sync::Arc;

use serde::{Serialize, de::DeserializeOwned};
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, MailboxRequest,
    imap_exchange::{read_body_frame, write_body_frame},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::AsyncReadExt;

use super::{PluginRegistry, invoke};

pub(in crate::mail) async fn local_mailbox<
    T: DeserializeOwned + Send + 'static,
    A: Serialize + Send + 'static,
    I: Serialize + Send + 'static,
>(
    registry: Arc<PluginRegistry>,
    method: &'static str,
    request: MailboxRequest<A>,
    source: impl FnOnce() -> Result<I, String> + Send + 'static,
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
            _ => return Err("Invalid Mail mailbox import request".to_owned()),
        }
        read_body_frame(&mut peer).await.map_err(|e| e.to_string())
    };
    let ((), reply) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(invoke::<(), _>(registry, method, endpoint), transfer)
    })
    .await
    .map_err(|_| "Mail mailbox storage timed out".to_string())??;
    tokio::task::spawn_blocking(move || serde_json::from_slice(&reply))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
