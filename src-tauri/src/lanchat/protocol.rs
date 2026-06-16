//! LanChat wire protocol — the cross-task contract.
//!
//! Defines the mDNS service identity, the length-prefixed JSON control-frame
//! envelope, and the shared data types (peer record, presence). Frame `type`
//! strings are grouped by the task that owns them; task 01 implements the
//! core set, while `file-*` / `signal-*` / `wb-*` are reserved here so the
//! contract is stable before tasks 02/03/04 fill them in.
//!
//! Items that are part of the forward contract but not yet referenced by
//! task-01 code carry `#![allow(dead_code)]`; the allow is narrowed as later
//! phases start using them.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// DNS-SD service type advertised/browsed on the LAN.
pub const SERVICE_TYPE: &str = "_taomni-lan._tcp.local.";

/// Control-channel protocol version (bumped on breaking frame changes).
pub const PROTOCOL_VERSION: u32 = 1;

/// Default chunk size for binary (file/media) frames — 64 KiB.
pub const BINARY_CHUNK_SIZE: usize = 64 * 1024;

/// Frame `type` discriminators carried in [`Envelope::frame_type`].
///
/// Strings (not an enum) so unknown/forward types from a newer peer decode
/// gracefully into [`Envelope`] and can be ignored rather than failing the
/// whole connection.
pub mod frame {
    // --- task 01: handshake / keepalive / identity ---
    pub const HELLO: &str = "hello";
    pub const HELLO_ACK: &str = "hello-ack";
    pub const PING: &str = "ping";
    pub const PONG: &str = "pong";
    pub const PROFILE_UPDATE: &str = "profile-update";
    pub const AVATAR_REQ: &str = "avatar-req";
    pub const AVATAR_DATA: &str = "avatar-data";
    // --- task 01: messaging ---
    pub const TEXT_MSG: &str = "text-msg";
    pub const TEXT_ACK: &str = "text-ack";
    pub const GROUP_ANNOUNCE: &str = "group-announce";
    pub const GROUP_JOIN: &str = "group-join";
    pub const GROUP_LEAVE: &str = "group-leave";
    // --- task 02 (reserved): file & screenshot transfer ---
    pub const FILE_OFFER: &str = "file-offer";
    pub const FILE_ACCEPT: &str = "file-accept";
    pub const FILE_REJECT: &str = "file-reject";
    pub const FILE_CHUNK: &str = "file-chunk";
    pub const FILE_PROGRESS: &str = "file-progress";
    pub const FILE_PAUSE: &str = "file-pause";
    pub const FILE_RESUME: &str = "file-resume";
    pub const FILE_CANCEL: &str = "file-cancel";
    pub const FILE_COMPLETE: &str = "file-complete";
    // --- task 03 (reserved): A/V meeting signaling ---
    pub const CALL_INVITE: &str = "call-invite";
    pub const CALL_ACCEPT: &str = "call-accept";
    pub const CALL_REJECT: &str = "call-reject";
    pub const CALL_CANCEL: &str = "call-cancel";
    pub const CALL_END: &str = "call-end";
    pub const SIGNAL_SDP: &str = "signal-sdp";
    pub const SIGNAL_ICE: &str = "signal-ice";
    pub const MEETING_JOIN: &str = "meeting-join";
    pub const MEETING_LEAVE: &str = "meeting-leave";
    pub const MEDIA_STATE: &str = "media-state";
    // --- task 04 (reserved): collaborative whiteboard ---
    pub const WB_OPEN: &str = "wb-open";
    pub const WB_INVITE: &str = "wb-invite";
    pub const WB_JOIN: &str = "wb-join";
    pub const WB_LEAVE: &str = "wb-leave";
    pub const WB_OP: &str = "wb-op";
    pub const WB_CURSOR: &str = "wb-cursor";
    pub const WB_SNAPSHOT_REQ: &str = "wb-snapshot-req";
    pub const WB_SNAPSHOT: &str = "wb-snapshot";
}

/// Manual presence state advertised in mDNS TXT (`st`) and derived from
/// heartbeat freshness. `Offline` is never advertised — it is inferred by
/// peers when a service is withdrawn or a heartbeat times out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceStatus {
    Online,
    Away,
    Busy,
    Offline,
}

impl PresenceStatus {
    /// Parse the mDNS TXT `st` field; unknown values fall back to `Online`.
    pub fn from_txt(s: &str) -> Self {
        match s {
            "away" => Self::Away,
            "busy" => Self::Busy,
            "offline" => Self::Offline,
            _ => Self::Online,
        }
    }

    pub fn as_txt(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Away => "away",
            Self::Busy => "busy",
            Self::Offline => "offline",
        }
    }
}

/// Length-prefixed JSON control frame. Wire format is
/// `[u32 BE length][UTF-8 JSON]`; this struct is the JSON body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    /// Protocol version (see [`PROTOCOL_VERSION`]).
    pub v: u32,
    /// Frame discriminator (see [`frame`]).
    #[serde(rename = "type")]
    pub frame_type: String,
    /// Unique message id (uuid v4) for ack/dedup.
    pub id: String,
    /// Sender node id.
    pub from: String,
    /// Target node id / group id, or null for broadcast-style frames.
    #[serde(default)]
    pub to: Option<String>,
    /// Sender wall-clock timestamp (ms since epoch).
    pub ts: i64,
    /// Frame-type-specific payload.
    pub payload: serde_json::Value,
}

impl Envelope {
    /// Build an envelope from this node with a fresh uuid and current time.
    pub fn new(
        frame_type: &str,
        from: &str,
        to: Option<String>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            frame_type: frame_type.to_string(),
            id: uuid::Uuid::new_v4().to_string(),
            from: from.to_string(),
            to,
            ts: chrono::Utc::now().timestamp_millis(),
            payload,
        }
    }
}

/// A peer learned from mDNS discovery (+ refreshed by control-channel
/// traffic). Cached in `peers` SQLite table and held live in `LanChatState`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    pub id: String,
    pub name: String,
    /// Avatar content fingerprint (first 16 hex of sha256) — drives avatar-req.
    #[serde(default)]
    pub avatar_hash: Option<String>,
    #[serde(default)]
    pub signature: String,
    pub status: PresenceStatus,
    /// Last time we saw an mDNS announce / heartbeat (ms since epoch).
    pub last_seen: i64,
    /// Resolved socket address(es) for the control channel, if known.
    #[serde(default)]
    pub addr: Option<String>,
    /// Control-channel TCP port advertised in TXT.
    #[serde(default)]
    pub port: Option<u16>,
}
