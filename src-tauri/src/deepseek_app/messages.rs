use super::{
    client::MessagesClient,
    protocol::{self, Reply, SseDecoder},
    request::{self, Operation},
    runtime::RunGuard,
    store,
    types::{TaoEvent, TaoRequest, TaoResponse},
};
use crate::state::AppState;
use futures::StreamExt;
use serde_json::Value;
use tauri::ipc::Channel;

pub async fn run(
    request: TaoRequest,
    operation: Operation,
    channel: Channel<TaoEvent>,
    state: &AppState,
) -> Result<TaoResponse, String> {
    let run = RunGuard::begin(&request.thread_id)?;
    let client = MessagesClient::resolve_provider(state, &request.provider).await?;
    super::client::validate_request(&client.provider, &request)?;
    let (body, assistant_id, initial_blocks) = {
        let db = state.core.db.lock().map_err(|_| "database unavailable")?;
        store::init(&db)?;
        store::ensure_thread(&db, &request.thread_id)?;
        let history = store::messages(&db, &request.thread_id)?;
        let mut body = request::body(&request, &history, operation, client.title)?;
        // Only explicitly saved, enabled local entries are injected. Skills
        // are selected by trigger in memory::prompt; raw home files never enter
        // the prompt.
        if let Ok(extra) = super::memory::prompt(&db, &request.content) {
            if !extra.is_empty() {
                let system = body["system"].as_str().unwrap_or_default();
                body["system"] = Value::String(format!("{system}{extra}"));
            }
        }
        let feedback =
            super::action_feedback::resolve(&db, &request.thread_id, &request.action_feedback)?;
        if !feedback.is_empty() {
            body["messages"].as_array_mut().unwrap().last_mut().unwrap()["content"]
                .as_array_mut()
                .unwrap()
                .insert(0, serde_json::json!({"type":"text","text":feedback}));
        }
        let source_switches = super::search::sources(&db)?;
        for chip in &request.chips {
            if let Some(source) = chip["source"].as_str() {
                if source_switches.get(source) != Some(&true) {
                    return Err(
                        "protocol: a selected local source is disabled; remove its excerpt".into(),
                    );
                }
            }
        }
        store::save_request(&db, &request)?;
        let initial = if operation == Operation::Continue {
            history.last().map(|m| m.blocks.clone()).unwrap_or_default()
        } else {
            Vec::new()
        };
        let assistant_id = if operation == Operation::Continue {
            history
                .last()
                .ok_or("protocol: no reply to continue")?
                .id
                .clone()
        } else {
            if operation == Operation::Send {
                store::append_message(
                    &db,
                    &request.thread_id,
                    "user",
                    &request::user_blocks(&request)?,
                )?;
            }
            if operation == Operation::Regenerate {
                store::remove_last_assistant(&db, &request.thread_id)?;
            }
            store::append_message(&db, &request.thread_id, "assistant", &[])?
        };
        (body, assistant_id, initial)
    };
    let mut reply = Reply::default();
    // A continuation is one assistant message. Its prior blocks remain durable
    // even if the follow-up connection fails before delivering its first block.
    let previous = initial_blocks;
    let result = tokio::select! {
        biased;
        _=run.cancel.cancelled()=>Err(format!("{}: request cancelled",run.reason())),
        result=async {
            if client.provider.runtime == "opencode-go" {
                super::opencode::stream(&client,body,&request,&channel,&mut reply,state,&assistant_id,&previous).await
            } else if client.provider.runtime == "deepseek-messages" {
                stream(&client,body,&channel,&mut reply,state,&assistant_id,&previous).await
            } else {
                super::ordinary::stream(&client,body,&request,&channel,&mut reply,state,&assistant_id,&previous).await
            }
        }=>result,
    };
    let mut blocks = if reply.stop_reason.as_deref() == Some("refusal") {
        Vec::new()
    } else {
        previous
    };
    blocks.extend(
        reply
            .blocks
            .iter()
            .filter(|block| !block.is_null())
            .cloned(),
    );
    let (status, reason) = match &result {
        Ok(()) if reply.stop_reason.as_deref() == Some("refusal") => ("refusal", Some("refusal")),
        Ok(()) => ("complete", reply.stop_reason.as_deref()),
        Err(_) if run.cancel.is_cancelled() && run.reason() == "interrupted" => {
            ("stopped", Some("stopped"))
        }
        Err(_) => ("error", None),
    };
    if let Ok(db) = state.core.db.lock() {
        store::settle(&db, &assistant_id, &blocks, status, reason)?;
        store::sync_snapshot(&db, &request.thread_id, reply.title.as_deref())?;
    }
    if let Err(error) = result {
        let (category, message) = error.split_once(": ").unwrap_or(("network", &error));
        let _ = channel.send(protocol::error(category, message));
        let _ = channel.send(TaoEvent::new("message_stop"));
    }
    Ok(TaoResponse { events: Vec::new() })
}

async fn stream(
    client: &MessagesClient,
    body: Value,
    channel: &Channel<TaoEvent>,
    reply: &mut Reply,
    state: &AppState,
    assistant_id: &str,
    previous: &[Value],
) -> Result<(), String> {
    let body = super::request::without_attachment_owners(body);
    let response = client
        .post("/anthropic/v1/messages")
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("network: {}", safe_network_error(&error)))?;
    let status = response.status();
    if !status.is_success() {
        // Do not forward arbitrary provider bodies (may contain the key or
        // reflected private content). Status is sufficient for safe recovery.
        return Err(format!("http: DeepSeek returned HTTP {}", status.as_u16()));
    }
    let mut stream = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("network: {}", safe_network_error(&error)))?;
        for frame in decoder.push(&chunk)? {
            for event in reply.apply(frame) {
                if event.kind != "error" {
                    let _ = channel.send(event);
                }
            }
            let mut checkpoint = previous.to_vec();
            checkpoint.extend(
                reply
                    .blocks
                    .iter()
                    .filter(|block| !block.is_null())
                    .cloned(),
            );
            let db = state.core.db.lock().map_err(|_| "database unavailable")?;
            store::settle(
                &db,
                assistant_id,
                &checkpoint,
                "streaming",
                reply.stop_reason.as_deref(),
            )?;
            drop(db);
            if reply.errored {
                return Err("stream: provider interrupted the response".into());
            }
            if reply.stopped {
                return Ok(());
            }
        }
    }
    Err("interrupted: connection closed before message_stop".into())
}

fn safe_network_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "request timed out"
    } else if error.is_connect() {
        "connection or configured proxy failed"
    } else {
        "response stream could not be read"
    }
}
