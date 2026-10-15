//! Stateless HTTP transports; shared clients are owned by the Go dispatcher.
use super::{google, responses};
use crate::llm::{ChatRequest, ChatResponse, ChatStreamEvent, ChatTool, Llm, LlmError, LlmResult};
use async_trait::async_trait;
use futures::{StreamExt, stream::BoxStream};
use reqwest::{Client, header::HeaderMap};
use serde_json::Value;

fn take_sse_frame(buffer: &mut Vec<u8>) -> Option<String> {
    let lf = buffer.windows(2).position(|w| w == b"\n\n").map(|p| (p,2));
    let crlf = buffer.windows(4).position(|w| w == b"\r\n\r\n").map(|p| (p,4));
    let (index, delimiter) = match (lf,crlf) {
        (Some(a),Some(b)) => if a.0 < b.0 { a } else { b },
        (Some(a),None) => a,
        (None,Some(b)) => b,
        _ => return None,
    };
    let block = String::from_utf8_lossy(&buffer[..index]).into_owned();
    buffer.drain(..index+delimiter);
    Some(block)
}

pub struct MappedProvider {
    pub client: Client,
    pub base: String,
    pub key: String,
    pub model: String,
    pub headers: HeaderMap,
    pub google: bool,
}
impl MappedProvider {
    fn url(&self, stream: bool) -> LlmResult<String> {
        if !self.google { return Ok(format!("{}/responses", self.base.trim_end_matches('/'))); }
        // Model ids are a single URL segment, never a user-supplied path.
        let mut url = reqwest::Url::parse(&format!("{}/models/", self.base.trim_end_matches('/')))
            .map_err(|e| LlmError::Provider { status:400,message:e.to_string() })?;
        url.path_segments_mut().map_err(|_| LlmError::Provider { status:400,message:"Invalid Google base URL".into() })?
            .pop_if_empty().push(&format!("{}:{}", self.model, if stream {"streamGenerateContent"} else {"generateContent"}));
        if stream { url.set_query(Some("alt=sse")); }
        Ok(url.to_string())
    }
    async fn send(&self, req: &ChatRequest, tools: &[ChatTool], stream: bool) -> LlmResult<reqwest::Response> {
        let body = if self.google { google::request_body(req,tools) } else { responses::request_body(&self.model,req,tools,stream) };
        let builder = self.client.post(self.url(stream)?).headers(self.headers.clone()).json(&body);
        let builder = if self.google { builder.header("x-goog-api-key", &self.key) } else { builder.bearer_auth(&self.key) };
        let response = builder.send().await?;
        if !response.status().is_success() {
            return Err(LlmError::Provider { status:response.status().as_u16(),message:response.text().await.unwrap_or_default() });
        }
        Ok(response)
    }
}
#[async_trait]
impl Llm for MappedProvider {
    async fn chat(&self, req: ChatRequest) -> LlmResult<ChatResponse> { self.chat_with_tools(req,vec![]).await }
    async fn chat_with_tools(&self, req: ChatRequest, tools: Vec<ChatTool>) -> LlmResult<ChatResponse> {
        let value: Value = self.send(&req,&tools,false).await?.json().await?;
        let blocked_candidate = value["candidates"].as_array().is_some_and(|candidates|
            candidates.iter().any(|candidate| candidate["finishReason"].as_str()
                .is_some_and(|reason| !matches!(reason,"STOP"|"MAX_TOKENS"))));
        if value.get("error").is_some() || matches!(value["status"].as_str(), Some("failed" | "incomplete"))
            || value["promptFeedback"]["blockReason"].is_string() || blocked_candidate {
            return Err(LlmError::Provider { status:400,message:value.to_string() });
        }
        if self.google { google::parse(&value) } else { responses::parse(&value) }
    }
    async fn chat_stream(&self, req: ChatRequest) -> LlmResult<BoxStream<'static,LlmResult<ChatStreamEvent>>> {
        let response = self.send(&req,&[],true).await?;
        let google = self.google;
        let model = self.model.clone();
        Ok(Box::pin(async_stream::try_stream! {
            let mut bytes = Box::pin(response.bytes_stream());
            let mut buffer = Vec::new();
            let mut usage = None;
            let mut finished = false;
            let mut tool_arguments = std::collections::HashMap::<String,String>::new();
            while let Some(chunk) = bytes.next().await {
                buffer.extend_from_slice(&chunk?);
                // Buffer raw bytes so a UTF-8 character split across chunks is intact.
                while let Some(block) = take_sse_frame(&mut buffer) {
                    let data = block.lines().filter_map(|line| line.strip_prefix("data:").map(str::trim)).collect::<Vec<_>>().join("\n");
                    if data.is_empty() || data == "[DONE]" { continue; }
                    let value: Value = match serde_json::from_str(&data) {
                        Ok(v) => v,
                        Err(e) => { yield ChatStreamEvent::Error { message:format!("Invalid SSE JSON: {e}") }; return; }
                    };
                    if google {
                        if value.get("error").is_some() || value["promptFeedback"]["blockReason"].is_string() {
                            yield ChatStreamEvent::Error { message:value.to_string() }; return;
                        }
                        let parsed = google::parse(&value)?;
                        if !parsed.content.is_empty() { yield ChatStreamEvent::Token { content:parsed.content }; }
                        if parsed.usage.is_some() { usage = parsed.usage; }
                        if let Some(reason) = value["candidates"][0]["finishReason"].as_str() {
                            finished = true;
                            if !matches!(reason, "STOP" | "MAX_TOKENS") {
                                yield ChatStreamEvent::Error { message:value.to_string() }; return;
                            }
                        }
                    } else if value["type"] == "response.function_call_arguments.delta" {
                        tool_arguments.entry(value["item_id"].as_str().unwrap_or_default().into())
                            .or_default().push_str(value["delta"].as_str().unwrap_or_default());
                    } else if let Some(event) = responses::event(&value) {
                        let terminal = matches!(&event, ChatStreamEvent::End {..} | ChatStreamEvent::Error {..});
                        yield event;
                        if terminal { return; }
                    }
                }
            }
            if google && finished { yield ChatStreamEvent::End { model:Some(model), usage }; }
            else { yield ChatStreamEvent::Error { message:"Stream ended without a completion event".into() }; }
        }))
    }
    fn supports_tools(&self) -> bool { true }
    fn provider_id(&self) -> &str { "opencode-go" }
    fn model(&self) -> &str { &self.model }
}

#[cfg(test)]
mod tests {
    use super::take_sse_frame;
    #[test]
    fn sse_handles_fragmented_utf8_and_mixed_delimiters_in_order() {
        let event = "data: {\"delta\":\"你好\"}\r\n\r\n".as_bytes();
        let split = "data: {\"delta\":\"".len()+1; // inside the first UTF-8 character
        let mut buffer = event[..split].to_vec();
        assert!(take_sse_frame(&mut buffer).is_none());
        buffer.extend_from_slice(&event[split..]);
        buffer.extend_from_slice(b"data: second\n\n");
        assert_eq!(take_sse_frame(&mut buffer).as_deref(),Some("data: {\"delta\":\"你好\"}"));
        assert_eq!(take_sse_frame(&mut buffer).as_deref(),Some("data: second"));
        assert!(buffer.is_empty());
    }
}
