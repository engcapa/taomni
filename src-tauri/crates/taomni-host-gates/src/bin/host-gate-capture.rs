//! Real SDK/stdio receiver; screen pixels originate in the core gate's source.
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
use taomni_plugin_api::{RpcError, services::*};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler, serve_stdio};

struct Handler;
impl PluginHandler for Handler {
    fn invoke(
        &self,
        operation: &Operation,
        _: &str,
        _: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, RpcError> {
        let bytes = operation.capture_still()?;
        Ok(serde_json::json!({
            "bytes": bytes.len(), "sha256": format!("{:x}", Sha256::digest(&bytes)),
            "frames": u32::from_le_bytes(bytes[4..8].try_into().expect("validated TQF1")),
            "hostInstance": operation.context().map(|context| context.host_instance.as_str()),
        }))
    }
}

fn main() -> std::process::ExitCode {
    let result = serve_stdio(
        HostConfig {
            plugin_id: "taomni-plugin-capture-gate".into(),
            plugin_version: "0.1.0".into(),
            commands: BTreeSet::from(["capture/probe".into()]),
            permissions: BTreeSet::from([CAPTURE_SCREEN_PERMISSION.into()]),
            required_services: ServiceCapabilities(BTreeMap::from([(
                CAPTURE_STILL_SERVICE.into(),
                1,
            )])),
            optional_services: Default::default(),
            operation_timeout: Duration::from_secs(10),
            snapshot_timeout: Duration::from_secs(30),
        },
        Arc::new(Handler),
    );
    if result.is_ok() {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}
