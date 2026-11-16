//! Per-authenticated-transport replay/queue ownership. A new process gets a new
//! session and cannot receive completions addressed to its predecessor.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError},
    },
};

use taomni_plugin_api::{
    ErrorCode, RequestId, RpcError, RpcRequest,
    services::{
        CoreServiceError, EXPORT_GRANT_METHOD, ExportGrantRequest, FIXED_KEY_METHOD,
        FixedKeyRequest, OperationContext,
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
    seen: HashSet<RequestId>,
    pending: HashMap<RequestId, OperationContext>,
    completion: SyncSender<ServiceCompletion>,
    receiver: Receiver<ServiceCompletion>,
    failed: Arc<AtomicBool>,
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
        let (completion, receiver) = mpsc::sync_channel(8);
        Self {
            dispatcher,
            host,
            seen: HashSet::new(),
            pending: HashMap::new(),
            completion,
            receiver,
            failed: Arc::new(AtomicBool::new(false)),
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
        if self.seen.contains(&request.id) {
            return Err(CoreServiceError::DuplicateRequest.into_rpc_error());
        }
        if self.seen.len() >= 65_536 {
            return Err(CoreServiceError::CoreServiceBusy.into_rpc_error());
        }
        // Remember rejected IDs too; retries must issue a fresh correlation ID.
        self.seen.insert(request.id.clone());
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
