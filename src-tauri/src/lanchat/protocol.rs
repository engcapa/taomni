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
///
/// v2 (phase 1+): node ids are self-certifying — the SHA-256 fingerprint of the
/// node's self-signed TLS certificate — and the control channel is mutual-TLS.
/// This is a hard cutover: v2 nodes do not interoperate with v1 (plaintext,
/// random-UUID) nodes.
///
/// v3 (swarm file transfer): every length-delimited frame body now begins with a
/// one-byte kind tag (see [`wire`]) so bulk file pieces can travel as raw binary
/// (`0x01`) alongside JSON control envelopes (`0x00`), avoiding base64. File
/// transfer moves to a request/response swarm with per-piece SHA-256. Another
/// hard cutover: v3 nodes do not interoperate with v2 (the tag byte would be
/// mis-parsed as JSON).
pub const PROTOCOL_VERSION: u32 = 3;

/// Default file piece size for the swarm transfer engine — 256 KiB raw (no
/// base64). Bounds per-in-flight-piece memory and the swarm request window.
pub const PIECE_SIZE: usize = 256 * 1024;

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
    // --- peer-exchange: gossip roster over TCP to work around mDNS failures ---
    pub const PEER_EXCHANGE: &str = "peer-exchange";
    // --- task 02: swarm file & folder transfer (v3) ---
    // Bulk piece data travels as raw binary frames (see `wire`); these JSON
    // control frames drive the request/response swarm.
    /// Announce a file/folder manifest to one peer or a whole group.
    pub const SWARM_OFFER: &str = "swarm-offer";
    /// Receiver agreed to leech — sender records it as a swarm member.
    pub const SWARM_ACCEPT: &str = "swarm-accept";
    /// Receiver declined the offer.
    pub const SWARM_REJECT: &str = "swarm-reject";
    /// Ask a peer for a specific piece: `{fileId, piece}`.
    pub const SWARM_REQUEST: &str = "swarm-request";
    /// Advertise that we now hold a piece: `{fileId, piece}`.
    pub const SWARM_HAVE: &str = "swarm-have";
    /// Full bitfield of held pieces on join: `{fileId, bits(base64)}`.
    pub const SWARM_BITFIELD: &str = "swarm-bitfield";
    /// Abort a whole transfer for this peer: `{fileId}`.
    pub const SWARM_CANCEL: &str = "swarm-cancel";
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

    /// Serialize the envelope body to JSON bytes (the length prefix is added
    /// by the transport's `LengthDelimitedCodec`).
    pub fn encode(&self) -> Result<bytes::Bytes, serde_json::Error> {
        Ok(bytes::Bytes::from(serde_json::to_vec(self)?))
    }

    /// Decode an envelope from a received frame body.
    pub fn decode(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(bytes)
    }
}

/// Frame tagging for the v3 wire format. Each length-delimited frame body starts
/// with a one-byte kind tag so bulk file pieces ride as raw binary next to JSON
/// control envelopes without base64. The tag lives at the transport boundary
/// only; [`Envelope`] stays pure JSON.
pub mod wire {
    use bytes::{BufMut, Bytes, BytesMut};

    /// JSON control envelope follows.
    pub const TAG_CONTROL: u8 = 0x00;
    /// Raw binary file piece follows.
    pub const TAG_PIECE: u8 = 0x01;

    /// A decoded inbound frame: either a control envelope (still JSON-encoded
    /// bytes) or a binary piece.
    pub enum Frame {
        Control(super::Envelope),
        /// (file_id, piece_index, data)
        Piece(String, u32, Bytes),
    }

    /// Prepend the control tag to already-JSON-encoded envelope bytes.
    pub fn frame_control(json: &[u8]) -> Bytes {
        let mut b = BytesMut::with_capacity(1 + json.len());
        b.put_u8(TAG_CONTROL);
        b.extend_from_slice(json);
        b.freeze()
    }

    /// Encode a binary piece frame body:
    /// `[TAG_PIECE][u8 fileId_len][fileId][u32 BE pieceIndex][data]`.
    /// `file_id` is a hex SHA-256 (64 bytes) so its length fits a u8.
    pub fn frame_piece(file_id: &str, piece: u32, data: &[u8]) -> Bytes {
        let id = file_id.as_bytes();
        let mut b = BytesMut::with_capacity(1 + 1 + id.len() + 4 + data.len());
        b.put_u8(TAG_PIECE);
        b.put_u8(id.len() as u8);
        b.extend_from_slice(id);
        b.put_u32(piece);
        b.extend_from_slice(data);
        b.freeze()
    }

    /// Parse a received frame body by its leading tag. Returns `None` if the
    /// frame is empty, malformed, or carries an unknown tag.
    pub fn decode_frame(buf: &[u8]) -> Option<Frame> {
        match buf.first()? {
            &TAG_CONTROL => super::Envelope::decode(&buf[1..]).ok().map(Frame::Control),
            &TAG_PIECE => {
                let id_len = *buf.get(1)? as usize;
                let id_end = 2 + id_len;
                let id = std::str::from_utf8(buf.get(2..id_end)?).ok()?.to_string();
                let idx_end = id_end + 4;
                let idx_bytes: [u8; 4] = buf.get(id_end..idx_end)?.try_into().ok()?;
                let piece = u32::from_be_bytes(idx_bytes);
                let data = Bytes::copy_from_slice(buf.get(idx_end..)?);
                Some(Frame::Piece(id, piece, data))
            }
            _ => None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trips_through_codec() {
        let env = Envelope::new(
            frame::TEXT_MSG,
            "node-a",
            Some("node-b".into()),
            serde_json::json!({ "convId": "c1", "text": "hi", "mentions": [] }),
        );
        let bytes = env.encode().unwrap();
        let back = Envelope::decode(&bytes).unwrap();
        assert_eq!(back.frame_type, frame::TEXT_MSG);
        assert_eq!(back.from, "node-a");
        assert_eq!(back.to.as_deref(), Some("node-b"));
        assert_eq!(back.v, PROTOCOL_VERSION);
        assert_eq!(back.payload["text"], "hi");
    }

    #[test]
    fn presence_txt_round_trip() {
        for s in ["online", "away", "busy", "offline"] {
            assert_eq!(PresenceStatus::from_txt(s).as_txt(), s);
        }
        // Unknown falls back to online.
        assert_eq!(PresenceStatus::from_txt("???"), PresenceStatus::Online);
    }

    #[test]
    fn wire_control_frame_round_trips() {
        let env = Envelope::new(frame::PING, "node-a", Some("node-b".into()), serde_json::json!({}));
        let framed = wire::frame_control(&env.encode().unwrap());
        assert_eq!(framed[0], wire::TAG_CONTROL);
        match wire::decode_frame(&framed) {
            Some(wire::Frame::Control(e)) => assert_eq!(e.frame_type, frame::PING),
            _ => panic!("expected control frame"),
        }
    }

    #[test]
    fn wire_piece_frame_round_trips() {
        let file_id = "a".repeat(64);
        let data = vec![7u8, 8, 9, 10, 11];
        let framed = wire::frame_piece(&file_id, 42, &data);
        assert_eq!(framed[0], wire::TAG_PIECE);
        match wire::decode_frame(&framed) {
            Some(wire::Frame::Piece(id, idx, bytes)) => {
                assert_eq!(id, file_id);
                assert_eq!(idx, 42);
                assert_eq!(&bytes[..], &data[..]);
            }
            _ => panic!("expected piece frame"),
        }
    }

    #[test]
    fn wire_rejects_empty_and_unknown_tags() {
        assert!(wire::decode_frame(&[]).is_none());
        assert!(wire::decode_frame(&[0x7f, 1, 2, 3]).is_none());
    }
}
