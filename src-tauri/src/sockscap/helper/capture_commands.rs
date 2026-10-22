use super::model::CaptureStartArgs;
use super::registry::HelperSession;
use super::requests::expect_ok;
use super::requests::send_json;
use super::requests::send_json_timeout;
use serde_json::json;
use std::time::Duration;

pub fn capture_start(
    sess: &HelperSession,
    args: &CaptureStartArgs,
) -> Result<serde_json::Value, String> {
    let endpoints: Vec<serde_json::Value> = args
        .bypass_endpoints
        .iter()
        .map(|(ip, port)| json!({ "ip": ip, "port": port }))
        .collect();
    let body = json!({
        "cmd": "capture_start",
        "mode": if args.mode_apps { "apps" } else { "global" },
        "appPaths": args.app_paths,
        "bypassCidrs": args.bypass_cidrs,
        "bypassPids": args.bypass_pids,
        "bypassPaths": args.bypass_paths,
        "bypassEndpoints": endpoints,
        "relayIp": args.relay_ip,
        "relayPort": args.relay_port,
        "blockQuic": args.block_quic,
    });
    expect_ok(send_json(sess, body)?)
}

pub fn capture_stop(sess: &HelperSession) -> Result<(), String> {
    // Helper joins divert threads after WinDivertClose; keep client wait short
    // so Stop never hangs the UI for the full 15s RPC default.
    let _ = expect_ok(send_json_timeout(
        sess,
        json!({ "cmd": "capture_stop" }),
        Duration::from_secs(3),
    )?)?;
    Ok(())
}

/// Hot-swap the relay port on the running capture session.
/// Does not restart WinDivert — takes effect on the next intercepted packet.
pub fn capture_update_relay(
    sess: &HelperSession,
    relay_port: u16,
) -> Result<serde_json::Value, String> {
    expect_ok(send_json(
        sess,
        json!({ "cmd": "capture_update", "relayPort": relay_port }),
    )?)
}

/// Replace the running session's bypass lists.
///
/// Needed because the set of processes that must never be captured is not fixed
/// at start: an xray core that crashes is respawned with a **new pid**, and a
/// local proxy can be restarted by the user. Until the helper learns the new
/// pid, that process's connection to its remote node is captured and reflected
/// back into the relay, which dials the core's own inbound — a loop that wedges
/// all proxied traffic.
pub fn capture_update_bypass(
    sess: &HelperSession,
    bypass_pids: &[u32],
    bypass_paths: &[String],
) -> Result<serde_json::Value, String> {
    expect_ok(send_json(
        sess,
        json!({
            "cmd": "capture_update",
            "bypassPids": bypass_pids,
            "bypassPaths": bypass_paths,
        }),
    )?)
}
