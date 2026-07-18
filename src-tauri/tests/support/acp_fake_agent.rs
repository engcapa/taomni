use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::io::{self, BufRead, BufWriter, Write};
use std::path::{Path, PathBuf};

fn main() {
    let scenario = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "happy".to_string());
    let record_path = std::env::var_os("ACP_FAKE_RECORD").map(PathBuf::from);
    let stdin = io::stdin();
    let mut stdout = BufWriter::new(io::stdout().lock());
    let mut pending_prompt_id: Option<Value> = None;
    let mut first_extension_id: Option<Value> = None;

    eprintln!(r#"{{"api_key":"fake-runtime-secret"}}"#);

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        record_message(record_path.as_deref(), &message);

        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned();
        match method {
            Some("initialize") => {
                respond(
                    &mut stdout,
                    id,
                    json!({
                        "protocolVersion": 1,
                        "agentInfo": {
                            "name": "acp-fake-agent",
                            "title": "ACP Fake Agent",
                            "version": "1.0.0",
                        },
                        "agentCapabilities": {
                            "loadSession": true,
                            "mcpCapabilities": { "http": true, "sse": true },
                        },
                        "authMethods": [{ "id": "cached_token", "name": "Cached token" }],
                    }),
                );
                if scenario == "exit-after-initialize" {
                    return;
                }
            }
            Some("authenticate") => respond(&mut stdout, id, json!({})),
            Some("session/new") => respond(&mut stdout, id, json!({ "sessionId": "fake-session" })),
            Some("session/load") => {
                notify(
                    &mut stdout,
                    "session/update",
                    json!({
                        "sessionId": "fake-session",
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": { "type": "text", "text": "replayed answer" },
                        },
                        "_meta": { "isReplay": true },
                    }),
                );
                respond(&mut stdout, id, json!({}));
            }
            Some("session/prompt") if scenario == "wait-for-cancel" => {
                pending_prompt_id = id;
                notify(
                    &mut stdout,
                    "session/update",
                    json!({
                        "sessionId": "fake-session",
                        "update": { "sessionUpdate": "available_commands_update" },
                    }),
                );
            }
            Some("session/prompt") if scenario == "peer-request" => {
                pending_prompt_id = id;
                send(
                    &mut stdout,
                    json!({
                        "jsonrpc": "2.0",
                        "id": "peer-fs-1",
                        "method": "fs/read_text_file",
                        "params": { "path": "/forbidden" },
                    }),
                );
            }
            Some("session/prompt")
                if scenario == "permission-request" || scenario == "mcp-permission-request" =>
            {
                pending_prompt_id = id;
                let tool_call = if scenario == "mcp-permission-request" {
                    json!({
                        "toolCallId": "tool-permission-mcp-1",
                        "title": "taomni__run_in_terminal",
                        "kind": "execute",
                        "rawInput": { "command": "echo ok", "secret": "must-not-reach-ui" },
                    })
                } else {
                    json!({
                        "toolCallId": "tool-permission-1",
                        "title": "Write README.md",
                        "kind": "edit",
                        "rawInput": { "secret": "must-not-reach-ui" },
                    })
                };
                send(
                    &mut stdout,
                    json!({
                        "jsonrpc": "2.0",
                        "id": "permission-1",
                        "method": "session/request_permission",
                        "params": {
                            "sessionId": "fake-session",
                            "toolCall": tool_call,
                            "options": [
                                {
                                    "optionId": "allow-once",
                                    "name": "Allow once",
                                    "kind": "allow_once",
                                },
                                {
                                    "optionId": "reject-once",
                                    "name": "Deny",
                                    "kind": "reject_once",
                                },
                            ],
                        },
                    }),
                );
            }
            Some("session/prompt") => {
                if scenario == "malformed-then-valid" {
                    writeln!(stdout, "not-json").expect("write malformed fixture");
                    stdout.flush().expect("flush malformed fixture");
                }
                emit_happy_turn(&mut stdout);
                respond(
                    &mut stdout,
                    id,
                    json!({
                        "stopReason": "end_turn",
                        "_meta": {
                            "usage": {
                                "inputTokens": 10,
                                "outputTokens": 4,
                                "totalTokens": 14,
                                "numTurns": 1,
                            },
                        },
                    }),
                );
            }
            Some("session/cancel") => {
                if let Some(id) = pending_prompt_id.take() {
                    respond(&mut stdout, Some(id), json!({ "stopReason": "cancelled" }));
                }
            }
            Some("test/first") if scenario == "out-of-order" => {
                first_extension_id = id;
            }
            Some("test/second") if scenario == "out-of-order" => {
                respond(&mut stdout, id, json!({ "order": 2 }));
                respond(
                    &mut stdout,
                    first_extension_id.take(),
                    json!({ "order": 1 }),
                );
            }
            Some("test/hang") => {}
            None if message.get("id") == Some(&Value::String("peer-fs-1".into())) => {
                if let Some(id) = pending_prompt_id.take() {
                    respond(&mut stdout, Some(id), json!({ "stopReason": "end_turn" }));
                }
            }
            None if message.get("id") == Some(&Value::String("permission-1".into())) => {
                let selected = message
                    .get("result")
                    .and_then(|result| result.get("outcome"))
                    .and_then(|outcome| outcome.get("outcome"))
                    .and_then(Value::as_str);
                let option_id = message
                    .get("result")
                    .and_then(|result| result.get("outcome"))
                    .and_then(|outcome| outcome.get("optionId"))
                    .and_then(Value::as_str);
                let stop_reason = if selected == Some("selected") && option_id == Some("allow-once")
                {
                    "end_turn"
                } else {
                    "cancelled"
                };
                if let Some(id) = pending_prompt_id.take() {
                    respond(&mut stdout, Some(id), json!({ "stopReason": stop_reason }));
                }
            }
            _ => respond_error(&mut stdout, id, -32601, "fixture method not found"),
        }
    }
}

fn emit_happy_turn(stdout: &mut impl Write) {
    notify(
        stdout,
        "session/update",
        json!({
            "sessionId": "fake-session",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "Hello " },
            },
        }),
    );
    notify(
        stdout,
        "session/update",
        json!({
            "sessionId": "fake-session",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "tool-1",
                "title": "Inspect workspace",
                "rawInput": { "secret": "discarded-input" },
            },
        }),
    );
    notify(
        stdout,
        "session/update",
        json!({
            "sessionId": "fake-session",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "tool-1",
                "status": "completed",
                "rawOutput": { "secret": "discarded-output" },
            },
        }),
    );
    notify(
        stdout,
        "session/update",
        json!({
            "sessionId": "fake-session",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "world" },
            },
        }),
    );
    notify(
        stdout,
        "session/update",
        json!({
            "sessionId": "fake-session",
            "update": {
                "sessionUpdate": "usage_update",
                "used": 14,
                "size": 8192,
            },
        }),
    );
}

fn respond(stdout: &mut impl Write, id: Option<Value>, result: Value) {
    let Some(id) = id else { return };
    send(
        stdout,
        json!({ "jsonrpc": "2.0", "id": id, "result": result }),
    );
}

fn respond_error(stdout: &mut impl Write, id: Option<Value>, code: i64, message: &str) {
    let Some(id) = id else { return };
    send(
        stdout,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }),
    );
}

fn notify(stdout: &mut impl Write, method: &str, params: Value) {
    send(
        stdout,
        json!({ "jsonrpc": "2.0", "method": method, "params": params }),
    );
}

fn send(stdout: &mut impl Write, value: Value) {
    serde_json::to_writer(&mut *stdout, &value).expect("serialize ACP fixture message");
    writeln!(stdout).expect("terminate ACP fixture message");
    stdout.flush().expect("flush ACP fixture message");
}

fn record_message(path: Option<&Path>, message: &Value) {
    let Some(path) = path else { return };
    let record = json!({
        "method": message.get("method"),
        "id": message.get("id"),
        "httpProxy": std::env::var("HTTP_PROXY").ok(),
        "httpsProxy": std::env::var("HTTPS_PROXY").ok(),
        "allProxy": std::env::var("ALL_PROXY").ok(),
        "noProxy": std::env::var("NO_PROXY").ok(),
        "httpProxyLower": std::env::var("http_proxy").ok(),
        "httpsProxyLower": std::env::var("https_proxy").ok(),
        "allProxyLower": std::env::var("all_proxy").ok(),
        "noProxyLower": std::env::var("no_proxy").ok(),
    });
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = serde_json::to_writer(&mut file, &record);
        let _ = writeln!(file);
    }
}
