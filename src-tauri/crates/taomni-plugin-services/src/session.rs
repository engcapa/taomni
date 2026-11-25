//! Per-authenticated-transport replay/queue ownership. A new process gets a new
//! session and cannot receive completions addressed to its predecessor.

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError},
    },
};

use taomni_plugin_api::{
    ErrorCode, ReplayError, RequestId, RequestIdMode, RequestReplay, RpcError, RpcRequest,
    services::{
        CAPTURE_STILL_METHOD, CaptureStillRequest, CoreServiceError, EXPORT_GRANT_METHOD,
        ExportGrantRequest, FIXED_KEY_METHOD, FixedKeyRequest, OperationContext,
    },
};

use crate::{
    AuthorizedHost, CoreServiceDispatcher, SensitiveServiceFrame,
    dispatcher::{ServiceCall, ServiceJob},
};

pub struct ServiceCompletion {
    pub id: RequestId,
    pub context: OperationContext,
    pub result: Result<SensitiveServiceFrame, RpcError>,
}

pub struct ServiceSession {
    dispatcher: Arc<CoreServiceDispatcher>,
    host: AuthorizedHost,
    replay: RequestReplay,
    pending: HashMap<RequestId, OperationContext>,
    completion: SyncSender<ServiceCompletion>,
    receiver: Receiver<ServiceCompletion>,
    failed: Arc<AtomicBool>,
    transfers: Vec<taomni_plugin_stream::BinaryOffer>,
}

impl std::fmt::Debug for ServiceSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServiceSession")
            .field("host", &self.host.instance())
            .finish_non_exhaustive()
    }
}

impl ServiceSession {
    /// Only the transport owner calls this, after package and handshake checks.
    pub fn new(dispatcher: Arc<CoreServiceDispatcher>, host: AuthorizedHost) -> Self {
        Self::with_request_id_mode(dispatcher, host, RequestIdMode::Legacy)
    }

    pub fn with_request_id_mode(
        dispatcher: Arc<CoreServiceDispatcher>,
        host: AuthorizedHost,
        mode: RequestIdMode,
    ) -> Self {
        let (completion, receiver) = mpsc::sync_channel(8);
        let replay = RequestReplay::new(mode, "host", Some(host.instance()))
            .expect("authenticated service transport");
        Self {
            dispatcher,
            host,
            replay,
            pending: HashMap::new(),
            completion,
            receiver,
            failed: Arc::new(AtomicBool::new(false)),
            transfers: Vec::new(),
        }
    }

    pub fn host(&self) -> &AuthorizedHost {
        &self.host
    }

    pub fn submit(&mut self, request: RpcRequest) -> Result<(), RpcError> {
        if self.failed.load(Ordering::Acquire) {
            return Err(CoreServiceError::StalePluginContext.into_rpc_error());
        }
        if request.jsonrpc != "2.0" || !valid_host_request_id(&request.id, &self.host) {
            return Err(RpcError::from_code(ErrorCode::InvalidRequest));
        }
        // Remember rejected IDs too; retries must issue a fresh correlation ID.
        self.replay
            .accept(&request.id)
            .map_err(|error| match error {
                ReplayError::Invalid => RpcError::from_code(ErrorCode::InvalidRequest),
                ReplayError::Duplicate => CoreServiceError::DuplicateRequest.into_rpc_error(),
                ReplayError::Full => CoreServiceError::CoreServiceBusy.into_rpc_error(),
            })?;
        if self.pending.len() >= 8 {
            return Err(CoreServiceError::CoreServiceBusy.into_rpc_error());
        }
        let context = request
            .context
            .ok_or_else(|| CoreServiceError::StalePluginContext.into_rpc_error())?;
        let operation = self
            .dispatcher
            .admission
            .borrow_operation(&self.host, &context)
            .map_err(CoreServiceError::into_rpc_error)?;
        operation
            .check_current()
            .map_err(CoreServiceError::into_rpc_error)?;
        let params = request
            .params
            .ok_or_else(|| RpcError::from_code(ErrorCode::InvalidParams))?;
        let call = match request.method.as_str() {
            CAPTURE_STILL_METHOD => {
                self.host
                    .authorize_screen_capture()
                    .map_err(CoreServiceError::into_rpc_error)?;
                serde_json::from_value::<CaptureStillRequest>(params)
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                ServiceCall::CaptureStill
            }
            FIXED_KEY_METHOD => {
                let key: FixedKeyRequest = serde_json::from_value(params)
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                self.host
                    .fixed_key_owner(&key.key_id)
                    .map_err(CoreServiceError::into_rpc_error)?;
                ServiceCall::FixedKey(key)
            }
            EXPORT_GRANT_METHOD => {
                let owner = taomni_plugin_api::services::FixedKeyId::parse(
                    taomni_plugin_api::services::MFA_DATA_KEY_ID,
                )
                .expect("core fixed key policy ID");
                self.host
                    .fixed_key_owner(&owner)
                    .map_err(CoreServiceError::into_rpc_error)?;
                ServiceCall::ExportGrant(
                    serde_json::from_value::<ExportGrantRequest>(params)
                        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?,
                )
            }
            _ => return Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        };
        let permit = operation
            .begin_service_request(request.id.clone())
            .map_err(CoreServiceError::into_rpc_error)?;
        self.dispatcher.submit(ServiceJob {
            id: request.id.clone(),
            context: context.clone(),
            call,
            permit,
            completion: self.completion.clone(),
            failed: self.failed.clone(),
        })?;
        self.pending.insert(request.id, context);
        Ok(())
    }

    /// Only this session's pump can drain its completion queue. Validation is
    /// repeated after worker completion and by the writer immediately preflush.
    pub fn try_completion(&mut self) -> Result<Option<ServiceCompletion>, CoreServiceError> {
        self.transfers.retain(|offer| !offer.is_finished());
        if self.failed.load(Ordering::Acquire) {
            return Err(CoreServiceError::CoreServiceBusy);
        }
        match self.receiver.try_recv() {
            Ok(mut reply) => {
                if self.pending.remove(&reply.id).as_ref() != Some(&reply.context)
                    || reply.context.host_instance != *self.host.instance()
                {
                    return Err(CoreServiceError::StalePluginContext);
                }
                if let Err(error) = self
                    .dispatcher
                    .admission
                    .borrow_operation(&self.host, &reply.context)
                    .and_then(|operation| operation.check_current())
                {
                    reply.result = Err(error.into_rpc_error());
                }
                if let Ok(frame) = &mut reply.result
                    && let Some(offer) = frame.take_binary_offer()
                {
                    // The payload task retains its request permit. A flushed
                    // descriptor must not abort it by dropping its handle.
                    if self.transfers.len() >= 8 {
                        drop(offer);
                        reply.result = Err(CoreServiceError::CoreServiceBusy.into_rpc_error());
                    } else {
                        self.transfers.push(offer);
                    }
                }
                Ok(Some(reply))
            }
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err(CoreServiceError::StalePluginContext),
        }
    }
}

impl Drop for ServiceSession {
    fn drop(&mut self) {
        self.failed.store(true, Ordering::Release);
        self.dispatcher.admission.cancel_host(&self.host);
    }
}

fn valid_host_request_id(id: &RequestId, host: &AuthorizedHost) -> bool {
    let RequestId::String(id) = id else {
        return false;
    };
    let prefix = format!("host/{}/", host.instance());
    id.strip_prefix(&prefix).is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix.len() <= 64
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    })
}
