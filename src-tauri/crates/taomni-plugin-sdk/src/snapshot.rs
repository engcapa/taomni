//! Job ownership lives on the business actor; no DB mutex crosses the wire.
use crate::{
    HostStorage, Operation,
    snapshot_export::{SnapshotExport, invalid},
};
use serde_json::Value;
use std::{collections::HashSet, sync::Arc, time::Instant};
use taomni_plugin_api::{ErrorCode, RpcError, services::*};

/// A real store must stop and drain every background writer in freeze. Its
/// export uses its own connections, and resume must release that gate even
/// after cancellation/failure. Neither hook may request a Vault key.
pub trait SnapshotProvider: Send + Sync + 'static {
    fn freeze(&self, operation: &Operation) -> Result<(), RpcError>;
    fn export(
        &self,
        destination: &mut SnapshotExport,
        operation: &Operation,
    ) -> Result<(), RpcError>;
    fn resume(&self);
}

struct Paused {
    provider: Arc<dyn SnapshotProvider>,
    request: PrepareSnapshot,
    prepared: PreparedSnapshot,
    deadline: Instant,
    exported: Option<SnapshotResult>,
}
impl Drop for Paused {
    fn drop(&mut self) {
        self.provider.resume();
    }
}

#[derive(Default)]
pub(crate) struct SnapshotSession {
    paused: Option<Paused>,
    released: Option<ReleaseSnapshot>,
    closed: HashSet<SnapshotJobId>,
}

pub(crate) fn is_snapshot(method: &str) -> bool {
    matches!(
        method,
        SNAPSHOT_PREPARE_METHOD | SNAPSHOT_METHOD | SNAPSHOT_RELEASE_METHOD
    )
}

impl SnapshotSession {
    pub(crate) fn is_paused(&self) -> bool {
        self.paused.is_some()
    }

    pub(crate) fn abort(&mut self) {
        if let Some(paused) = self.paused.take() {
            self.closed.insert(paused.prepared.job.clone());
            self.released = Some(ReleaseSnapshot {
                job: paused.prepared.job.clone(),
                barrier: paused.prepared.barrier.clone(),
            });
            drop(paused);
        }
    }

    pub(crate) fn expire(&mut self) {
        if self
            .paused
            .as_ref()
            .is_some_and(|paused| Instant::now() >= paused.deadline)
        {
            self.abort();
        }
    }

    pub(crate) fn dispatch(
        &mut self,
        method: &str,
        params: Option<Value>,
        storage: Option<&HostStorage>,
        host: Option<&HostInstanceId>,
        provider: Option<Arc<dyn SnapshotProvider>>,
        operation: Arc<Operation>,
    ) -> Result<Value, RpcError> {
        self.expire();
        operation.check_current()?;
        let storage = storage.ok_or_else(invalid)?;
        let host = host.ok_or_else(invalid)?;
        let params = params.ok_or_else(invalid)?;
        match method {
            SNAPSHOT_PREPARE_METHOD => {
                let request: PrepareSnapshot =
                    serde_json::from_value(params).map_err(|_| invalid())?;
                if request.profile_generation != storage.context().generation {
                    return Err(invalid());
                }
                if let Some(paused) = &self.paused {
                    return if paused.request == request && paused.prepared.host_instance == *host {
                        Ok(serde_json::to_value(&paused.prepared).expect("snapshot metadata"))
                    } else {
                        Err(busy())
                    };
                }
                if self.closed.contains(&request.job) || self.closed.len() >= 16_384 {
                    return Err(invalid());
                }
                SnapshotExport::validate(&request.destination, storage.root().path())?;
                let provider =
                    provider.ok_or_else(|| RpcError::from_code(ErrorCode::MethodNotFound))?;
                let prepared = PreparedSnapshot {
                    job: request.job.clone(),
                    host_instance: host.clone(),
                    profile_generation: request.profile_generation.clone(),
                    barrier: fresh_barrier(),
                };
                // Own cleanup before entering a store hook: partial freeze,
                // panic, EOF and cancellation must not leave a closed gate.
                self.paused = Some(Paused {
                    provider: provider.clone(),
                    request,
                    prepared: prepared.clone(),
                    deadline: operation.deadline(),
                    exported: None,
                });
                if let Err(error) = provider
                    .freeze(&operation)
                    .and_then(|()| operation.check_current())
                {
                    self.abort();
                    return Err(error);
                }
                Ok(serde_json::to_value(prepared).expect("snapshot metadata"))
            }
            SNAPSHOT_METHOD => {
                let request: SnapshotRequest =
                    serde_json::from_value(params).map_err(|_| invalid())?;
                let paused = self.paused.as_ref().ok_or_else(busy)?;
                if request.job != paused.prepared.job
                    || request.barrier != paused.prepared.barrier
                    || request.staging != paused.request.destination.token
                    || paused.prepared.host_instance != *host
                {
                    return Err(invalid());
                }
                if let Some(result) = &paused.exported {
                    return Ok(serde_json::to_value(result).expect("snapshot metadata"));
                }
                let mut export =
                    SnapshotExport::new(&paused.request.destination, operation.clone());
                let result = paused
                    .provider
                    .export(&mut export, &operation)
                    .and_then(|()| export.complete());
                let result = match result {
                    Ok(files) => SnapshotResult {
                        job: request.job,
                        host_instance: host.clone(),
                        profile_generation: storage.context().generation.clone(),
                        files,
                    },
                    Err(error) => {
                        self.abort();
                        return Err(error);
                    }
                };
                operation.check_current().inspect_err(|_| self.abort())?;
                self.paused.as_mut().expect("paused snapshot").exported = Some(result.clone());
                Ok(serde_json::to_value(result).expect("snapshot metadata"))
            }
            SNAPSHOT_RELEASE_METHOD => {
                let request: ReleaseSnapshot =
                    serde_json::from_value(params).map_err(|_| invalid())?;
                match &self.paused {
                    Some(paused)
                        if request.job == paused.prepared.job
                            && request.barrier == paused.prepared.barrier
                            && paused.prepared.host_instance == *host =>
                    {
                        self.abort();
                    }
                    None if self.released.as_ref() == Some(&request) => (),
                    _ => return Err(invalid()),
                }
                Ok(serde_json::to_value(request).expect("snapshot release metadata"))
            }
            _ => Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        }
    }
}

fn busy() -> RpcError {
    RpcError::new(ErrorCode::InvalidState, "PLUGIN_SNAPSHOT_BUSY")
}

fn fresh_barrier() -> SnapshotBarrierToken {
    let mut bytes = [0u8; 16];
    rand::fill(&mut bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    SnapshotBarrierToken::parse(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
    .expect("UUID")
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "snapshot_test_support.rs"]
mod test_support;

#[cfg(test)]
#[path = "snapshot_export_tests.rs"]
mod export_tests;
