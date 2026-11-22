//! Encrypt and fingerprint secrets inside the MFA writer.
use aes_gcm::{
    Nonce,
    aead::{Aead, Payload},
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use taomni_mfa_api::legacy::{NONCE_LEN, cipher};

use super::otp::{OtpAlgorithm, OtpKind};
pub use taomni_mfa_api::legacy::{DataKey, account_aad, open};

pub const KEY_KIND: &str = "mfa_secret";
pub const KEY_LABEL: &str = "MFA Data Key";

/// Seal `plaintext`, returning `(ciphertext, nonce)`.
pub fn seal(key: &DataKey, aad: &[u8], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut nonce = [0u8; NONCE_LEN];
    rand::fill(&mut nonce);
    let ciphertext = cipher(key)
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "MFA secret encryption failed".to_string())?;
    Ok((ciphertext, nonce.to_vec()))
}

/// Keyed fingerprint used for duplicate detection without storing plaintext.
pub fn fingerprint(
    key: &DataKey,
    kind: OtpKind,
    algorithm: OtpAlgorithm,
    digits: u32,
    period: u32,
    secret: &[u8],
) -> String {
    let mut mac = <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(key.as_slice())
        .expect("hmac accepts any key length");
    mac.update(b"taomni-mfa-fp\0");
    mac.update(kind.as_str().as_bytes());
    mac.update(algorithm.as_str().as_bytes());
    mac.update(&digits.to_be_bytes());
    mac.update(&period.to_be_bytes());
    mac.update(secret);
    hex::encode(mac.finalize().into_bytes())
}
