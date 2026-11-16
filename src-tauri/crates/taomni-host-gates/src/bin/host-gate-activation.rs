//! Controlled activation failures for the production adapter's hosted gates.
//! The working directory is a test-owned temporary profile, never app data.
use std::io::{self, BufRead, Write};
use taomni_plugin_api::{
    ErrorCode, HandshakeRequest, HandshakeResponse, Heartbeat, RpcError, RpcMessage, RpcResponse,
    validate_token, validate_versions,
};

fn main() -> io::Result<()> {
    std::fs::write("activation.pid", std::process::id().to_string())?;
    let mode = std::fs::read_to_string("activation.mode")?;
    let token = std::env::var("TAOMNI_PLUGIN_TOKEN").map_err(io::Error::other)?;
    let mut events = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("activation.events")?;
    let mut stdout = io::stdout().lock();
    let mut authenticated = false;
    let mut enabled = false;
    for line in io::stdin().lock().lines() {
        let message: RpcMessage = serde_json::from_str(&line?).map_err(io::Error::other)?;
        let request = match message {
            RpcMessage::Request(request) => request,
            RpcMessage::Notification(notification) if notification.method == Heartbeat::METHOD => {
                serde_json::to_writer(&mut stdout, &RpcMessage::Notification(notification))?;
                stdout.write_all(b"\n")?;
                stdout.flush()?;
                continue;
            }
            _ => continue,
        };
        writeln!(events, "{}", request.method)?;
        events.flush()?;
        let result = if request.method == "plugin/handshake" {
            let handshake: HandshakeRequest =
                serde_json::from_value(request.params.unwrap_or_default())
                    .map_err(io::Error::other)?;
            validate_token(&token, &handshake.token)
                .and_then(|()| validate_versions(handshake.api_version, handshake.protocol_version))
                .map(|()| {
                    authenticated = true;
                    serde_json::to_value(HandshakeResponse::accepted(500)).unwrap()
                })
        } else if !authenticated {
            Err(RpcError::from_code(ErrorCode::InvalidState))
        } else if request.method == "plugin/enable" {
            match mode.as_str() {
                "reject" => Err(RpcError::new(
                    ErrorCode::InvalidState,
                    "activation rejected",
                )),
                "hang" => {
                    std::thread::sleep(std::time::Duration::from_secs(60));
                    continue;
                }
                _ => {
                    enabled = true;
                    Ok(serde_json::Value::Null)
                }
            }
        } else if request.method == "fixture/probe" {
            Ok(serde_json::json!({"enabled": enabled}))
        } else {
            Err(RpcError::from_code(ErrorCode::MethodNotFound))
        };
        let response = match result {
            Ok(value) => RpcResponse::success(request.id, value),
            Err(error) => RpcResponse::failure(Some(request.id), error),
        };
        serde_json::to_writer(&mut stdout, &RpcMessage::Response(response))?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}
