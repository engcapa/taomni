use std::{io, path::Path, sync::Arc, time::Duration};

use serde_json::{Value, json};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_sockscap_api::{XRAY_FILE, XRAY_RUN_DIR, XrayProcesses, XrayRequest};
use taomni_sockscap_xray::XrayManager;
use tokio::runtime::Runtime;

pub(super) fn open(profile: &Path) -> io::Result<Arc<XrayManager>> {
    let host = std::env::current_exe()?;
    let version = host
        .parent()
        .ok_or_else(|| io::Error::other("Missing SocksCap version path"))?;
    let executable = version.join("resources/xray").join(XRAY_FILE);
    Ok(Arc::new(XrayManager::packaged(
        executable,
        profile.join(XRAY_RUN_DIR),
    )))
}

pub(super) fn invoke(
    runtime: &Runtime,
    xray: &Arc<XrayManager>,
    operation: &Operation,
    params: Value,
) -> Result<Value, RpcError> {
    let request = serde_json::from_value(params)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    runtime.block_on(operation.while_current(async {
        match request {
            XrayRequest::Ensure { profile, spec } => {
                let port = xray
                    .ensure(&profile, &spec)
                    .await
                    .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
                xray.start_monitor(Duration::from_secs(5));
                Ok(json!(port))
            }
            XrayRequest::Remove { profile } => {
                xray.remove(&profile).await;
                Ok(Value::Null)
            }
            XrayRequest::State => Ok(json!(XrayProcesses {
                host: std::process::id(),
                children: xray.pids().await,
            })),
            XrayRequest::Stop => {
                xray.shutdown_all().await;
                Ok(Value::Null)
            }
        }
    }))?
}
