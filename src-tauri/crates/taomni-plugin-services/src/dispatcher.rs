//! Bounded workers never acquire a registry/HostProcess/AppState mutex. Reverse
//! calls borrow an existing operation lease, including while a writer waits.

use std::{
    io,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
};

use taomni_plugin_api::{
    ErrorCode, RequestId, RpcError,
    services::{CoreServiceError, ExportGrantRequest, FixedKeyRequest, OperationContext},
};

use crate::{OperationAdmission, ReverseRequestPermit, SensitiveServiceFrame, ServiceCompletion};

/// Implemented by the production Vault adapter. Secrets are already encoded
/// into an owned zeroizing frame when they cross this boundary.
pub trait CoreServiceBackend: Send + Sync + 'static {
    fn fixed_key(
        &self,
        id: RequestId,
        request: FixedKeyRequest,
        permit: ReverseRequestPermit,
    ) -> Result<SensitiveServiceFrame, RpcError>;
}

#[derive(Clone, Copy, Debug)]
pub struct DispatcherConfig {
    pub workers: usize,
    pub queued: usize,
}

impl Default for DispatcherConfig {
    fn default() -> Self {
        Self {
            workers: 2,
            queued: 16,
        }
    }
}

pub(crate) enum ServiceCall {
    FixedKey(FixedKeyRequest),
    ExportGrant(ExportGrantRequest),
    CaptureStill,
}

pub(crate) struct ServiceJob {
    pub id: RequestId,
    pub context: OperationContext,
    pub call: ServiceCall,
    pub permit: ReverseRequestPermit,
    pub completion: SyncSender<ServiceCompletion>,
    pub failed: Arc<AtomicBool>,
}

pub struct CoreServiceDispatcher {
    pub(crate) admission: OperationAdmission,
    sender: Mutex<Option<SyncSender<ServiceJob>>>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

impl std::fmt::Debug for CoreServiceDispatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CoreServiceDispatcher([REDACTED])")
    }
}

impl CoreServiceDispatcher {
    /// Called by core transport containment after kernel termination evidence;
    /// never exposed as a host service method or accepted from wire JSON.
    pub fn record_host_terminated(&self, host: &crate::AuthorizedHost) {
        self.admission.record_host_terminated(host);
    }
    pub fn new(
        admission: OperationAdmission,
        backend: Arc<dyn CoreServiceBackend>,
        config: DispatcherConfig,
    ) -> io::Result<Self> {
        if !(1..=8).contains(&config.workers) || !(1..=128).contains(&config.queued) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid service worker limits",
            ));
        }
        let (sender, receiver) = mpsc::sync_channel(config.queued);
        let receiver = Arc::new(Mutex::new(receiver));
        let mut workers = Vec::new();
        for index in 0..config.workers {
            let receiver = receiver.clone();
            let backend = backend.clone();
            workers.push(
                thread::Builder::new()
                    .name(format!("plugin-service-{index}"))
                    .spawn(move || worker(receiver, backend))?,
            );
        }
        Ok(Self {
            admission,
            sender: Mutex::new(Some(sender)),
            workers: Mutex::new(workers),
        })
    }

    pub(crate) fn submit(&self, job: ServiceJob) -> Result<(), RpcError> {
        let sender = self.sender.lock().expect("service dispatcher poisoned");
        sender
            .as_ref()
            .ok_or_else(|| CoreServiceError::CoreServiceBusy.into_rpc_error())?
            .try_send(job)
            .map_err(|_| CoreServiceError::CoreServiceBusy.into_rpc_error())
    }

    /// Stop admission to this queue, drain its finite work and join workers.
    /// Call outside all host/registry/Vault mutexes, after cancelling sessions.
    pub fn shutdown(&self) {
        self.sender
            .lock()
            .expect("service dispatcher poisoned")
            .take();
        let workers = std::mem::take(&mut *self.workers.lock().expect("service workers poisoned"));
        for worker in workers {
            let _ = worker.join();
        }
    }
}

impl Drop for CoreServiceDispatcher {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn worker(receiver: Arc<Mutex<Receiver<ServiceJob>>>, backend: Arc<dyn CoreServiceBackend>) {
    loop {
        // Release receiver mutex before touching the Vault or producing a reply.
        let job = receiver.lock().expect("service queue poisoned").recv();
        let Ok(job) = job else { return };
        let ServiceJob {
            id,
            context,
            call,
            permit,
            completion,
            failed,
        } = job;
        let result = catch_unwind(AssertUnwindSafe(|| {
            permit
                .check_current()
                .map_err(CoreServiceError::into_rpc_error)?;
            match call {
                ServiceCall::FixedKey(request) => backend.fixed_key(id.clone(), request, permit),
                ServiceCall::CaptureStill => crate::capture_still::capture(permit),
                ServiceCall::ExportGrant(request) => {
                    permit
                        .consume_export_grant(&request.grant)
                        .map_err(CoreServiceError::into_rpc_error)?;
                    SensitiveServiceFrame::export_grant_ack(id.clone(), permit)
                        .map_err(CoreServiceError::into_rpc_error)
                }
            }
        }))
        .unwrap_or_else(|_| {
            Err(RpcError::new(
                ErrorCode::InternalError,
                "CORE_SERVICE_FAILED",
            ))
        });
        let reply = ServiceCompletion {
            id,
            context,
            result,
        };
        if matches!(completion.try_send(reply), Err(TrySendError::Full(_))) {
            // Never stall a shared worker behind a silent/dead host. Its pump
            // observes this flag and terminates this session, dropping frames.
            failed.store(true, Ordering::Release);
        }
    }
}
