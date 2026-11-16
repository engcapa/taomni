use super::ActiveOperations;
use crate::{HostStorage, Operation, PluginHandler, client::ServiceClient};
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

struct WorkerResources {
    // Handler-owned stores close before its final profile/data leases drop.
    handler: Arc<dyn PluginHandler>,
    _storage: Option<Arc<HostStorage>>,
}

pub(super) fn start(
    active: ActiveOperations,
    client: Arc<ServiceClient>,
    handler: Arc<dyn PluginHandler>,
    storage: Option<Arc<HostStorage>>,
) -> io::Result<SyncSender<Job>> {
    let (jobs, receiver) = mpsc::sync_channel::<Job>(1);
    let resources = WorkerResources {
        handler,
        _storage: storage,
    };
    std::thread::Builder::new()
        .name("plugin-sdk-business".into())
        .spawn(move || {
            // Capture the whole owner, including its Drop order, rather than
            // allowing precise closure capture to retain only the handler.
            let resources = resources;
            while let Ok(job) = receiver.recv() {
                let Job { request, operation } = job;
                let result = catch_unwind(AssertUnwindSafe(|| {
                    operation.check_current()?;
                    resources
                        .handler
                        .invoke(&operation, &request.method, request.params)
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
