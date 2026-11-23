use std::sync::Arc;

use taomni_mail_api::{
    MimeUpload, SEND_RESPONSE, SMTP_DELIVERY_UNKNOWN, SmtpResponse,
    responses::{MailResponse, ResponseRequest},
};
use taomni_plugin_stream::routed_tcp::Route;

use super::{PluginRegistry, ResolvedMailAccount, bind_smtp, invoke_result, supports};

pub(in crate::mail) async fn send_response(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    response: MailResponse,
) -> Result<(), String> {
    let content = ResponseRequest {
        email_address: account.config.email_address.clone(),
        display_name: account.config.display_name.clone(),
        response,
        stamp: crate::mail::now_ts(),
    };
    if !supports(&registry, SEND_RESPONSE) {
        #[cfg(feature = "legacy-mail-smtp")]
        if super::use_legacy_smtp(&registry) {
            let message = tokio::task::spawn_blocking(move || {
                taomni_mail_engine::responses::prepare_response(&content)
            })
            .await
            .map_err(|error| error.to_string())??;
            return super::send_smtp(registry, account, message).await.map(drop);
        }
        return Err("Enable or update Mail in the module store to send this response".into());
    }
    let data = tokio::task::spawn_blocking(move || serde_json::to_vec(&content))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    let length = data.len() as u64;
    let (_offer, source) = Route::offer_bytes(data)
        .await
        .map_err(|error| error.to_string())?;
    let (_route, connection) = bind_smtp(account).await?;
    let request = SmtpResponse {
        connection,
        content: MimeUpload { source, length },
    };
    invoke_result::<(), _>(registry, SEND_RESPONSE, request)
        .await
        .map_err(|error| {
            format!("{SMTP_DELIVERY_UNKNOWN}: {error}. Verify delivery before resending.")
        })?
}
