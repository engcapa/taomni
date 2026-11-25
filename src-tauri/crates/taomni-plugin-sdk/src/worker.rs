use super::ActiveOperations;
use crate::{HostStorage, Operation, PluginHandler, client::ServiceClient};
use std::{
    io,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc,
        mpsc::{self, RecvTimeoutError, SyncSender},
    },
    time::Duration,
};
use taomni_plugin_api::{ErrorCode, RpcError, RpcMessage, RpcRequest, RpcResponse};

pub(super) struct Job {
    pub request: RpcRequest,
    pub operation: Arc<Operation>,
    pub host: Option<taomni_plugin_api::services::HostInstanceId>,
}

struct WorkerResources {
    snapshots: crate::snapshot::SnapshotSession,
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
        snapshots: Default::default(),
        handler,
        _storage: storage,
    };
    std::thread::Builder::new()
        .name("plugin-sdk-business".into())
        .spawn(move || {
            // Capture the whole owner, including its Drop order, rather than
            // allowing precise closure capture to retain only the handler.
            let mut resources = resources;
            loop {
                resources.snapshots.expire();
                let job = match receiver.recv_timeout(Duration::from_millis(50)) {
                    Ok(job) => job,
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => break,
                };
                let Job {
                    request,
                    operation,
                    host,
                } = job;
                let result = catch_unwind(AssertUnwindSafe(|| {
                    operation.check_current()?;
                    if crate::snapshot::is_snapshot(&request.method) {
                        resources.snapshots.dispatch(
                            &request.method,
                            request.params,
                            resources._storage.as_deref(),
                            host.as_ref(),
                            resources.handler.snapshot_provider(),
                            operation.clone(),
                        )
                    } else if resources.snapshots.is_paused() {
                        Err(RpcError::new(
                            ErrorCode::InvalidState,
                            "PLUGIN_SNAPSHOT_BUSY",
                        ))
                    } else {
                        resources
                            .handler
                            .invoke(&operation, &request.method, request.params)
                    }
                }));
                let result = match result {
                    Ok(result) => result,
                    Err(_) => {
                        resources.snapshots.abort();
                        Err(RpcError::new(
                            ErrorCode::InternalError,
                            "PLUGIN_OPERATION_FAILED",
                        ))
                    }
                };
                // Clear before publishing either normal or cancellation results.
                operation.clear_keys();
                if operation.check_current().is_err() {
                    resources.snapshots.abort();
                }
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
