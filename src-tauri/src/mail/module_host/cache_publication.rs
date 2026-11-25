//! Stream cache input to the signed writer and return its small commit receipt.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use taomni_mail_api::{HOST_REQUEST_TIMEOUT, imap_exchange::write_body_frame};
use taomni_plugin_stream::routed_tcp::Route;

use super::{PluginRegistry, invoke};

pub(super) async fn send<T: DeserializeOwned>(
    registry: Arc<PluginRegistry>,
    method: &'static str,
    request: Vec<u8>,
) -> Result<T, String> {
    let (_route, endpoint, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let transfer = async {
        write_body_frame(&mut peer, &request)
            .await
            .map_err(|error| error.to_string())
    };
    let (receipt, ()) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(invoke::<T, _>(registry, method, endpoint), transfer)
    })
    .await
    .map_err(|_| "Mail cache update timed out".to_owned())??;
    Ok(receipt)
}
