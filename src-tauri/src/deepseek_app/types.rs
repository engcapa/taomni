use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaoRequest {
    pub thread_id: String,
    pub content: String,
    pub mode: String,
    pub model: String,
    #[serde(default)]
    pub thinking: bool,
    #[serde(default)]
    pub web: bool,
    #[serde(default)]
    pub context: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaoEvent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(flatten)]
    pub payload: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaoResponse {
    pub events: Vec<TaoEvent>,
}

impl TaoEvent {
    pub fn new(kind: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            payload: serde_json::Map::new(),
        }
    }

    pub fn with(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.payload.insert(key.into(), value.into());
        self
    }
}
