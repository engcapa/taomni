use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
    },
    time::Duration,
};
use taomni_plugin_api::{
    ErrorCode, RequestId, RpcError, RpcMessage, RpcRequest,
    services::{CoreServiceError, FixedKeyResult, OperationContext},
};

use crate::{Operation, sensitive::Envelope};
use zeroize::{Zeroize, Zeroizing};

pub(crate) enum Reply {
    Key(FixedKeyResult),
    Export(bool),
}
#[derive(Clone, Copy)]
pub(crate) enum ReplyKind {
    Key,
    Export,
}

struct Pending {
    context: OperationContext,
    kind: ReplyKind,
    sender: SyncSender<Result<Reply, RpcError>>,
}

pub(crate) struct ServiceClient {
    pub output: SyncSender<RpcMessage>,
    pending: Mutex<HashMap<RequestId, Pending>>,
    next_id: AtomicU64,
    retired: Mutex<HashSet<RequestId>>,
    failed: AtomicBool,
}

impl ServiceClient {
    pub fn new(output: SyncSender<RpcMessage>) -> Arc<Self> {
        Arc::new(Self {
            output,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            retired: Mutex::new(HashSet::new()),
            failed: AtomicBool::new(false),
        })
    }

    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }

    pub fn request(
        &self,
        operation: &Operation,
        method: &str,
        params: serde_json::Value,
        kind: ReplyKind,
    ) -> Result<Reply, RpcError> {
        operation.check_current()?;
        let context = operation
            .context()
            .ok_or_else(|| CoreServiceError::StalePluginContext.into_rpc_error())?
            .clone();
        let sequence = self
            .next_id
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |next| {
                (next <= 65_536).then_some(next + 1)
            })
            .map_err(|_| CoreServiceError::CoreServiceBusy.into_rpc_error())?;
        let id: RequestId = format!("host/{}/{sequence}", context.host_instance).into();
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut pending = self.pending.lock().expect("service pending poisoned");
            if pending.len() >= 8 {
                return Err(CoreServiceError::CoreServiceBusy.into_rpc_error());
            }
            pending.insert(
                id.clone(),
                Pending {
                    context: context.clone(),
                    kind,
                    sender,
                },
            );
        }
        let guard = PendingGuard {
            client: self,
            id: id.clone(),
        };
        let mut request = RpcRequest::new(id, method, Some(params));
        request.context = Some(context);
        self.send(RpcMessage::Request(request))?;
        let result = loop {
            operation.check_current()?;
            match receiver.recv_timeout(Duration::from_millis(10)) {
                Ok(reply) => {
                    operation.check_current()?;
                    break reply;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break Err(CoreServiceError::StalePluginContext.into_rpc_error());
                }
            }
        };
        drop(guard);
        result
    }

    /// Parse the raw result directly into the expected secret DTO. In
    /// particular, never deserialize the whole response as RpcMessage/Value.
    pub fn deliver(&self, line: &mut Zeroizing<Vec<u8>>) -> Result<(), RpcError> {
        let prepared = self.prepare_reply(line);
        // Clear raw JSON before making the typed secret available to the
        // business worker, which may finish and acknowledge revoke immediately.
        line.zeroize();
        if let Some((pending, result)) = prepared? {
            let _ = pending.sender.try_send(result);
        }
        Ok(())
    }

    fn prepare_reply(
        &self,
        bytes: &[u8],
    ) -> Result<Option<(Pending, Result<Reply, RpcError>)>, RpcError> {
        let envelope: Envelope<'_> = serde_json::from_slice(bytes)
            .map_err(|_| RpcError::from_code(ErrorCode::InvalidRequest))?;
        let id = envelope
            .id
            .as_ref()
            .ok_or_else(|| RpcError::from_code(ErrorCode::InvalidRequest))?;
        let pending = self
            .pending
            .lock()
            .expect("service pending poisoned")
            .remove(id);
        let Some(pending) = pending else {
            // A cancelled request may already have discarded its receiver.
            // Only IDs issued in our reserved direction may be late replies.
            return if self
                .retired
                .lock()
                .expect("service retired poisoned")
                .remove(id)
            {
                Ok(None)
            } else {
                Err(RpcError::from_code(ErrorCode::InvalidRequest))
            };
        };
        let result = if let (Some(raw), None) = (envelope.result, envelope.error) {
            match pending.kind {
                ReplyKind::Key if raw.get().as_bytes().contains(&b'\\') => Err(RpcError::from_code(ErrorCode::InvalidRequest)),
                ReplyKind::Key => serde_json::from_str::<FixedKeyResult>(raw.get())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidRequest))
                    .and_then(|key| {
                        if matches!(&key, FixedKeyResult::Key { context, .. } if context != &pending.context) {
                            Err(CoreServiceError::StalePluginContext.into_rpc_error())
                        } else { Ok(Reply::Key(key)) }
                    }),
                ReplyKind::Export => serde_json::from_str::<bool>(raw.get()).map(Reply::Export)
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidRequest)),
            }
        } else if let (None, Some(raw)) = (envelope.result, envelope.error) {
            Err(serde_json::from_str(raw.get())
                .unwrap_or_else(|_| RpcError::from_code(ErrorCode::InvalidRequest)))
        } else {
            Err(RpcError::from_code(ErrorCode::InvalidRequest))
        };
        Ok(Some((pending, result)))
    }

    pub fn send(&self, message: RpcMessage) -> Result<(), RpcError> {
        self.output.try_send(message).map_err(|_| {
            self.failed.store(true, Ordering::Release);
            CoreServiceError::CoreServiceBusy.into_rpc_error()
        })
    }
}

struct PendingGuard<'a> {
    client: &'a ServiceClient,
    id: RequestId,
}
impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if self
            .client
            .pending
            .lock()
            .expect("service pending poisoned")
            .remove(&self.id)
            .is_some()
        {
            self.client
                .retired
                .lock()
                .expect("service retired poisoned")
                .insert(self.id.clone());
        }
    }
}
