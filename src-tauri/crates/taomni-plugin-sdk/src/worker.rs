use super::ActiveOperations;
use crate::{Operation, PluginHandler, client::ServiceClient};
use std::{
    io,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc,
        mpsc::{self, SyncSender},
    },
};
use taomni_plugin_api::{ErrorCode, RpcError, RpcMessage, RpcRequest, RpcResponse};

pub(super) struct Job {
    pub request: RpcRequest,
    pub operation: Arc<Operation>,
}

pub(super) fn start(
    active: ActiveOperations,
    client: Arc<ServiceClient>,
    handler: Arc<dyn PluginHandler>,
) -> io::Result<SyncSender<Job>> {
    let (jobs, receiver) = mpsc::sync_channel::<Job>(1);
    std::thread::Builder::new()
        .name("plugin-sdk-business".into())
        .spawn(move || {
            while let Ok(job) = receiver.recv() {
                let Job { request, operation } = job;
                let result = catch_unwind(AssertUnwindSafe(|| {
                    operation.check_current()?;
                    handler.invoke(&operation, &request.method, request.params)
                }))
                .unwrap_or_else(|_| {
                    Err(RpcError::new(
                        ErrorCode::InternalError,
                        "PLUGIN_OPERATION_FAILED",
                    ))
                });
                // Clear before publishing either normal or cancellation results.
                operation.clear_keys();
                let result = operation.check_current().and(result);
                active
                    .lock()
                    .expect("SDK active poisoned")
                    .remove(&request.id);
                let response = match result {
                    Ok(value) => RpcResponse::success(request.id, value),
                    Err(error) => RpcResponse::failure(Some(request.id), error),
                };
                if client.send(RpcMessage::Response(response)).is_err() {
                    return;
                }
            }
        })?;
    Ok(jobs)
}
