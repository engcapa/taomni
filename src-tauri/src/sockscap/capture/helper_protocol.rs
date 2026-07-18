//! Authenticated, versioned helper protocol.
//!
//! Transport-specific code must independently obtain peer credentials and
//! verify the executable signature/digest before creating a session. HMAC then
//! protects each bounded JSON-line message against injection, tampering and
//! replay. The command enum is intentionally narrow and contains no arbitrary
//! program, shell text or credential field.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use super::{AdapterProbe, CaptureArtifactState, CaptureHandle, CaptureInstallSpec};

type HmacSha256 = Hmac<Sha256>;

pub const HELPER_PROTOCOL_VERSION: u32 = 1;
pub const MAX_HELPER_LINE_BYTES: usize = 64 * 1024;
pub const SESSION_KEY_BYTES: usize = 32;
const MAX_SESSION_ID_BYTES: usize = 128;
const MAX_REQUEST_ID_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerIdentity {
    pub pid: u32,
    pub uid: Option<u32>,
    pub executable_path: String,
    pub executable_sha256: String,
    pub signing_identity: Option<String>,
    /// Set only by a platform transport after an OS credential/signature API
    /// succeeds. A claim copied from the request must never set this flag.
    pub platform_verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallerPolicy {
    pub expected_uid: Option<u32>,
    pub allowed_executable_sha256: Vec<String>,
    pub required_signing_identity: Option<String>,
}

pub fn verify_peer_identity(
    peer: &PeerIdentity,
    policy: &CallerPolicy,
) -> Result<(), ProtocolError> {
    if !peer.platform_verified || peer.pid == 0 {
        return Err(ProtocolError::Authentication(
            "platform peer verification was not completed".into(),
        ));
    }
    if peer.executable_path.is_empty()
        || peer.executable_path.len() > 4096
        || peer.executable_path.contains('\0')
    {
        return Err(ProtocolError::Authentication(
            "peer executable path is invalid".into(),
        ));
    }
    validate_sha256(&peer.executable_sha256)?;
    if policy.allowed_executable_sha256.is_empty() {
        return Err(ProtocolError::Authentication(
            "caller policy has no pinned executable digest".into(),
        ));
    }
    for digest in &policy.allowed_executable_sha256 {
        validate_sha256(digest)?;
    }
    if !policy
        .allowed_executable_sha256
        .iter()
        .any(|digest| digest.eq_ignore_ascii_case(&peer.executable_sha256))
    {
        return Err(ProtocolError::Authentication(
            "peer executable digest is not pinned".into(),
        ));
    }
    if policy.expected_uid.is_some() && policy.expected_uid != peer.uid {
        return Err(ProtocolError::Authentication(
            "peer uid does not match the authorized user".into(),
        ));
    }
    if let Some(required) = &policy.required_signing_identity {
        if peer.signing_identity.as_deref() != Some(required.as_str()) {
            return Err(ProtocolError::Authentication(
                "peer code-signing identity does not match".into(),
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HelperRequest {
    Probe,
    Install {
        spec: CaptureInstallSpec,
    },
    Update {
        handle: CaptureHandle,
        spec: CaptureInstallSpec,
    },
    Stop {
        handle: CaptureHandle,
    },
    Recover {
        artifact: CaptureArtifactState,
    },
    Heartbeat {
        generation: u64,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HelperResponse {
    Probe {
        report: AdapterProbe,
    },
    Installed {
        handle: CaptureHandle,
    },
    Updated {
        handle: CaptureHandle,
    },
    Stopped,
    Recovered,
    Heartbeat {
        helper_pid: u32,
        generation: u64,
    },
    Shutdown,
    Error {
        code: String,
        message: String,
        recovery_required: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnsignedEnvelope<T> {
    protocol_version: u32,
    session_id: String,
    sequence: u64,
    request_id: String,
    generation: u64,
    body: T,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedEnvelope<T> {
    protocol_version: u32,
    session_id: String,
    sequence: u64,
    request_id: String,
    generation: u64,
    body: T,
    mac: String,
}

impl<T: Clone> AuthenticatedEnvelope<T> {
    fn unsigned(&self) -> UnsignedEnvelope<T> {
        UnsignedEnvelope {
            protocol_version: self.protocol_version,
            session_id: self.session_id.clone(),
            sequence: self.sequence,
            request_id: self.request_id.clone(),
            generation: self.generation,
            body: self.body.clone(),
        }
    }

    pub fn body(&self) -> &T {
        &self.body
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
}

pub struct ProtocolSession {
    session_id: String,
    key: Zeroizing<Vec<u8>>,
    next_outbound: AtomicU64,
    last_inbound: Mutex<u64>,
}

impl ProtocolSession {
    pub fn new(session_id: impl Into<String>, key: &[u8]) -> Result<Self, ProtocolError> {
        let session_id = session_id.into();
        validate_bounded_token("session id", &session_id, MAX_SESSION_ID_BYTES)?;
        if key.len() != SESSION_KEY_BYTES {
            return Err(ProtocolError::Authentication(format!(
                "helper session key must be {SESSION_KEY_BYTES} bytes"
            )));
        }
        Ok(Self {
            session_id,
            key: Zeroizing::new(key.to_vec()),
            next_outbound: AtomicU64::new(1),
            last_inbound: Mutex::new(0),
        })
    }

    pub fn sign<T>(
        &self,
        request_id: impl Into<String>,
        generation: u64,
        body: T,
    ) -> Result<AuthenticatedEnvelope<T>, ProtocolError>
    where
        T: Clone + Serialize,
    {
        let request_id = request_id.into();
        validate_bounded_token("request id", &request_id, MAX_REQUEST_ID_BYTES)?;
        let sequence = self
            .next_outbound
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current.checked_add(1)
            })
            .map_err(|_| ProtocolError::SequenceExhausted)?;
        let unsigned = UnsignedEnvelope {
            protocol_version: HELPER_PROTOCOL_VERSION,
            session_id: self.session_id.clone(),
            sequence,
            request_id,
            generation,
            body,
        };
        let mac = compute_mac(&self.key, &unsigned)?;
        Ok(AuthenticatedEnvelope {
            protocol_version: unsigned.protocol_version,
            session_id: unsigned.session_id,
            sequence: unsigned.sequence,
            request_id: unsigned.request_id,
            generation: unsigned.generation,
            body: unsigned.body,
            mac,
        })
    }

    pub fn verify<T>(&self, envelope: &AuthenticatedEnvelope<T>) -> Result<(), ProtocolError>
    where
        T: Clone + Serialize,
    {
        if envelope.protocol_version != HELPER_PROTOCOL_VERSION {
            return Err(ProtocolError::VersionMismatch {
                expected: HELPER_PROTOCOL_VERSION,
                actual: envelope.protocol_version,
            });
        }
        if envelope.session_id != self.session_id {
            return Err(ProtocolError::Authentication(
                "helper session id does not match".into(),
            ));
        }
        validate_bounded_token("request id", &envelope.request_id, MAX_REQUEST_ID_BYTES)?;
        let supplied = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&envelope.mac)
            .map_err(|_| ProtocolError::Authentication("helper message MAC is invalid".into()))?;
        let bytes = serde_json::to_vec(&envelope.unsigned())
            .map_err(|error| ProtocolError::Encoding(error.to_string()))?;
        let mut mac = HmacSha256::new_from_slice(&self.key)
            .map_err(|_| ProtocolError::Authentication("invalid session key".into()))?;
        mac.update(&bytes);
        mac.verify_slice(&supplied)
            .map_err(|_| ProtocolError::Authentication("helper message MAC mismatch".into()))?;

        let mut last = self
            .last_inbound
            .lock()
            .map_err(|_| ProtocolError::Authentication("sequence lock poisoned".into()))?;
        if envelope.sequence <= *last {
            return Err(ProtocolError::Replay {
                sequence: envelope.sequence,
                last_seen: *last,
            });
        }
        *last = envelope.sequence;
        Ok(())
    }
}

pub fn encode_json_line<T: Serialize>(value: &T) -> Result<Vec<u8>, ProtocolError> {
    let mut encoded =
        serde_json::to_vec(value).map_err(|error| ProtocolError::Encoding(error.to_string()))?;
    if encoded.len() + 1 > MAX_HELPER_LINE_BYTES {
        return Err(ProtocolError::MessageTooLarge(encoded.len() + 1));
    }
    if encoded.contains(&b'\n') || encoded.contains(&b'\r') {
        return Err(ProtocolError::Encoding(
            "serialized helper message contains a raw line break".into(),
        ));
    }
    encoded.push(b'\n');
    Ok(encoded)
}

pub fn decode_json_line<T>(line: &[u8]) -> Result<T, ProtocolError>
where
    T: for<'de> Deserialize<'de>,
{
    if line.len() > MAX_HELPER_LINE_BYTES {
        return Err(ProtocolError::MessageTooLarge(line.len()));
    }
    let content = line.strip_suffix(b"\n").unwrap_or(line);
    let content = content.strip_suffix(b"\r").unwrap_or(content);
    if content.is_empty() || content.contains(&b'\n') || content.contains(&b'\r') {
        return Err(ProtocolError::Encoding(
            "helper protocol requires exactly one non-empty JSON line".into(),
        ));
    }
    serde_json::from_slice(content).map_err(|error| ProtocolError::Encoding(error.to_string()))
}

fn compute_mac<T: Serialize>(key: &[u8], value: &T) -> Result<String, ProtocolError> {
    let bytes =
        serde_json::to_vec(value).map_err(|error| ProtocolError::Encoding(error.to_string()))?;
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| ProtocolError::Authentication("invalid session key".into()))?;
    mac.update(&bytes);
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn validate_bounded_token(label: &str, value: &str, max_bytes: usize) -> Result<(), ProtocolError> {
    if value.is_empty()
        || value.len() > max_bytes
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(ProtocolError::Encoding(format!(
            "{label} must be a bounded ASCII token"
        )));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), ProtocolError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ProtocolError::Authentication(
            "peer executable SHA-256 is invalid".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    #[error("helper protocol version mismatch: expected {expected}, got {actual}")]
    VersionMismatch { expected: u32, actual: u32 },
    #[error("helper protocol authentication failed: {0}")]
    Authentication(String),
    #[error("helper protocol replay: sequence {sequence}, last seen {last_seen}")]
    Replay { sequence: u64, last_seen: u64 },
    #[error("helper protocol message is too large: {0} bytes")]
    MessageTooLarge(usize),
    #[error("helper protocol encoding failed: {0}")]
    Encoding(String),
    #[error("helper protocol sequence exhausted")]
    SequenceExhausted,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; SESSION_KEY_BYTES] {
        [7; SESSION_KEY_BYTES]
    }

    #[test]
    fn authenticated_round_trip_rejects_replay() {
        let sender = ProtocolSession::new("session-1", &key()).unwrap();
        let receiver = ProtocolSession::new("session-1", &key()).unwrap();
        let message = sender
            .sign("request-1", 9, HelperRequest::Heartbeat { generation: 9 })
            .unwrap();
        let line = encode_json_line(&message).unwrap();
        let decoded: AuthenticatedEnvelope<HelperRequest> = decode_json_line(&line).unwrap();
        receiver.verify(&decoded).unwrap();
        assert!(matches!(
            receiver.verify(&decoded),
            Err(ProtocolError::Replay { .. })
        ));
    }

    #[test]
    fn tampering_is_detected_before_sequence_is_accepted() {
        let sender = ProtocolSession::new("session-1", &key()).unwrap();
        let receiver = ProtocolSession::new("session-1", &key()).unwrap();
        let mut message = sender
            .sign("request-1", 2, HelperRequest::Heartbeat { generation: 2 })
            .unwrap();
        message.generation = 3;
        assert!(matches!(
            receiver.verify(&message),
            Err(ProtocolError::Authentication(_))
        ));
    }

    #[test]
    fn wrong_session_key_is_rejected() {
        let sender = ProtocolSession::new("session-1", &key()).unwrap();
        let receiver = ProtocolSession::new("session-1", &[8; SESSION_KEY_BYTES]).unwrap();
        let message = sender.sign("request-1", 1, HelperRequest::Probe).unwrap();
        assert!(receiver.verify(&message).is_err());
    }

    #[test]
    fn sequence_exhaustion_does_not_wrap() {
        let session = ProtocolSession::new("session-1", &key()).unwrap();
        session.next_outbound.store(u64::MAX, Ordering::Relaxed);
        assert!(matches!(
            session.sign("request-1", 1, HelperRequest::Probe),
            Err(ProtocolError::SequenceExhausted)
        ));
        assert_eq!(session.next_outbound.load(Ordering::Relaxed), u64::MAX);
    }

    #[test]
    fn peer_requires_platform_verification_and_pinned_digest() {
        let digest = "ab".repeat(32);
        let mut peer = PeerIdentity {
            pid: 42,
            uid: Some(1000),
            executable_path: "/opt/taomni/taomni".into(),
            executable_sha256: digest.clone(),
            signing_identity: Some("com.taomni.app".into()),
            platform_verified: false,
        };
        let policy = CallerPolicy {
            expected_uid: Some(1000),
            allowed_executable_sha256: vec![digest],
            required_signing_identity: Some("com.taomni.app".into()),
        };
        assert!(verify_peer_identity(&peer, &policy).is_err());
        peer.platform_verified = true;
        assert!(verify_peer_identity(&peer, &policy).is_ok());
    }

    #[test]
    fn json_line_decoder_rejects_multiple_messages() {
        let error = decode_json_line::<HelperRequest>(b"{\"type\":\"probe\"}\n{}\n").unwrap_err();
        assert!(matches!(error, ProtocolError::Encoding(_)));
    }

    #[test]
    fn protocol_has_no_arbitrary_execute_command() {
        let request = HelperRequest::Heartbeat { generation: 3 };
        let json = serde_json::to_string(&request).unwrap();
        assert_eq!(json, r#"{"type":"heartbeat","generation":3}"#);
        assert!(!json.contains("command"));
        assert!(!json.contains("password"));
    }
}
