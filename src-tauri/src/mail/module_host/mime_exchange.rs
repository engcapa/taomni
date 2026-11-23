use std::sync::Arc;

use serde::Serialize;
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT,
    imap_exchange::{read_body_frame, write_body_frame},
};
use taomni_plugin_stream::routed_tcp::{Endpoint, Route};

use super::{PluginRegistry, invoke};

pub(super) async fn transform<P: Serialize + Send + 'static>(
    registry: Arc<PluginRegistry>,
    method: &'static str,
    raw: Vec<u8>,
    request: impl FnOnce(Endpoint) -> P,
    timeout_message: &str,
) -> Result<Vec<u8>, String> {
    let (_route, exchange, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let transfer = async move {
        write_body_frame(&mut peer, &raw)
            .await
            .map_err(|error| error.to_string())?;
        drop(raw);
        read_body_frame(&mut peer)
            .await
            .map_err(|error| error.to_string())
    };
    let (_, reply) = tokio::time::timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::try_join!(
            invoke::<(), _>(registry, method, request(exchange)),
            transfer
        )
    })
    .await
    .map_err(|_| timeout_message.to_owned())??;
    Ok(reply)
}
