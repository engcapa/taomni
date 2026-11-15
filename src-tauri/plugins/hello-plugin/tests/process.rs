use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::json;
use taomni_hello_plugin::{
    DISABLE_METHOD, ENABLE_METHOD, HANDSHAKE_METHOD, HANG_METHOD, PING_METHOD, PLUGIN_ID,
    PLUGIN_VERSION,
};
use taomni_plugin_api::{HandshakeRequest, RequestId, RpcMessage, RpcRequest, RpcResponse};

const TOKEN: &str = "process-test-token";

fn spawn(hang_ms: Option<&str>) -> (Child, ChildStdin, BufReader<std::process::ChildStdout>) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_taomni-hello-plugin"));
    command
        .env("TAOMNI_PLUGIN_TOKEN", TOKEN)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if let Some(hang_ms) = hang_ms {
        command.env("TAOMNI_HELLO_HANG_MS", hang_ms);
    }
    let mut child = command.spawn().expect("spawn hello-plugin");
    let stdin = child.stdin.take().expect("hello-plugin stdin");
    let stdout = BufReader::new(child.stdout.take().expect("hello-plugin stdout"));
    (child, stdin, stdout)
}

fn send(stdin: &mut ChildStdin, request: &RpcRequest) {
    serde_json::to_writer(&mut *stdin, &RpcMessage::Request(request.clone())).unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.flush().unwrap();
}

fn response(stdout: &mut impl BufRead) -> RpcResponse {
    let mut line = String::new();
    stdout.read_line(&mut line).expect("hello-plugin response");
    assert!(!line.is_empty(), "hello-plugin exited before response");
    match serde_json::from_str::<RpcMessage>(&line).unwrap() {
        RpcMessage::Response(response) => response,
        other => panic!("expected response, got {other:?}"),
    }
}

fn handshake_request() -> RpcRequest {
    RpcRequest::new(
        RequestId::from("handshake"),
        HANDSHAKE_METHOD,
        Some(
            serde_json::to_value(HandshakeRequest::new(
                PLUGIN_ID,
                PLUGIN_VERSION,
                TOKEN,
                vec![
                    PING_METHOD.into(),
                    ENABLE_METHOD.into(),
                    DISABLE_METHOD.into(),
                ],
                vec![],
            ))
            .unwrap(),
        ),
    )
}

#[test]
fn process_handshakes_and_changes_enable_state() {
    let (mut child, mut stdin, mut stdout) = spawn(None);
    send(&mut stdin, &handshake_request());
    assert!(response(&mut stdout).result.unwrap()["accepted"] == true);

    send(&mut stdin, &RpcRequest::new("enable", ENABLE_METHOD, None));
    assert_eq!(response(&mut stdout).result.unwrap()["enabled"], true);
    send(&mut stdin, &RpcRequest::new("ping", PING_METHOD, None));
    assert_eq!(response(&mut stdout).result.unwrap()["enabled"], true);
    send(
        &mut stdin,
        &RpcRequest::new("disable", DISABLE_METHOD, None),
    );
    assert_eq!(response(&mut stdout).result.unwrap()["enabled"], false);

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn process_hang_can_be_killed_after_supervisor_timeout() {
    let (mut child, mut stdin, mut stdout) = spawn(Some("5000"));
    send(&mut stdin, &handshake_request());
    assert!(response(&mut stdout).result.unwrap()["accepted"] == true);
    send(
        &mut stdin,
        &RpcRequest::new("hang", HANG_METHOD, Some(json!({}))),
    );
    let deadline = Instant::now() + Duration::from_millis(200);
    while Instant::now() < deadline {
        assert!(child.try_wait().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(10));
    }
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
}
