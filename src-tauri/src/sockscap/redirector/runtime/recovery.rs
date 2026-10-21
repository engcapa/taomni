use super::bridge::SocketCleanup;
use super::bridge::bind_private_listener;
use super::bridge::launch_bridge;
use super::bridge::random_socket_path;
use super::bridge::stop_bridge;
use crate::sockscap::redirector::installed_executable_path;
use crate::sockscap::redirector::scope::inert_actions;
use std::net::SocketAddr;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

/// Reacquire Redirector control after an unclean shutdown and replace any
/// residual process scope with a fresh inert sentinel. No business scope or
/// relay context is constructed on this path.
pub async fn recover() -> Result<(), String> {
    super::super::verify_installed()?;
    match super::super::installer::system_extension_state() {
        super::super::installer::RedirectorSystemExtensionState::WaitingForUser => {
            return Err(
                "Mitmproxy Redirector System Extension approval is pending in System Settings. Approve it first, then retry Recover."
                    .into(),
            );
        }
        super::super::installer::RedirectorSystemExtensionState::Enabled
        | super::super::installer::RedirectorSystemExtensionState::NotRegistered
        | super::super::installer::RedirectorSystemExtensionState::Other
        | super::super::installer::RedirectorSystemExtensionState::Unavailable => {}
    }
    let flow_socket_path = random_socket_path("recovery-flow");
    let provider_socket_path = random_socket_path("recovery-provider");
    let listener = bind_private_listener(&flow_socket_path)?;
    let cleanup = SocketCleanup(flow_socket_path.clone());
    let mut bridge = launch_bridge(
        &installed_executable_path(),
        &provider_socket_path,
        &flow_socket_path,
        &inert_actions(),
        &uuid::Uuid::new_v4().to_string(),
    )
    .await
    .map_err(|error| error.to_string())?;
    stop_bridge(&mut bridge).await?;
    drop(listener);
    drop(cleanup);
    // Applying and then stopping the bridge both write the inert scope through
    // the verified Provider control channel. That is the same completion
    // boundary used by a normal Stop. A public TCP endpoint is only a useful
    // post-condition diagnostic: the host may be offline, behind a captive
    // portal, or on a network that blocks the fixed probe addresses. Do not
    // turn those unrelated conditions into a permanently dirty journal.
    if let Some(error) =
        connectivity_probe_warning(verify_direct_connectivity_after_recovery().await)
    {
        tracing::warn!(
            %error,
            "sockscap: Redirector inert recovery succeeded; direct TCP probe was inconclusive"
        );
    }
    tracing::info!(
        provider_pid = bridge.provider_pid,
        "sockscap: Redirector recovery inert scope applied"
    );
    Ok(())
}

pub(super) fn connectivity_probe_warning(result: Result<(), String>) -> Option<String> {
    result.err()
}

pub(super) async fn verify_direct_connectivity_after_recovery() -> Result<(), String> {
    let targets = recovery_probe_targets()?;
    let mut errors = Vec::new();
    for target in targets {
        let status = tokio::time::timeout(
            Duration::from_secs(8),
            Command::new("/usr/bin/nc")
                .args(["-z", "-G", "5", "-w", "5"])
                .arg(target.ip().to_string())
                .arg(target.port().to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .output(),
        )
        .await;
        match status {
            Ok(Ok(output)) if output.status.success() => {
                tracing::info!(%target, probe = "/usr/bin/nc", "sockscap: post-recovery direct TCP probe succeeded");
                return Ok(());
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let detail = stderr.trim();
                errors.push(if detail.is_empty() {
                    format!("{target}: nc exited with {}", output.status)
                } else {
                    format!("{target}: {detail}")
                });
            }
            Ok(Err(error)) => errors.push(format!("{target}: launch /usr/bin/nc: {error}")),
            Err(_) => errors.push(format!("{target}: probe timed out")),
        }
    }
    Err(format!(
        "an independent /usr/bin/nc process could not verify ordinary TCP connectivity after the Redirector inert scope was applied ({}). The host may be offline or the probe targets may be blocked; SOCKSCAP_RECOVERY_PROBE_ADDR can override them for diagnostics",
        errors.join("; ")
    ))
}

pub(super) fn recovery_probe_targets() -> Result<Vec<SocketAddr>, String> {
    let configured = std::env::var("SOCKSCAP_RECOVERY_PROBE_ADDR")
        .unwrap_or_else(|_| "1.1.1.1:443,8.8.8.8:443".into());
    parse_recovery_probe_targets(&configured)
}

pub(super) fn parse_recovery_probe_targets(configured: &str) -> Result<Vec<SocketAddr>, String> {
    let targets = configured
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value.parse::<SocketAddr>().map_err(|_| {
                format!(
                    "invalid SOCKSCAP_RECOVERY_PROBE_ADDR target {value:?}; expected numeric IP:port"
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if targets.is_empty() {
        return Err("SOCKSCAP_RECOVERY_PROBE_ADDR has no targets".into());
    }
    Ok(targets)
}
