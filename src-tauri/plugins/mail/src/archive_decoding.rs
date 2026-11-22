use taomni_mail_api::{
    archive::ArchiveDecoding,
    imap_exchange::{read_body_frame, write_body_frame},
};
use taomni_mail_engine::{cache::cached_to_body, parse_body_message};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::runtime::Runtime;

pub(super) fn decode(
    runtime: &Runtime,
    operation: &Operation,
    request: ArchiveDecoding,
) -> Result<Result<(), String>, RpcError> {
    let (mut exchange, _) =
        match runtime.block_on(operation.while_current(request.exchange.connect()))? {
            Ok(pair) => pair,
            Err(error) => return Ok(Err(error.to_string())),
        };
    let raw = runtime
        .block_on(operation.while_current(read_body_frame(&mut exchange)))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    operation.check_current()?;
    let body = cached_to_body(
        parse_body_message(
            &request.account_id,
            &request.folder,
            request.uid,
            Some(raw.len() as u32),
            &raw,
            raw.len(),
        ),
        "archive",
    );
    operation.check_current()?;
    let result =
        serde_json::to_vec(&body).map_err(|_| RpcError::from_code(ErrorCode::InternalError))?;
    Ok(runtime
        .block_on(operation.while_current(write_body_frame(&mut exchange, &result)))?
        .map_err(|error| error.to_string()))
}
