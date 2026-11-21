use taomni_mail_api::{SmtpConnection, SmtpDelivery};
use taomni_mail_engine::smtp::{check_routed_connection, send_routed_message};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::runtime::Runtime;

pub(super) fn check(
    runtime: &Runtime,
    operation: &Operation,
    request: SmtpConnection,
) -> Result<Result<(), String>, RpcError> {
    validate_connection(&request)?;
    let result = runtime.block_on(super::incoming::while_current(operation, async {
        let (stream, _) = request.route.connect().await?;
        check_routed_connection(stream, &request).await
    }))?;
    operation.check_current()?;
    Ok(result)
}

pub(super) fn send(
    runtime: &Runtime,
    operation: &Operation,
    request: SmtpDelivery,
) -> Result<Result<String, String>, RpcError> {
    validate_connection(&request.connection)?;
    let result = runtime.block_on(super::incoming::while_current(
        operation,
        send_routed_message(request),
    ))?;
    Ok(result.map(|response| format!("{response:?}")))
}

fn validate_connection(request: &SmtpConnection) -> Result<(), RpcError> {
    if request.server_name.trim().is_empty() || request.username.trim().is_empty() {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    Ok(())
}
