//! Standard configured LLM adapters retain Tao's run, history, approval and
//! cancellation owners. Only protocol conversion and stream decoding live here.
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
    let messages = super::opencode_request::messages(&canonical, request, state).await?;
    let anthropic = client.provider.runtime == "anthropic";
    let responses = client.provider.runtime == "openai-responses";
    let (endpoint, mut body) = if responses {
        (
            "/responses",
            super::ordinary_responses::body(&messages, &request.model)?,
        )
    } else {
        wire_body(&messages, &request.model, anthropic)?
    };
    if let Some(model) = client.provider.custom_model(&request.model)? {
        if !model.multimodal
            && messages.iter().any(|message| {
                message["content"]
                    .as_array()
                    .is_some_and(|parts| parts.iter().any(|part| part["type"] == "image_url"))
            })
        {
            return Err("configuration: this model does not support image input".into());
        }
        model.apply_request_options(
            &client.provider.runtime,
            &mut body,
            model.max_output_tokens,
            request
                .thinking
                .then_some(request.reasoning_effort.as_str()),
            request.web,
        );
    }
    let builder = if anthropic {
        client.post(endpoint)
    } else {
        let builder = client.http.post(format!("{}{endpoint}", client.base_url));
        if client.api_key.is_empty() {
            builder
        } else {
            builder.bearer_auth(&client.api_key)
        }
    };
    let response = builder
        .json(&body)
        .send()
        .await
        .map_err(|_| "network: provider connection or configured proxy failed")?;
    if !response.status().is_success() {
        return Err(super::provider_error::describe(response, &client.api_key).await);
    }
    if !anthropic {
        let _ = channel.send(TaoEvent::new("message_start").with("model", request.model.clone()));
    }
    let mut stream = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut turn = super::opencode_stream::Turn::new(reply);
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|_| "network: provider response stream could not be read")?;
        for value in decoder.push(&bytes)? {
            let events = if anthropic {
                reply.apply(value)
            } else if responses {
                super::ordinary_responses::apply(value, &mut turn, reply)?
            } else {
                turn.apply(value, reply)?
            };
            for event in events {
                if event.kind != "error" {
                    let _ = channel.send(event);
                }
            }
            super::opencode::checkpoint(state, assistant_id, reply, previous)?;
            if reply.errored {
                return Err("stream: provider interrupted the response".into());
            }
            if anthropic && reply.stopped {
                return Ok(());
            }
        }
        if !anthropic && turn.done {
            break;
        }
    }
    if anthropic || !turn.finished {
        return Err("interrupted: provider connection closed before completion".into());
    }
    if !turn.calls.is_empty() {
        return Err("protocol: unexpected tool calls; use Tao action proposals".into());
    }
    reply.stopped = true;
    let _ = channel.send(TaoEvent::new("message_stop"));
    Ok(())
}

fn wire_body(
    messages: &[Value],
    model: &str,
    anthropic: bool,
) -> Result<(&'static str, Value), String> {
    if !anthropic {
        return Ok((
            "/chat/completions",
            json!({"model":model,"messages":messages,
            "stream":true,"stream_options":{"include_usage":true},"max_tokens":8192}),
        ));
    }
    let mut body = json!({"model":model,"stream":true,"max_tokens":8192,"messages":[]});
    for message in messages {
        if message["role"] == "system" {
            body["system"] = message["content"].clone();
            continue;
        }
        let mut content = Vec::new();
        for part in message["content"]
            .as_array()
            .ok_or("protocol: invalid chat content")?
        {
            match part["type"].as_str() {
                Some("text") => content.push(part.clone()),
                Some("image_url") => {
                    let image = part["image_url"]["url"]
                        .as_str()
                        .ok_or("protocol: invalid image")?;
                    let (prefix, data) = image
                        .split_once(',')
                        .ok_or("protocol: image data missing")?;
                    let mime = prefix
                        .strip_prefix("data:")
                        .and_then(|s| s.strip_suffix(";base64"))
                        .filter(|s| s.starts_with("image/"))
                        .ok_or("protocol: invalid image type")?;
                    content.push(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}}));
                }
                _ => return Err("protocol: unsupported chat content".into()),
            }
        }
        body["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":message["role"],"content":content}));
    }
    Ok(("/messages", body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_model_and_real_image_parts_reach_both_protocols_without_tao_only_flags() {
        let messages = vec![
            json!({"role":"system","content":"Bound tools and approval policy"}),
            json!({"role":"user","content":[{"type":"text","text":"Question"},
                {"type":"image_url","image_url":{"url":"data:image/png;base64,YnlyZXM="}}]}),
        ];
        for anthropic in [false, true] {
            let (endpoint, body) = wire_body(&messages, "configured-model/v2", anthropic).unwrap();
            assert_eq!(body["model"], "configured-model/v2");
            for field in [
                "thinking",
                "reasoning_effort",
                "tools",
                "title",
                "safety_check",
            ] {
                assert!(body.get(field).is_none());
            }
            if anthropic {
                assert_eq!(endpoint, "/messages");
                assert_eq!(body["system"], messages[0]["content"]);
                assert_eq!(
                    body["messages"][0]["content"][1]["source"]["data"],
                    "YnlyZXM="
                );
                assert_eq!(
                    body["messages"][0]["content"][1]["source"]["media_type"],
                    "image/png"
                );
            } else {
                assert_eq!(endpoint, "/chat/completions");
                assert_eq!(body["messages"], json!(messages));
            }
        }
    }

    #[test]
    fn anthropic_never_converts_remote_urls_to_implicit_image_fetches() {
        assert!(wire_body(&[json!({"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.invalid/private"}}]})], "model", true).is_err());
    }
}
