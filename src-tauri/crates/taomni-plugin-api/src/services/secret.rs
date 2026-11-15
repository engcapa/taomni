use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use zeroize::{Zeroize, Zeroizing};

use crate::RequestId;

/// A single-operation data key. Deliberately neither Clone nor Display.
pub struct SecretKey32(Zeroizing<[u8; 32]>);

impl SecretKey32 {
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for SecretKey32 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretKey32([REDACTED])")
    }
}

impl Serialize for SecretKey32 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let encoded = Zeroizing::new(STANDARD.encode(self.0.as_slice()));
        serializer.serialize_str(encoded.as_str())
    }
}

impl<'de> Deserialize<'de> for SecretKey32 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct KeyVisitor;
        impl serde::de::Visitor<'_> for KeyVisitor {
            type Value = SecretKey32;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a Base64 encoded 32-byte data key")
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                let mut bytes = Zeroizing::new([0u8; 32]);
                let count = STANDARD
                    .decode_slice(value, bytes.as_mut_slice())
                    .map_err(|_| E::custom("invalid data key encoding"))?;
                if count != 32 {
                    return Err(E::custom("invalid data key length"));
                }
                Ok(SecretKey32(bytes))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                mut value: String,
            ) -> Result<Self::Value, E> {
                let result = self.visit_str(&value);
                value.zeroize();
                result
            }
        }
        deserializer.deserialize_str(KeyVisitor)
    }
}

/// Encode directly to zeroizing bytes; this type intentionally has no Debug,
/// Clone or Value conversion. The transport must retain this ownership until
/// the write has completed or been discarded, including queued writes.
#[derive(Serialize)]
pub struct SensitiveRpcResponse<T> {
    jsonrpc: &'static str,
    id: RequestId,
    result: T,
}

impl<T: Serialize> SensitiveRpcResponse<T> {
    pub fn success(id: RequestId, result: T) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result,
        }
    }

    pub fn encode_line(&self) -> Result<Zeroizing<Vec<u8>>, serde_json::Error> {
        let mut bytes = Zeroizing::new(Vec::new());
        serde_json::to_writer(&mut *bytes, self)?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}
