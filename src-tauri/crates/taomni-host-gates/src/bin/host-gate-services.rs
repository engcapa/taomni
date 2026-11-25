//! Official SDK fixture only: no Vault path or key cache. Run on hosted gates.
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use taomni_plugin_api::{
    ErrorCode, RpcError,
    services::{
        FIXED_KEY_SERVICE, FixedKeyAction, FixedKeyId, FixedKeyRequest, MFA_DATA_KEY_ID,
        ServiceCapabilities,
    },
};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler, serve_stdio_with};
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRestoreLease};

#[derive(Default)]
struct Handler {
    echo_calls: AtomicUsize,
}
impl PluginHandler for Handler {
    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, RpcError> {
        if method == "service/probe"
            && let Some(echo) = params.as_ref().and_then(|params| params.get("echo"))
        {
            operation.check_current()?;
            return Ok(serde_json::json!({"echo": echo,
                "handled": self.echo_calls.fetch_add(1, Ordering::AcqRel) + 1,
                "hostInstance": operation.context().map(|context| context.host_instance.as_str())}));
        }
        let action = params
            .as_ref()
            .and_then(|params| params.get("action"))
            .cloned()
            .map(serde_json::from_value::<FixedKeyAction>)
            .transpose()
            .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?
            .unwrap_or(FixedKeyAction::Load);
        let key = operation.fixed_key(FixedKeyRequest {
            key_id: FixedKeyId::parse(MFA_DATA_KEY_ID).unwrap(),
            action,
        })?;
        if method == "service/crash" {
            std::process::exit(70);
        }
        if method == "service/wait" {
            loop {
                operation.check_current()?;
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let digest = key
            .as_ref()
            .map(|key| key.with_key(|key| format!("{:x}", Sha256::digest(key))))
            .transpose()?;
        Ok(serde_json::json!({"present":key.is_some(), "digest":digest,
            "hostInstance":operation.context().map(|context| context.host_instance.as_str())}))
    }
}

fn main() -> std::process::ExitCode {
    let config = HostConfig {
        plugin_id: "taomni-plugin-mfa".into(),
        plugin_version: "0.1.0".into(),
        commands: BTreeSet::from([
            "service/probe".into(),
            "service/wait".into(),
            "service/crash".into(),
        ]),
        permissions: BTreeSet::from([FIXED_KEY_SERVICE.into()]),
        required_services: ServiceCapabilities(std::collections::BTreeMap::from([(
            FIXED_KEY_SERVICE.into(),
            1,
        )])),
        optional_services: Default::default(),
        operation_timeout: Duration::from_secs(10),
        snapshot_timeout: Duration::from_secs(30),
    };
    let result = serve_stdio_with(config, |storage| {
        let storage = storage.expect("profile must be owned before handler/store initialization");
        assert!(ProfileRestoreLease::try_acquire(storage.root()).is_err());
        assert!(
            PluginDataLease::try_acquire(storage.root(), &PluginSlug::parse("mfa").unwrap())
                .is_err()
        );
        Ok(Arc::new(Handler::default()))
    });
    if result.is_ok() {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}
