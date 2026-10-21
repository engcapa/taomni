use crate::lanchat::protocol::PresenceStatus;
use serde::Deserialize;
use serde::Serialize;

/// This node's own profile (single row in `profile`). Avatar bytes are carried
/// to/from the frontend as base64 (`avatarBase64`); the fingerprint `avh` is
/// the first 16 hex of the avatar's sha256.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub avatar_base64: Option<String>,
    #[serde(default)]
    pub avatar_hash: Option<String>,
    #[serde(default)]
    pub signature: String,
    pub status: PresenceStatus,
    pub updated_at: i64,
}

/// A conversation (direct with a peer, or a group). For direct chats the id is
/// deterministic (`direct:<otherNodeId>`) so both peers map to a stable thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    /// "direct" | "group".
    pub kind: String,
    /// Peer node id (direct) or group id (group).
    pub peer_or_group_id: String,
    pub last_msg_at: i64,
    pub unread: i64,
}

/// A chat message. `mentions` is a list of node ids; persisted as a JSON array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanMessage {
    pub id: String,
    pub conv_id: String,
    pub sender_id: String,
    pub body: String,
    #[serde(default)]
    pub mentions: Vec<String>,
    pub created_at: i64,
    /// "sending" | "sent" | "delivered" | "failed".
    pub state: String,
}

/// Stable conversation id for a direct chat with `peer_id`.
pub fn direct_conv_id(peer_id: &str) -> String {
    format!("direct:{peer_id}")
}

/// Stable conversation id for a group/channel.
pub fn group_conv_id(group_id: &str) -> String {
    format!("group:{group_id}")
}

/// A named group / channel and its current member node ids.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    #[serde(default)]
    pub members: Vec<String>,
}

/// Message retention policy (single `settings` row). `retention_days` / `max_per_conv`
/// of 0 disable that cap; `cleanup_enabled` gates the periodic sweep entirely.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionSettings {
    pub retention_days: i64,
    pub max_per_conv: i64,
    pub cleanup_enabled: bool,
}
