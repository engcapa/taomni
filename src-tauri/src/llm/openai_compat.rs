use super::{ChatRequest, ChatResponse, ChatStreamEvent, Llm, LlmError, LlmResult, TokenUsage};
use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Provider capabilities — enables router-level decisions like "do we
/// register a client-side `web_search` tool, or trust the provider's
/// native one?". Filled by `OpenAiCompatProvider::preset` and exposed via
/// `Llm::caps()`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ProviderCaps {
    pub native_web_search: bool,
    pub native_search_implicit: bool,
    pub citation_format: &'static str,
}

impl ProviderCaps {
    pub fn for_provider(id: &str) -> Self {
        match id {
            "openai" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "openai_annotations",
            },
            "anthropic" | "claude" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "anthropic_cited_text",
            },
            "gemini" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "gemini_grounding",
            },
            "grok" | "xai" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "grok_citations",
            },
            "mistral" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "mistral_sources",
            },
            "glm" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "glm_web_search",
            },
            "qwen" | "dashscope" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "qwen_search_results",
            },
            "perplexity" | "sonar" => Self {
                native_web_search: true,
                native_search_implicit: true, // searches every call
                citation_format: "perplexity_citations",
            },
            // DeepSeek, Groq, Cerebras, SiliconFlow, local — no native search.
            _ => Self::default(),
        }
    }
}

/// Covers DeepSeek, GLM, SiliconFlow, Groq, Cerebras, Mistral, OpenAI, and any
/// other provider that speaks the OpenAI chat completions API.
pub struct OpenAiCompatProvider {
    client: Client,
    base_url: String,
    api_key: String,
    model: String,
    provider_id: String,
}

impl OpenAiCompatProvider {
    pub fn new(
        provider_id: impl Into<String>,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("failed to build reqwest client"),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            model: model.into(),
            provider_id: provider_id.into(),
        }
    }

    /// Build a preset for one of the known providers.
    pub fn preset(id: &str, api_key: impl Into<String>, model_override: Option<String>) -> Option<Self> {
        let (base_url, default_model) = match id {
            "deepseek"    => ("https://api.deepseek.com/v1",                    "deepseek-chat"),
            "glm"         => ("https://open.bigmodel.cn/api/paas/v4",           "glm-4-flash"),
            "siliconflow" => ("https://api.siliconflow.cn/v1",                  "Qwen/Qwen2.5-Coder-7B-Instruct"),
            "groq"        => ("https://api.groq.com/openai/v1",                 "llama-3.3-70b-versatile"),
            "cerebras"    => ("https://api.cerebras.ai/v1",                     "llama-3.3-70b"),
            "openai"      => ("https://api.openai.com/v1",                      "gpt-4o-mini"),
            "mistral"     => ("https://api.mistral.ai/v1",                      "mistral-small-latest"),
            "gemini"      => ("https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash-lite"),
            "local"       => ("http://127.0.0.1:8080/v1",                       "qwen3-1.7b-q4_k_m"),
            "ollama"      => ("http://127.0.0.1:11434/v1",                      "qwen2.5-coder:1.5b"),
            _ => return None,
        };
        Some(Self::new(
            id,
            base_url,
            api_key,
            model_override.unwrap_or_else(|| default_model.to_string()),
        ))
    }
}

#[derive(Deserialize)]
struct ApiResponse {
    choices: Vec<Choice>,
    model: Option<String>,
    usage: Option<ApiUsage>,
}

#[derive(Deserialize)]
struct Choice {
    message: ApiMessage,
}

#[derive(Deserialize)]
struct ApiMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct ApiUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
}

#[derive(Deserialize)]
struct ApiError {
    error: ApiErrorBody,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    message: String,
}

#[async_trait]
impl Llm for OpenAiCompatProvider {
    async fn chat(&self, req: ChatRequest) -> LlmResult<ChatResponse> {
        let messages: Vec<Value> = req.messages.iter().map(|m| {
            json!({ "role": m.role, "content": m.content })
        }).collect();

        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": false,
        });

        if let Some(max_tokens) = req.max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        if let Some(temp) = req.temperature {
            body["temperature"] = json!(temp);
        }

        let url = format!("{}/chat/completions", self.base_url);
        let resp = self.client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await?;

        let status = resp.status().as_u16();
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            let message = serde_json::from_str::<ApiError>(&text)
                .map(|e| e.error.message)
                .unwrap_or(text);
            return Err(LlmError::Provider { status, message });
        }

        let api_resp: ApiResponse = resp.json().await?;
        let content = api_resp.choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .unwrap_or_default();

        Ok(ChatResponse {
            content,
            model: api_resp.model,
            usage: api_resp.usage.map(|u| TokenUsage {
                prompt_tokens: u.prompt_tokens,
                completion_tokens: u.completion_tokens,
                total_tokens: u.total_tokens,
            }),
        })
    }

    async fn chat_stream(
        &self,
        req: ChatRequest,
    ) -> LlmResult<BoxStream<'static, LlmResult<ChatStreamEvent>>> {
        let messages: Vec<Value> = req.messages.iter().map(|m| {
            json!({ "role": m.role, "content": m.content })
        }).collect();

        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": true,
        });
        if let Some(max_tokens) = req.max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        if let Some(temp) = req.temperature {
            body["temperature"] = json!(temp);
        }

        let url = format!("{}/chat/completions", self.base_url);
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            let message = serde_json::from_str::<ApiError>(&text)
                .map(|e| e.error.message)
                .unwrap_or(text);
            return Err(LlmError::Provider { status, message });
        }

        // SSE: each event is `data: <json>\n\n`. We accumulate bytes, split on
        // double-newline, and parse `delta.content` from each JSON payload.
        // The terminal event is `data: [DONE]`.
        let model = self.model.clone();
        let bytes = resp.bytes_stream();

        let stream = async_stream::stream! {
            let mut buffer = String::new();
            let mut bytes = Box::pin(bytes);
            let mut model_id: Option<String> = Some(model.clone());

            while let Some(chunk) = bytes.next().await {
                let chunk = match chunk {
                    Ok(b) => b,
                    Err(e) => {
                        yield Ok(ChatStreamEvent::Error { message: format!("stream: {e}") });
                        return;
                    }
                };
                buffer.push_str(&String::from_utf8_lossy(&chunk));

                // Process complete events ending in \n\n.
                while let Some(idx) = buffer.find("\n\n") {
                    let event = buffer[..idx].to_string();
                    buffer.drain(..idx + 2);

                    for line in event.lines() {
                        let Some(payload) = line.strip_prefix("data:") else { continue; };
                        let payload = payload.trim();
                        if payload == "[DONE]" {
                            yield Ok(ChatStreamEvent::End { model: model_id.take(), usage: None });
                            return;
                        }
                        let parsed: Result<StreamChunk, _> = serde_json::from_str(payload);
                        if let Ok(chunk) = parsed {
                            if let Some(choice) = chunk.choices.into_iter().next() {
                                if let Some(content) = choice.delta.content {
                                    if !content.is_empty() {
                                        yield Ok(ChatStreamEvent::Token { content });
                                    }
                                }
                            }
                            if let Some(m) = chunk.model {
                                model_id = Some(m);
                            }
                        }
                    }
                }
            }

            // Stream closed without [DONE] — emit a soft end.
            yield Ok(ChatStreamEvent::End { model: model_id.take(), usage: None });
        };

        Ok(Box::pin(stream))
    }

    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn model(&self) -> &str {
        &self.model
    }
}

#[derive(Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
}

#[derive(Deserialize)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
}
