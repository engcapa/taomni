use reqwest::{Client, Request, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvocationProtocol {
    OpenaiChat,
    OpenaiResponses,
    AnthropicMessages,
}

/// Frozen one-shot input. Intentionally not Debug/Serialize: it contains a secret.
#[derive(Clone)]
pub struct InvocationRequest {
    pub protocol: InvocationProtocol,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub max_output_tokens: u32,
    pub system: String,
    pub prompt: String,
}

pub(super) fn build(client: &Client, req: &InvocationRequest) -> Result<Request, String> {
    if req.model.trim().is_empty() || req.max_output_tokens == 0 {
        return Err("Invocation requires a model and a positive output token limit".into());
    }
    let url = endpoint(&req.base_url, req.protocol)?;
    let mut builder = client
        .post(url)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .json(&body(req));
    if req.protocol == InvocationProtocol::AnthropicMessages {
        // Stable Messages API version, not a model version or a beta opt-in.
        builder = builder.header("anthropic-version", "2023-06-01");
        if !req.api_key.is_empty() {
            let mut key = reqwest::header::HeaderValue::from_str(&req.api_key)
                .map_err(|_| "Invalid invocation authentication header")?;
            key.set_sensitive(true);
            builder = builder.header("x-api-key", key);
        }
    } else if !req.api_key.is_empty() {
        builder = builder.bearer_auth(&req.api_key);
    }
    // reqwest errors can include URLs/header values. Never return their text.
    builder
        .build()
        .map_err(|_| "Invalid invocation request or authentication header".into())
}

fn endpoint(base: &str, protocol: InvocationProtocol) -> Result<Url, String> {
    let mut url = Url::parse(base.trim()).map_err(|_| "Invalid invocation base URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Invocation base URL must be HTTP(S), without credentials, query or fragment".into(),
        );
    }
    let leaf = match protocol {
        InvocationProtocol::OpenaiChat => "chat/completions",
        InvocationProtocol::OpenaiResponses => "responses",
        InvocationProtocol::AnthropicMessages => "messages",
    };
    // An origin means /v1. A nonempty custom base path is preserved verbatim.
    // Also accept a full endpoint, without appending its suffix twice.
    let base_path = url.path().trim_end_matches('/');
    let path = if base_path.ends_with(&format!("/{leaf}")) {
        base_path.to_owned()
    } else if base_path.is_empty() {
        format!("/v1/{leaf}")
    } else {
        format!("{base_path}/{leaf}")
    };
    url.set_path(&path);
    Ok(url)
}

fn body(req: &InvocationRequest) -> Value {
    match req.protocol {
        InvocationProtocol::OpenaiChat => {
            let mut messages = Vec::new();
            if !req.system.is_empty() {
                messages.push(json!({"role": "system", "content": req.system}));
            }
            messages.push(json!({"role": "user", "content": req.prompt}));
            json!({
                "model": req.model,
                "messages": messages,
                "max_completion_tokens": req.max_output_tokens,
                "stream": true,
                "stream_options": {"include_usage": true},
                "n": 1,
                "store": false,
            })
        }
        InvocationProtocol::OpenaiResponses => {
            let mut body = json!({
                "model": req.model,
                "input": req.prompt,
                "max_output_tokens": req.max_output_tokens,
                "stream": true,
                "store": false,
            });
            if !req.system.is_empty() {
                body["instructions"] = req.system.clone().into();
            }
            body
        }
        InvocationProtocol::AnthropicMessages => {
            let mut body = json!({
                "model": req.model,
                "messages": [{"role": "user", "content": req.prompt}],
                "max_tokens": req.max_output_tokens,
                "stream": true,
            });
            if !req.system.is_empty() {
                body["system"] = req.system.clone().into();
            }
            body
        }
    }
}
