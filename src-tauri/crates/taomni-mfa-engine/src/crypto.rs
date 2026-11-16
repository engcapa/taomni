//! Original AES-256-GCM row binding and keyed duplicate fingerprints.
//! Key resolution and store binding live in keys; primitives never open a store.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

use super::otp::{OtpAlgorithm, OtpKind};
use crate::ERR_KEY_MISMATCH;

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

pub const KEY_KIND: &str = "mfa_secret";
pub const KEY_LABEL: &str = "MFA Data Key";

pub type DataKey = Zeroizing<[u8; KEY_LEN]>;

fn cipher(key: &DataKey) -> Aes256Gcm {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_slice()))
}

/// Associated data binding a sealed secret to its account row.
pub fn account_aad(id: &str) -> Vec<u8> {
    format!("taomni-mfa:{id}").into_bytes()
}

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

/// Open a sealed secret. Any failure means the key or row does not match.
pub fn open(
    key: &DataKey,
    aad: &[u8],
    ciphertext: &[u8],
    nonce: &[u8],
) -> Result<Zeroizing<Vec<u8>>, String> {
    if nonce.len() != NONCE_LEN {
        return Err(ERR_KEY_MISMATCH.to_string());
    }
    cipher(key)
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| ERR_KEY_MISMATCH.to_string())
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
