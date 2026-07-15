use serde::{Deserialize, Serialize};

/// Provider-neutral token, cost, and timing metadata for a completed local
/// agent turn. Individual agents may omit fields they do not report.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct LocalAgentUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub total_cost_usd: Option<f64>,
    pub duration_ms: Option<u64>,
    pub num_turns: Option<u64>,
}

/// A persisted session identifier owned by a local-agent provider profile.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalAgentSession {
    pub profile_id: String,
    pub session_id: String,
}

/// Per-turn options that are meaningful across local coding-agent protocols.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalAgentTurnOptions {
    pub model: Option<String>,
    pub cwd: Option<String>,
}

/// Stream events exposed by all local coding-agent bridges.
///
/// This is intentionally independent from the Tauri `StreamEventOut` shape so
/// ACP can be added without coupling its protocol to the current chat UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LocalAgentEvent {
    SessionStarted {
        session_id: String,
    },
    AssistantDelta {
        content: String,
    },
    AssistantMessage {
        content: String,
    },
    ToolStarted {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolCompleted {
        id: String,
        output: String,
    },
    Done {
        usage: Option<LocalAgentUsage>,
    },
    Error {
        message: String,
    },
}
