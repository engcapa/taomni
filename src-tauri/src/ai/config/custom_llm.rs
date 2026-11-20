use super::LlmProviderConfig;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomLlmProvider {
    pub label: String,
    pub models: Vec<CustomLlmModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomLlmModel {
    pub id: String,
    pub context_window: u32,
    pub max_output_tokens: u32,
    #[serde(default)]
    pub multimodal: bool,
    #[serde(default)]
    pub reasoning_efforts: Vec<String>,
    #[serde(default)]
    pub native_search: bool,
}

pub(super) fn base_url(url: &str, runtime: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    let suffix = match runtime {
        "anthropic" => "/messages",
        "openai-compat" => "/chat/completions",
        "openai-responses" => "/responses",
        _ => return url.to_owned(),
    };
    url.strip_suffix(suffix).unwrap_or(url).to_owned()
}

impl LlmProviderConfig {
    pub fn validate_custom(&self) -> Result<(), String> {
        let Some(custom) = &self.custom else {
            return Ok(());
        };
        let valid_efforts = match self.runtime.as_str() {
            "anthropic" => &["low", "medium", "high", "max"][..],
            "openai-compat" | "openai-responses" => {
                &["none", "minimal", "low", "medium", "high", "xhigh"]
            }
            _ => return Err("configuration: unsupported custom provider protocol".into()),
        };
        let url = reqwest::Url::parse(&self.base_url)
            .map_err(|_| "configuration: invalid custom provider URL")?;
        if (url.scheme() != "https"
            && !(url.scheme() == "http" && crate::ai::network_policy::is_local_url(&self.base_url)))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("configuration: enter an HTTPS provider URL or a loopback HTTP URL".into());
        }
        let mut ids = HashSet::new();
        if custom.label.is_empty()
            || custom.models.is_empty()
            || custom.models.iter().any(|model| {
                model.id.is_empty()
                    || model.id.len() > 256
                    || model.id.chars().any(char::is_control)
                    || !ids.insert(&model.id)
                    || model.max_output_tokens == 0
                    || model.max_output_tokens >= model.context_window
                    || model
                        .reasoning_efforts
                        .iter()
                        .any(|effort| !valid_efforts.contains(&effort.as_str()))
            })
        {
            return Err(
                "configuration: invalid custom model ID, token limits, or reasoning effort".into(),
            );
        }
        self.custom_model(&self.model).map(|_| ())
    }

    pub fn custom_model(&self, model_id: &str) -> Result<Option<&CustomLlmModel>, String> {
        self.custom
            .as_ref()
            .map(|custom| {
                custom
                    .models
                    .iter()
                    .find(|model| model.id == model_id)
                    .ok_or_else(|| {
                        "configuration: choose a configured model for this provider".into()
                    })
            })
            .transpose()
    }
}

impl CustomLlmModel {
    pub fn apply_request_options(
        &self,
        runtime: &str,
        body: &mut Value,
        max_tokens: u32,
        effort: Option<&str>,
        search: bool,
    ) {
        let tokens = max_tokens.min(self.max_output_tokens);
        match runtime {
            "anthropic" => {
                body["max_tokens"] = json!(tokens);
                if let Some(effort) = effort {
                    body["thinking"] = json!({"type":"adaptive"});
                    body["output_config"] = json!({"effort":effort});
                }
                if search {
                    append_tool(
                        body,
                        json!({"type":"web_search_20250305","name":"web_search"}),
                    );
                }
            }
            "openai-responses" => {
                body["max_output_tokens"] = json!(tokens);
                body["store"] = json!(false);
                if let Some(effort) = effort {
                    body["reasoning"] = json!({"effort":effort});
                }
                if search {
                    append_tool(body, json!({"type":"web_search"}));
                }
            }
            _ => {
                if let Some(effort) = effort {
                    body.as_object_mut().unwrap().remove("max_tokens");
                    body["max_completion_tokens"] = json!(tokens);
                    body["reasoning_effort"] = json!(effort);
                } else {
                    body["max_tokens"] = json!(tokens);
                }
                if search {
                    body["web_search_options"] = json!({});
                }
            }
        }
        if effort.is_some() {
            body.as_object_mut().unwrap().remove("temperature");
        }
    }
}

fn append_tool(body: &mut Value, tool: Value) {
    if let Some(tools) = body["tools"].as_array_mut() {
        tools.push(tool);
    } else {
        body["tools"] = json!([tool]);
    }
}
