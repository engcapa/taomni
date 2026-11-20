//! Renderer correlation stays separate from core-owned scoped wire IDs.
use super::{runtime::RuntimeHost, *};
use serde_json::Value;
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use taomni_plugin_api::{ErrorCode, RequestId};
use taomni_plugin_services::{OperationKind, OperationPermit};

#[derive(Debug)]
pub(super) struct PendingRequest {
    cancelled: bool,
    target: Option<(host::HostCancellation, RequestId)>,
}

pub(super) struct PendingCall<'a> {
    registry: &'a PluginRegistry,
    key: (String, String),
}

impl PendingCall<'_> {
    fn attach(&self, runtime: &RuntimeHost, id: RequestId) {
        self.attach_target(&runtime.cancellation, id);
    }

    fn attach_target(&self, handle: &host::HostCancellation, id: RequestId) {
        handle.register(&id);
        let mut requests = self
            .registry
            .pending_requests
            .lock()
            .expect("plugin request lock poisoned");
        let request = requests
            .get_mut(&self.key)
            .expect("registered pending request");
        request.target = Some((handle.clone(), id.clone()));
        if request.cancelled {
            handle.cancel(&id);
        }
    }

    pub(super) fn cancelled(&self) -> bool {
        self.registry.shutting_down.load(Ordering::Acquire)
            || self.registry.quiescence.load(Ordering::Acquire) != 0
            || self
                .registry
                .pending_requests
                .lock()
                .expect("plugin request lock poisoned")
                .get(&self.key)
                .is_none_or(|request| request.cancelled)
    }
}

impl Drop for PendingCall<'_> {
    fn drop(&mut self) {
        let request = self
            .registry
            .pending_requests
            .lock()
            .expect("plugin request lock poisoned")
            .remove(&self.key);
        if let Some((handle, id)) = request.and_then(|request| request.target) {
            handle.finish(&id);
        }
    }
}

fn cancelled() -> PluginError {
    PluginError::Rpc {
        code: ErrorCode::RequestCancelled.as_i32(),
        message: "plugin request cancelled".into(),
    }
}

impl PluginRegistry {
    pub fn invoke(&self, slug: &str, command: &str, payload: Value) -> Result<Value, PluginError> {
        self.invoke_with_id(slug, command, payload, &uuid::Uuid::new_v4().to_string())
    }

    pub fn invoke_with_id(
        &self,
        slug: &str,
        command: &str,
        payload: Value,
        request_id: &str,
    ) -> Result<Value, PluginError> {
        self.invoke_cancellable(slug, command, payload, request_id, || false)
    }

    pub(crate) fn invoke_cancellable(
        &self,
        slug: &str,
        command: &str,
        payload: Value,
        request_id: &str,
        caller_cancelled: impl Fn() -> bool,
    ) -> Result<Value, PluginError> {
        if caller_cancelled() {
            return Err(cancelled());
        }
        let record = self.call_record(slug, command)?;
        let pending = self.begin_call(slug, request_id)?;
        // Cancellation can arrive before the blocking worker registers its ID.
        if caller_cancelled() || pending.cancelled() {
            return Err(cancelled());
        }
        let runtime = self.host_for(slug, &record)?;
        let id = RequestId::from(request_id);
        pending.attach(&runtime, id.clone());
        loop {
            if caller_cancelled() || pending.cancelled() {
                return Err(cancelled());
            }
            if let Ok(mut process) = runtime.process.try_lock() {
                return process
                    .invoke_with_id(id, command, Some(payload))
                    .map_err(|error| PluginError::Rpc {
                        code: error.rpc_code(),
                        message: format!("{slug}: {error}"),
                    });
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Only typed core facades choose this operation class. No renderer IPC
    /// accepts a class, context, epoch or reset/export grant.
    pub(crate) fn invoke_scoped(
        &self,
        slug: &str,
        command: &str,
        payload: Value,
        request_id: &str,
        kind: OperationKind,
        deadline: Instant,
    ) -> Result<Value, PluginError> {
        self.invoke_scoped_inner(slug, command, request_id, kind, deadline, |_| Ok(payload))
    }

    /// The invoking window is supplied by a typed core facade. It never comes
    /// from the renderer's plugin_invoke payload or a reverse service request.
    pub(crate) fn invoke_scoped_capture(
        &self,
        window: tauri::WebviewWindow,
        slug: &str,
        command: &str,
        payload: Value,
        request_id: &str,
        deadline: Instant,
    ) -> Result<Value, PluginError> {
        let services = self
            .services
            .as_ref()
            .ok_or_else(|| PluginError::HostUnavailable(slug.into()))?;
        let source = std::sync::Arc::new(crate::capture::plugin_service::WindowStillCapture {
            window,
            pool: services.capture_pool.clone(),
        });
        self.invoke_scoped_inner(
            slug,
            command,
            request_id,
            OperationKind::ReadData,
            deadline,
            |permit| {
                permit
                    .grant_still_capture(source)
                    .map_err(services::service_error)?;
                Ok(payload)
            },
        )
    }

    pub(super) fn invoke_scoped_inner(
        &self,
        slug: &str,
        command: &str,
        request_id: &str,
        kind: OperationKind,
        deadline: Instant,
        prepare: impl FnOnce(&mut OperationPermit) -> Result<Value, PluginError>,
    ) -> Result<Value, PluginError> {
        let record = self.call_record(slug, command)?;
        let pending = self.begin_call(slug, request_id)?;
        if pending.cancelled() {
            return Err(cancelled());
        }
        let runtime = self.host_for(slug, &record)?;
        let identity = runtime
            .identity
            .read()
            .expect("plugin identity poisoned")
            .clone()
            .ok_or_else(|| PluginError::HostUnavailable(slug.into()))?;
        let services = self
            .services
            .as_ref()
            .ok_or_else(|| PluginError::HostUnavailable(slug.into()))?;
        let mut permit = services.admit(&identity, kind, deadline, &|| pending.cancelled())?;
        let payload = prepare(&mut permit)?;
        self.call_scoped_host(&pending, &runtime, permit, command, payload)
    }

    pub(super) fn call_scoped_host(
        &self,
        pending: &PendingCall<'_>,
        runtime: &RuntimeHost,
        permit: OperationPermit,
        command: &str,
        payload: Value,
    ) -> Result<Value, PluginError> {
        let wire_id = format!(
            "core/{}/{}",
            permit.context().host_instance,
            permit.context().operation
        )
        .into();
        pending.attach(runtime, wire_id);
        loop {
            if pending.cancelled() {
                permit.cancel();
                return Err(cancelled());
            }
            permit.check_current().map_err(services::service_error)?;
            if let Ok(mut process) = runtime.process.try_lock() {
                return process
                    .invoke_with_operation(permit, command, Some(payload))
                    .map_err(|error| {
                        let slug = &runtime.manifest.slug;
                        match error {
                            host::HostProcessError::Rpc { code, message } if slug == "mfa" => {
                                PluginError::Rpc { code, message }
                            }
                            _ => PluginError::Rpc {
                                code: error.rpc_code(),
                                message: format!("{slug}: {error}"),
                            },
                        }
                    });
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub(super) fn call_record(
        &self,
        slug: &str,
        command: &str,
    ) -> Result<PluginRecord, PluginError> {
        use taomni_plugin_api::services::{
            SNAPSHOT_METHOD, SNAPSHOT_PREPARE_METHOD, SNAPSHOT_RELEASE_METHOD, VAULT_REVOKE_METHOD,
        };
        if matches!(
            command,
            SNAPSHOT_PREPARE_METHOD
                | SNAPSHOT_METHOD
                | SNAPSHOT_RELEASE_METHOD
                | VAULT_REVOKE_METHOD
        ) {
            return Err(PluginError::CommandDenied {
                slug: slug.into(),
                command: command.into(),
            });
        }
        let record = self.enabled_record(slug)?;
        if !record.manifest.commands.contains(command) {
            return Err(PluginError::CommandDenied {
                slug: slug.into(),
                command: command.into(),
            });
        }
        Ok(record)
    }

    pub(super) fn begin_call(
        &self,
        slug: &str,
        request_id: &str,
    ) -> Result<PendingCall<'_>, PluginError> {
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(PluginError::Rpc {
                code: ErrorCode::InvalidRequest.as_i32(),
                message: "invalid request id".into(),
            });
        }
        let key = (slug.to_owned(), request_id.to_owned());
        let mut requests = self
            .pending_requests
            .lock()
            .expect("plugin request lock poisoned");
        if requests.contains_key(&key) {
            return Err(PluginError::Rpc {
                code: ErrorCode::DuplicateRequest.as_i32(),
                message: format!("duplicate request id: {request_id}"),
            });
        }
        requests.insert(
            key.clone(),
            PendingRequest {
                cancelled: false,
                target: None,
            },
        );
        Ok(PendingCall {
            registry: self,
            key,
        })
    }

    pub fn cancel_request(&self, slug: &str, request_id: &str) -> bool {
        let target = {
            let mut requests = self
                .pending_requests
                .lock()
                .expect("plugin request lock poisoned");
            let Some(request) = requests.get_mut(&(slug.into(), request_id.into())) else {
                return false;
            };
            request.cancelled = true;
            request.target.clone()
        };
        if let Some((handle, id)) = target {
            handle.cancel(&id);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocking_caller_cancellation_during_registration_does_not_start_host() {
        let registry = PluginRegistry::new("unused");
        let manifest: ModuleManifest =
            serde_json::from_str(include_str!("../../plugins/vnc-client/module.json")).unwrap();
        registry.records.write().unwrap().insert(
            manifest.slug.clone(),
            PluginRecord {
                manifest,
                state: LifecycleState::Enabled,
                reason: None,
                data_retained: false,
                previous_version: None,
                rollback_until: None,
            },
        );
        let checked = std::cell::Cell::new(false);
        let result = registry.invoke_cancellable(
            "vnc-client",
            "vnc/start",
            Value::Null,
            "cancel-before-attachment",
            || checked.replace(true),
        );
        assert!(matches!(result, Err(PluginError::Rpc { code, .. })
                if code == ErrorCode::RequestCancelled.as_i32()));
        assert!(registry.pending_requests.lock().unwrap().is_empty());
        assert!(registry.hosts.lock().unwrap().is_empty());
    }

    #[test]
    fn renderer_cancel_maps_to_scoped_wire_id_even_when_cancelled_before_attachment() {
        let registry = PluginRegistry::new("unused");
        let guard = registry.begin_call("mfa", "renderer-1").unwrap();
        assert!(registry.cancel_request("mfa", "renderer-1"));
        assert!(guard.cancelled());
        let cancellation = host::HostCancellation::default();
        let wire_id = RequestId::from("core/host/operation");
        guard.attach_target(&cancellation, wire_id.clone());
        assert!(registry.cancel_request("mfa", "renderer-1"));
        assert!(!registry.cancel_request("mfa", "core/host/operation"));
        drop(guard);
        assert!(!cancellation.cancel(&wire_id));
        assert!(registry.pending_requests.lock().unwrap().is_empty());
    }

    #[test]
    fn duplicate_correlation_and_renderer_direction_injection_are_rejected() {
        let registry = PluginRegistry::new("unused");
        let _call = registry.begin_call("mfa", "renderer-1").unwrap();
        assert!(matches!(
            registry.begin_call("mfa", "renderer-1"),
            Err(PluginError::Rpc { code: -32005, .. })
        ));
        assert!(matches!(
            registry.begin_call("mfa", "core/host/id"),
            Err(PluginError::Rpc { code: -32600, .. })
        ));
        assert!(registry.begin_call("other", "renderer-1").is_ok());
    }

    #[test]
    fn renderer_cannot_choose_a_snapshot_destination_or_lifecycle_context() {
        let registry = PluginRegistry::new("unused");
        for method in [
            "backup/prepare",
            "backup/snapshot",
            "backup/release",
            "vault/revoke",
        ] {
            assert!(matches!(
                registry.invoke("mfa", method, Value::Null),
                Err(PluginError::CommandDenied { .. })
            ));
        }
        assert!(registry.pending_requests.lock().unwrap().is_empty());
    }
}
