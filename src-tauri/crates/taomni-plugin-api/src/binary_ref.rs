use std::net::{Ipv4Addr, SocketAddrV4};

use serde::{Deserialize, Serialize};

use super::{ErrorCode, RpcError};

/// Reference to a high-bandwidth payload transferred over the authenticated
/// loopback WebSocket. The JSON-RPC response only carries this small descriptor.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryRef {
    pub stream_url: String,
    pub token: String,
    pub content_type: String,
    pub byte_len: u64,
    pub sha256: String,
}

impl BinaryRef {
    pub fn validate(&self) -> Result<(), RpcError> {
        if !valid_stream_url(&self.stream_url) {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "Binary stream must use the loopback WebSocket",
            ));
        }
        if self.token.is_empty()
            || self.sha256.len() != 64
            || !self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "Binary stream token and SHA-256 are required",
            ));
        }
        Ok(())
    }
}

fn valid_stream_url(url: &str) -> bool {
    if url.contains('#')
        || url
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace() || byte == b'\\')
    {
        return false;
    }
    // Parse the entire authority, not a prefix: a userinfo suffix such as
    // `127.0.0.1:1234@remote` must never authorize a non-loopback endpoint.
    let Some(rest) = url
        .strip_prefix("ws://")
        .or_else(|| url.strip_prefix("wss://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?']).next().unwrap_or_default();
    authority
        .parse::<SocketAddrV4>()
        .is_ok_and(|address| *address.ip() == Ipv4Addr::LOCALHOST && address.port() != 0)
}
