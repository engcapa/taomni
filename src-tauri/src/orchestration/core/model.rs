use serde::{Deserialize, Serialize};

use crate::proxy::AppProxyConfig;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentProtocol {
    OpenaiChat,
    OpenaiResponses,
    AnthropicMessages,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub protocol: AgentProtocol,
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub key_ref: String,
    #[serde(default = "default_harness")]
    pub harness: String,
    #[serde(default)]
    pub binary: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "one")]
    pub cost_coefficient: f64,
    #[serde(default = "app_proxy")]
    pub proxy_mode: String,
    pub custom_proxy: Option<AppProxyConfig>,
}
fn default_harness() -> String {
    "claude_code".into()
}
fn one() -> f64 {
    1.0
}
fn app_proxy() -> String {
    "app".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    pub revision: u64,
    pub name: String,
    pub planning_resource_id: String,
    pub review_resource_id: String,
    pub worker_resource_ids: Vec<String>,
    pub concurrency: u32,
    pub prefer_packed_planning: bool,
    pub resources: Vec<AgentResource>,
}
impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            revision: 1,
            name: "日常开发".into(),
            planning_resource_id: String::new(),
            review_resource_id: String::new(),
            worker_resource_ids: Vec::new(),
            concurrency: 2,
            prefer_packed_planning: true,
            resources: Vec::new(),
        }
    }
}
impl AgentSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() || self.name.chars().count() > 80 {
            return Err("INVALID_SETTINGS: a plan name is required".into());
        }
        if !(1..=4).contains(&self.concurrency) || self.resources.len() > 32 {
            return Err("INVALID_SETTINGS: invalid resource limits".into());
        }
        let mut ids = std::collections::HashSet::new();
        for resource in &self.resources {
            if resource.id.is_empty() || resource.id.len() > 128 || !ids.insert(&resource.id) {
                return Err("INVALID_SETTINGS: resource IDs must be unique".into());
            }
            if !matches!(resource.kind.as_str(), "api" | "worker")
                || !resource.cost_coefficient.is_finite()
                || resource.cost_coefficient <= 0.0
                || !matches!(resource.proxy_mode.as_str(), "app" | "custom" | "none")
                || (resource.proxy_mode == "custom" && resource.custom_proxy.is_none())
                || resource.args.len() > 128
                || resource
                    .args
                    .iter()
                    .any(|a| a.len() > 16 * 1024 || a.contains('\0'))
            {
                return Err("INVALID_SETTINGS: invalid resource configuration".into());
            }
            if resource.custom_proxy.as_ref().is_some_and(|p| {
                !p.password_ref.is_empty() && !p.password_ref.starts_with("vault:")
            }) {
                return Err("INVALID_SETTINGS: proxy credentials must reference Vault".into());
            }
            if !resource.key_ref.is_empty() && !resource.key_ref.starts_with("vault:") {
                return Err("INVALID_SETTINGS: credentials must reference Vault".into());
            }
            if !resource.base_url.is_empty() {
                let url =
                    reqwest::Url::parse(&resource.base_url).map_err(|_| "INVALID_ENDPOINT")?;
                if !matches!(url.scheme(), "http" | "https")
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err("INVALID_ENDPOINT".into());
                }
            }
            if resource.kind == "worker"
                && !matches!(
                    resource.harness.as_str(),
                    "claude_code" | "codex" | "pi" | "opencode" | "deepseek" | "zcode"
                )
            {
                return Err("INVALID_SETTINGS: unsupported worker harness".into());
            }
        }
        for id in [&self.planning_resource_id, &self.review_resource_id]
            .into_iter()
            .chain(self.worker_resource_ids.iter())
        {
            if !id.is_empty() && !ids.contains(id) {
                return Err("INVALID_SETTINGS: referenced resource is missing".into());
            }
        }
        for id in &self.worker_resource_ids {
            if !self
                .resources
                .iter()
                .any(|r| &r.id == id && r.kind == "worker")
            {
                return Err("INVALID_SETTINGS: development roles require worker resources".into());
            }
        }
        Ok(())
    }
    pub fn resource(&self, intent: &AgentIntent) -> Result<AgentResource, String> {
        let id = match intent {
            AgentIntent::Plan => &self.planning_resource_id,
            AgentIntent::Review => &self.review_resource_id,
            AgentIntent::Develop => self
                .worker_resource_ids
                .first()
                .ok_or("RESOURCE_REQUIRED: configure a development worker")?,
        };
        self.resources
            .iter()
            .find(|r| &r.id == id)
            .cloned()
            .ok_or_else(|| "RESOURCE_REQUIRED: configure shared development resources".into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentIntent {
    Develop,
    Plan,
    Review,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSubmission {
    pub command_id: String,
    pub project_path: String,
    pub goal: String,
    pub intent: AgentIntent,
    pub source_paths: Vec<String>,
    pub expected_settings_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSource {
    pub id: String,
    pub path: String,
    pub content: String,
    pub hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPreview {
    pub sources: Vec<AgentSource>,
    pub estimated_input_tokens: u64,
    pub estimate_method: String,
    pub warnings: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentArtifact {
    pub id: String,
    pub item_id: String,
    pub name: String,
    pub format: String,
    pub content: String,
    pub hash: String,
    pub status: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    pub id: String,
    pub title: String,
    pub status: String,
    pub dependencies: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub sequence: u64,
    pub kind: String,
    pub message: String,
    pub created_at: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub revision: u64,
    pub project_path: String,
    pub title: String,
    pub goal: String,
    pub intent: AgentIntent,
    pub status: String,
    pub settings_snapshot: AgentSettings,
    pub tasks: Vec<AgentTask>,
    pub sources: Vec<AgentSource>,
    pub artifacts: Vec<AgentArtifact>,
    pub events: Vec<AgentEvent>,
    pub request_count: u32,
    pub recovery_count: u32,
    pub error: Option<String>,
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub source_revision: Option<String>,
    pub created_at: u64,
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}
