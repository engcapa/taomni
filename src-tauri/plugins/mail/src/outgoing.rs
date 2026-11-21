use taomni_mail_api::OutgoingTest;
use taomni_mail_engine::smtp::check_routed_connection;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::runtime::Runtime;

pub(super) fn check(
    runtime: &Runtime,
    operation: &Operation,
    request: OutgoingTest,
) -> Result<Result<(), String>, RpcError> {
    if request.server_name.trim().is_empty() || request.username.trim().is_empty() {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let result = runtime.block_on(super::incoming::while_current(operation, async {
        let (stream, _) = request.route.connect().await?;
        check_routed_connection(stream, &request).await
    }))?;
    operation.check_current()?;
    Ok(result)
}
