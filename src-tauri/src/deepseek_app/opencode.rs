//! Native Go transport and read-only tool loop. Write actions remain proposals
//! until the existing, separately confirmed action executor returns a result.
use super::{
    client::MessagesClient,
    protocol::{Reply, SseDecoder},
    types::{TaoEvent, TaoRequest},
};
use crate::state::AppState;
use futures::StreamExt;
use serde_json::{Value, json};
use tauri::ipc::Channel;

pub async fn stream(
    client: &MessagesClient,
    canonical: Value,
    request: &TaoRequest,
    channel: &Channel<TaoEvent>,
    reply: &mut Reply,
    state: &AppState,
    assistant_id: &str,
    previous: &[Value],
) -> Result<(), String> {
    let mut body = super::opencode_request::body(&canonical, request, state).await?;
    let _ = channel.send(TaoEvent::new("message_start").with("model", request.model.clone()));
    let mut seen = std::collections::HashMap::<String, usize>::new();
    loop {
        let response = client
            .http
            .post(format!("{}/chat/completions", client.base_url))
            .bearer_auth(&client.api_key)
            .header("x-opencode-session", &request.thread_id)
            .json(&body)
            .send()
            .await
            .map_err(|_| "network: OpenCode connection or configured proxy failed")?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            // A gateway/WAF 403 is not evidence that a temporary API key expired.
            if status == 403 {
                let data = response.bytes().await.unwrap_or_default();
                let text =
                    String::from_utf8_lossy(&data[..data.len().min(4000)]).to_ascii_lowercase();
                if ![
                    "invalid_api_key",
                    "authentication_error",
                    "key expired",
                    "invalid api key",
                ]
                .iter()
                .any(|s| text.contains(s))
                {
                    return Err("network: OpenCode gateway denied access; check provider/proxy connectivity".into());
                }
            }
            return Err(format!("http: OpenCode returned HTTP {status}"));
        }
        let mut stream = response.bytes_stream();
        let mut decoder = SseDecoder::default();
        let mut turn = super::opencode_stream::Turn::new(reply);
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|_| "network: OpenCode response stream could not be read")?;
            for value in decoder.push(&bytes)? {
                for event in turn.apply(value, reply)? {
                    let _ = channel.send(event);
                }
                checkpoint(state, assistant_id, reply, previous)?;
            }
            if turn.done {
                break;
            }
        }
        if !turn.finished {
            return Err(
                "interrupted: OpenCode connection closed before a completion reason".into(),
            );
        }
        if turn.calls.is_empty() {
            reply.stopped = true;
            let _ = channel.send(TaoEvent::new("message_stop"));
            return Ok(());
        }
        if reply.input_tokens + reply.output_tokens >= 10_000_000 {
            return Err("budget: turn token budget reached".into());
        }
        body["messages"]
            .as_array_mut()
            .unwrap()
            .push(turn.assistant());
        for call in turn.calls.values() {
            let name = call["function"]["name"].as_str().unwrap_or_default();
            let raw = call["function"]["arguments"].as_str().unwrap_or("{}");
            let args: Value =
                serde_json::from_str(raw).map_err(|_| "protocol: invalid tool arguments")?;
            let signature = format!("{name}:{raw}");
            let repeats = seen.entry(signature).or_default();
            *repeats += 1;
            if *repeats > 3 {
                return Err(
                    "protocol: repeated tool calls made no progress; revise the query".into(),
                );
            }
            let result = super::opencode_tools::execute(name, &args, request, state, client).await;
            let content = match result {
                Ok(result) => {
                    if !result.sources.is_empty() {
                        let index = reply.blocks.len();
                        let block = json!({"type":"local_context_result","content":result.sources});
                        for event in reply.apply(json!({"type":"content_block_start","index":index,"content_block":block})) { let _ = channel.send(event); }
                        let _ = channel.send(TaoEvent::new("block_stop").with("index", index));
                    }
                    if name == "web_search" {
                        reply.search_calls += 1;
                    }
                    if name == "read_url" {
                        reply.fetch_calls += 1;
                    }
                    result.content
                }
                Err(error) => json!({"error":error,"completed":false}),
            };
            body["messages"].as_array_mut().unwrap().push(
                json!({"role":"tool","tool_call_id":call["id"],"content":content.to_string()}),
            );
        }
        checkpoint(state, assistant_id, reply, previous)?;
        let _ = channel.send(TaoEvent::new("message_delta").with("usage", reply.usage_value()));
    }
}

pub(super) fn checkpoint(
    state: &AppState,
    id: &str,
    reply: &Reply,
    previous: &[Value],
) -> Result<(), String> {
    let mut blocks = previous.to_vec();
    blocks.extend(reply.blocks.iter().filter(|b| !b.is_null()).cloned());
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    super::store::settle(&db, id, &blocks, "streaming", reply.stop_reason.as_deref())
}
