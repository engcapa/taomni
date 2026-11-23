//! Bounded IMAP operations on a single authorized mailbox connection.

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum MutationRequest {
    Select { folder: String, capabilities: bool },
    All { folder: String },
    Find { uids: Vec<u32> },
    Copy { target: String, uids: Vec<u32> },
    Move { target: String, uids: Vec<u32> },
    MarkDeleted { uids: Vec<u32> },
    Expunge { uids: Vec<u32> },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum MutationReply {
    Selected {
        validity: u32,
        move_supported: bool,
        uidplus: bool,
    },
    Uids(Vec<u32>),
    Applied,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationError {
    pub message: String,
    pub rejection: Option<Rejection>,
}

#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Rejection {
    Bad,
    No,
}

impl MutationError {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            rejection: None,
        }
    }
}

impl std::fmt::Display for MutationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MutationKind {
    Move,
    Copy,
    Delete,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationProgress {
    pub operation_id: String,
    pub completed_uids: Vec<u32>,
    pub pending_uids: Vec<u32>,
    pub uncertain_uids: Vec<u32>,
    pub error: Option<String>,
    pub detail: Option<String>,
    pub retryable: bool,
    pub batch_size: usize,
}
