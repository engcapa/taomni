#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::io::{self, BufRead, Write};
use std::process::ExitCode;
use std::thread;

use serde_json::Value;
use taomni_hello_plugin::{DispatchOutcome, HANDSHAKE_METHOD, HelloPlugin, PluginFailure};
use taomni_plugin_api::{
    ErrorCode, HandshakeRequest, Heartbeat, RpcError, RpcMessage, RpcResponse,
};
use taomni_plugin_sdk::{HostStorage, confirm_profile_handshake};

fn error_response(id: Option<taomni_plugin_api::RequestId>, code: ErrorCode) -> RpcMessage {
    RpcMessage::Response(RpcResponse::failure(
        Some(id.unwrap_or_else(|| "notification".into())),
        RpcError::from_code(code),
    ))
}

fn write_message(stdout: &mut impl Write, message: &RpcMessage) -> io::Result<()> {
    serde_json::to_writer(&mut *stdout, message).map_err(io::Error::other)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn run() -> io::Result<i32> {
    let expected_token = std::env::var("TAOMNI_PLUGIN_TOKEN").map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "TAOMNI_PLUGIN_TOKEN is required",
        )
    })?;
    let storage = HostStorage::from_environment(taomni_hello_plugin::PLUGIN_ID)?;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut plugin = HelloPlugin::new();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let message: RpcMessage = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(_) => {
                write_message(&mut stdout, &error_response(None, ErrorCode::ParseError))?;
                continue;
            }
        };
        let request = match message {
            RpcMessage::Notification(notification) if notification.method == Heartbeat::METHOD => {
                // Echo the typed heartbeat after protocol validation. The core
                // measures liveness with its own monotonic receive clock.
                if let Some(params) = notification.params {
                    if serde_json::from_value::<Heartbeat>(params.clone()).is_ok() {
                        write_message(
                            &mut stdout,
                            &RpcMessage::Notification(taomni_plugin_api::RpcNotification::new(
                                Heartbeat::METHOD,
                                Some(params),
                            )),
                        )?;
                    }
                }
                continue;
            }
            RpcMessage::Request(request) => request,
            _ => continue,
        };

        if request.method == HANDSHAKE_METHOD {
            let params = request.params.unwrap_or(Value::Null);
            let response = serde_json::from_value::<HandshakeRequest>(params)
                .map_err(|error| RpcError::new(ErrorCode::InvalidParams, error.to_string()))
                .and_then(|handshake| {
                    let profile =
                        confirm_profile_handshake(storage.as_ref(), handshake.profile.as_ref())?;
                    let mut response = plugin.accept_handshake(&handshake, &expected_token)?;
                    response.profile = profile;
                    Ok(response)
                });
            let response = match response {
                Ok(response) => RpcResponse::success(
                    request.id,
                    serde_json::to_value(response).expect("handshake response is serializable"),
                ),
                Err(error) => RpcResponse::failure(Some(request.id), error),
            };
            write_message(&mut stdout, &RpcMessage::Response(response))?;
            continue;
        }

        match plugin.dispatch(&request) {
            DispatchOutcome::Response(value) => {
                write_message(
                    &mut stdout,
                    &RpcMessage::Response(RpcResponse::success(request.id, value)),
                )?;
            }
            DispatchOutcome::Failure(PluginFailure::Rpc(code)) => {
                write_message(&mut stdout, &error_response(Some(request.id), code))?;
            }
            DispatchOutcome::Failure(PluginFailure::Crash) => return Ok(70),
            DispatchOutcome::Failure(PluginFailure::Timeout) => {
                thread::sleep(HelloPlugin::hang_duration());
            }
        }
    }
    Ok(0)
}

fn main() -> ExitCode {
    if std::env::var_os(taomni_plugin_api::services::HOST_PROFILE_ENV).is_some() {
        return match taomni_hello_plugin::serve_profiled() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("hello-plugin: {error}");
                ExitCode::FAILURE
            }
        };
    }
    match run() {
        Ok(code) => ExitCode::from(code as u8),
        Err(error) => {
            eprintln!("hello-plugin: {error}");
            ExitCode::from(1)
        }
    }
}
