use crate::client::{Reply, ReplyKind, ServiceClient};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};
use taomni_plugin_api::{
    RpcError,
    services::{
        CoreServiceError, EXPORT_GRANT_METHOD, ExportGrantId, ExportGrantRequest, FIXED_KEY_METHOD,
        FixedKeyRequest, FixedKeyResult, OperationContext, SecretKey32,
    },
};

#[path = "capture_still.rs"]
mod capture_still;

pub struct Operation {
    context: Option<OperationContext>,
    deadline: Instant,
    cancelled: taomni_plugin_stream::CancellationToken,
    client: Arc<ServiceClient>,
    keys: Mutex<Vec<Arc<KeySlot>>>,
}

struct KeySlot(Mutex<Option<SecretKey32>>);

impl Operation {
    pub(crate) fn deadline(&self) -> Instant {
        self.deadline
    }

    pub(crate) fn new(
        context: Option<OperationContext>,
        deadline: Instant,
        client: Arc<ServiceClient>,
    ) -> Self {
        Self {
            context,
            deadline,
            cancelled: taomni_plugin_stream::CancellationToken::new(),
            client,
            keys: Mutex::new(Vec::new()),
        }
    }

    pub fn context(&self) -> Option<&OperationContext> {
        self.context.as_ref()
    }

    /// Drop a pending transfer when the request is cancelled or its deadline expires.
    pub async fn while_current<T>(
        &self,
        work: impl std::future::Future<Output = T>,
    ) -> Result<T, RpcError> {
        self.check_current()?;
        tokio::select! {
            biased;
            _ = self.cancelled.cancelled() => Err(CoreServiceError::Cancelled.into_rpc_error()),
            _ = tokio::time::sleep_until(self.deadline.into()) => Err(CoreServiceError::TimedOut.into_rpc_error()),
            result = work => Ok(result),
        }
    }

    pub fn check_current(&self) -> Result<(), RpcError> {
        if self.cancelled.is_cancelled() {
            return Err(CoreServiceError::Cancelled.into_rpc_error());
        }
        if Instant::now() >= self.deadline {
            return Err(CoreServiceError::TimedOut.into_rpc_error());
        }
        Ok(())
    }

    /// Cancellation is nonblocking in the read pump. The business worker clears
    /// keys and finishes before it sends its cancellation/revocation response.
    pub(crate) fn cancel(&self) {
        self.cancelled.cancel();
    }

    pub fn fixed_key(
        &self,
        request: FixedKeyRequest,
    ) -> Result<Option<OperationKey<'_>>, RpcError> {
        let reply = self.client.request(
            self,
            FIXED_KEY_METHOD,
            serde_json::to_value(request).expect("fixed key request serializable"),
            ReplyKind::Key,
        )?;
        match reply {
            Reply::Key(FixedKeyResult::Missing) => Ok(None),
            Reply::Key(FixedKeyResult::Key { key, .. }) => {
                self.check_current()?;
                let mut keys = self.keys.lock().expect("operation keys poisoned");
                if keys.len() >= 8 {
                    return Err(CoreServiceError::CoreServiceBusy.into_rpc_error());
                }
                let slot = Arc::new(KeySlot(Mutex::new(Some(key))));
                keys.push(slot.clone());
                Ok(Some(OperationKey {
                    operation: self,
                    slot,
                }))
            }
            _ => Err(CoreServiceError::StalePluginContext.into_rpc_error()),
        }
    }

    pub fn validate_export_grant(&self, grant: ExportGrantId) -> Result<(), RpcError> {
        let reply = self.client.request(
            self,
            EXPORT_GRANT_METHOD,
            serde_json::to_value(ExportGrantRequest { grant }).expect("export grant serializable"),
            ReplyKind::Export,
        )?;
        match reply {
            Reply::Export(true) => Ok(()),
            _ => Err(CoreServiceError::PermissionDenied.into_rpc_error()),
        }
    }

    pub(crate) fn clear_keys(&self) {
        let slots = std::mem::take(
            &mut *self
                .keys
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()),
        );
        for slot in slots {
            slot.0
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .take();
        }
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        self.cancel();
        self.clear_keys();
    }
}

/// Cannot outlive its operation, cannot be cloned/serialized/debugged as bytes.
pub struct OperationKey<'a> {
    operation: &'a Operation,
    slot: Arc<KeySlot>,
}

impl OperationKey<'_> {
    pub fn with_key<T>(&self, consume: impl FnOnce(&[u8; 32]) -> T) -> Result<T, RpcError> {
        self.operation.check_current()?;
        let key = self
            .slot
            .0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        self.operation.check_current()?;
        let key = key
            .as_ref()
            .ok_or_else(|| CoreServiceError::StalePluginContext.into_rpc_error())?;
        Ok(consume(key.as_bytes()))
    }
}

impl std::fmt::Debug for OperationKey<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OperationKey([REDACTED])")
    }
}

impl Drop for OperationKey<'_> {
    fn drop(&mut self) {
        self.slot
            .0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
    }
}
