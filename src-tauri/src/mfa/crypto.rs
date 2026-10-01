//! MFA data-key management and secret sealing.
//!
//! A random 256-bit data key is stored in the credential vault under
//! [`crate::vault::MFA_DATA_KEY_ENTRY_ID`]. `mfa.db` keeps a key-check record
//! so a restored or mismatched database is detected instead of producing
//! garbage codes. Every secret is AES-256-GCM sealed with its account id as
//! associated data, so ciphertexts cannot be swapped between rows.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use hmac::{Hmac, Mac};
use rusqlite::Connection;
use sha2::Sha256;
use zeroize::Zeroizing;

use super::otp::{OtpAlgorithm, OtpKind};
use super::{ERR_KEY_MISMATCH, ERR_KEY_MISSING, store};
use crate::vault::crypto::{KEY_LEN, NONCE_LEN, random_nonce};
use crate::vault::{MFA_DATA_KEY_ENTRY_ID, Vault};

pub const KEY_KIND: &str = "mfa_secret";
pub const KEY_LABEL: &str = "MFA Data Key";
const KEY_CHECK_META: &str = "key_check";
const KEY_CHECK_AAD: &[u8] = b"taomni-mfa:key-check";
const KEY_CHECK_PLAINTEXT: &[u8] = b"taomni-mfa-key-check-v1";

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
    let nonce = random_nonce();
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

fn load_key(vault: &Vault) -> Result<Option<DataKey>, String> {
    let Some(encoded) = vault.get_fixed(MFA_DATA_KEY_ENTRY_ID)? else {
        return Ok(None);
    };
    let bytes = Zeroizing::new(
        BASE64
            .decode(encoded.trim())
            .map_err(|_| ERR_KEY_MISMATCH.to_string())?,
    );
    if bytes.len() != KEY_LEN {
        return Err(ERR_KEY_MISMATCH.to_string());
    }
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    key.copy_from_slice(&bytes);
    Ok(Some(key))
}

fn create_key(vault: &Vault) -> Result<DataKey, String> {
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    rand::fill(key.as_mut_slice());
    let encoded = Zeroizing::new(BASE64.encode(key.as_slice()));
    vault.put_fixed(MFA_DATA_KEY_ENTRY_ID, KEY_KIND, KEY_LABEL, &encoded)?;
    Ok(key)
}

fn write_key_check(conn: &Connection, key: &DataKey) -> Result<(), String> {
    let (ciphertext, nonce) = seal(key, KEY_CHECK_AAD, KEY_CHECK_PLAINTEXT)?;
    let mut record = nonce;
    record.extend_from_slice(&ciphertext);
    store::meta_set(conn, KEY_CHECK_META, &record)
}

fn key_matches_check(key: &DataKey, record: &[u8]) -> bool {
    if record.len() <= NONCE_LEN {
        return false;
    }
    let (nonce, ciphertext) = record.split_at(NONCE_LEN);
    open(key, KEY_CHECK_AAD, ciphertext, nonce)
        .map(|plain| plain.as_slice() == KEY_CHECK_PLAINTEXT)
        .unwrap_or(false)
}

/// Return the data key for `conn`, creating it on first use.
///
/// Errors: `VAULT_LOCKED` (vault empty/locked), [`ERR_KEY_MISSING`] when the
/// database holds sealed data but the vault has no key, [`ERR_KEY_MISMATCH`]
/// when the vault key does not open this database.
pub fn ensure_key(conn: &Connection, vault: &Vault) -> Result<DataKey, String> {
    let stored = load_key(vault)?;
    let check = store::meta_get(conn, KEY_CHECK_META)?;
    let accounts = store::count_accounts(conn)?;
    match (stored, check) {
        (Some(key), Some(record)) => {
            if key_matches_check(&key, &record) {
                Ok(key)
            } else {
                Err(ERR_KEY_MISMATCH.to_string())
            }
        }
        (Some(key), None) => {
            if accounts > 0 && !store::first_secret_opens(conn, &key)? {
                return Err(ERR_KEY_MISMATCH.to_string());
            }
            write_key_check(conn, &key)?;
            Ok(key)
        }
        (None, None) if accounts == 0 => {
            let key = create_key(vault)?;
            write_key_check(conn, &key)?;
            Ok(key)
        }
        (None, _) => Err(ERR_KEY_MISSING.to_string()),
    }
}

/// Re-bind an emptied database to the vault key. A missing or malformed vault
/// entry is replaced; a locked vault keeps returning `VAULT_LOCKED`.
pub fn rebind_after_reset(conn: &Connection, vault: &Vault) -> Result<DataKey, String> {
    let key = match load_key(vault) {
        Ok(Some(key)) => key,
        Ok(None) => create_key(vault)?,
        Err(err) if err == ERR_KEY_MISMATCH => create_key(vault)?,
        Err(err) => return Err(err),
    };
    write_key_check(conn, &key)?;
    Ok(key)
}
