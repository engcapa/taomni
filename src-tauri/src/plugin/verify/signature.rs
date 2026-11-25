//! Minisign adapter shared by signed catalogues and package archives.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use base64::{Engine, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};

use super::TrustError;

pub(super) const MAX_SIGNATURE_BYTES: usize = 16 * 1024;
const MAX_LEGACY_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(super) struct SignatureVerifier {
    key: PublicKey,
}

impl SignatureVerifier {
    pub(super) fn embedded() -> Result<Self, TrustError> {
        #[cfg(all(test, not(feature = "qa-release-trust-gates")))]
        {
            Ok(super::test_support::verifier())
        }
        #[cfg(any(not(test), feature = "qa-release-trust-gates"))]
        {
            Self::release_key()
        }
    }

    pub(super) fn release_key() -> Result<Self, TrustError> {
        // Use the same release identity as the core updater. A package cannot
        // nominate its own key, and renderer input never changes this anchor.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../../tauri.conf.json"))?;
        let encoded = config["plugins"]["updater"]["pubkey"]
            .as_str()
            .ok_or_else(|| TrustError::Signature("embedded release key is missing".into()))?;
        Self::encoded_key(encoded)
    }

    fn encoded_key(encoded: &str) -> Result<Self, TrustError> {
        let raw = STANDARD
            .decode(encoded.trim())
            .map_err(|error| TrustError::Signature(error.to_string()))?;
        let text =
            std::str::from_utf8(&raw).map_err(|error| TrustError::Signature(error.to_string()))?;
        let key =
            PublicKey::decode(text).map_err(|error| TrustError::Signature(error.to_string()))?;
        Ok(Self { key })
    }

    #[cfg(test)]
    pub(super) fn test_key(encoded: &str) -> Self {
        Self::encoded_key(encoded).unwrap()
    }

    pub(super) fn verify_bytes(&self, bytes: &[u8], detached: &str) -> Result<String, TrustError> {
        let signature = parse_signature(detached)?;
        self.key
            .verify(bytes, &signature, true)
            .map_err(|error| TrustError::Signature(error.to_string()))?;
        Ok(signature.trusted_comment().to_owned())
    }

    pub(super) fn verify_file(
        &self,
        file: &mut File,
        detached: &str,
    ) -> Result<String, TrustError> {
        let signature = parse_signature(detached)?;
        file.seek(SeekFrom::Start(0))?;
        match self.key.verify_stream(&signature) {
            Ok(mut stream) => {
                let mut buffer = [0_u8; 128 * 1024];
                loop {
                    let count = file.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    stream.update(&buffer[..count]);
                }
                stream
                    .finalize()
                    .map_err(|error| TrustError::Signature(error.to_string()))?;
            }
            Err(minisign_verify::Error::UnsupportedLegacyMode) => {
                // Older Tauri signers use raw Ed25519. Bound memory use;
                // larger plugins must be signed in Minisign's streaming mode.
                let mut bytes = Vec::new();
                (&mut *file)
                    .take(MAX_LEGACY_BYTES + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() as u64 > MAX_LEGACY_BYTES {
                    return Err(TrustError::Signature(
                        "legacy signature exceeds 32 MiB; use prehashed Minisign".into(),
                    ));
                }
                self.key
                    .verify(&bytes, &signature, true)
                    .map_err(|error| TrustError::Signature(error.to_string()))?;
            }
            Err(error) => return Err(TrustError::Signature(error.to_string())),
        }
        file.seek(SeekFrom::Start(0))?;
        Ok(signature.trusted_comment().to_owned())
    }
}

fn parse_signature(input: &str) -> Result<Signature, TrustError> {
    Signature::decode(&signature_envelope(input)?)
        .map_err(|error| TrustError::Signature(error.to_string()))
}

/// Catalogs and sidecars can carry the same four signed-envelope lines with
/// different line endings or with the Tauri base64 transport wrapper.
pub(super) fn signature_envelope(input: &str) -> Result<String, TrustError> {
    if input.len() > MAX_SIGNATURE_BYTES {
        return Err(TrustError::Signature("signature is too large".into()));
    }
    let decoded;
    let text = if input.trim_start().starts_with("untrusted comment: ") {
        input.trim()
    } else {
        decoded = STANDARD
            .decode(input.trim())
            .map_err(|error| TrustError::Signature(error.to_string()))?;
        std::str::from_utf8(&decoded)
            .map_err(|error| TrustError::Signature(error.to_string()))?
            .trim()
    };
    if text.lines().count() != 4 || !text.starts_with("untrusted comment: ") {
        return Err(TrustError::Signature("invalid Minisign envelope".into()));
    }
    Ok(text.replace("\r\n", "\n"))
}
