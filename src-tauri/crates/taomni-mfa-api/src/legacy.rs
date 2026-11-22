//! Read-only validation of a consistent legacy snapshot against its Vault key.
use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use rusqlite::{Connection, OptionalExtension};
use zeroize::Zeroizing;

use crate::{ERR_KEY_MISMATCH, ERR_KEY_MISSING};

pub const NONCE_LEN: usize = 12;
pub const KEY_CHECK_META: &str = "key_check";
pub const KEY_CHECK_AAD: &[u8] = b"taomni-mfa:key-check";
pub const KEY_CHECK_PLAINTEXT: &[u8] = b"taomni-mfa-key-check-v1";
pub type DataKey = Zeroizing<[u8; 32]>;

pub fn cipher(key: &DataKey) -> Aes256Gcm {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_slice()))
}

pub fn account_aad(id: &str) -> Vec<u8> {
    format!("taomni-mfa:{id}").into_bytes()
}

pub fn open(
    key: &DataKey,
    aad: &[u8],
    ciphertext: &[u8],
    nonce: &[u8],
) -> Result<Zeroizing<Vec<u8>>, String> {
    if nonce.len() != NONCE_LEN {
        return Err(ERR_KEY_MISMATCH.into());
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
        .map_err(|_| ERR_KEY_MISMATCH.into())
}

pub fn key_matches_check(key: &DataKey, record: &[u8]) -> bool {
    let Some((nonce, ciphertext)) = record.split_at_checked(NONCE_LEN) else {
        return false;
    };
    open(key, KEY_CHECK_AAD, ciphertext, nonce)
        .is_ok_and(|plain| plain.as_slice() == KEY_CHECK_PLAINTEXT)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExistingKeyCheck {
    Unused,
    Verified {
        accounts: u64,
        key_check_present: bool,
    },
}

/// Verify every row without binding, initializing or repairing the store.
pub fn verify_existing_key(
    conn: &Connection,
    key: Option<&DataKey>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<ExistingKeyCheck, String> {
    check()?;
    let record: Option<Vec<u8>> = conn
        .query_row(
            "SELECT value FROM mfa_meta WHERE key = ?1",
            [KEY_CHECK_META],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    let Some(key) = key else {
        let accounts: i64 = conn
            .query_row("SELECT COUNT(*) FROM mfa_accounts", [], |row| row.get(0))
            .map_err(sql_error)?;
        check()?;
        return if record.is_none() && accounts == 0 {
            Ok(ExistingKeyCheck::Unused)
        } else {
            Err(ERR_KEY_MISSING.into())
        };
    };
    check()?;
    if record
        .as_ref()
        .is_some_and(|record| !key_matches_check(key, record))
    {
        return Err(ERR_KEY_MISMATCH.into());
    }
    let mut statement = conn
        .prepare("SELECT id, secret_ct, secret_nonce FROM mfa_accounts ORDER BY id")
        .map_err(sql_error)?;
    let mut rows = statement.query([]).map_err(sql_error)?;
    let mut accounts = 0_u64;
    loop {
        check()?;
        let Some(row) = rows.next().map_err(sql_error)? else {
            break;
        };
        let id: String = row.get(0).map_err(sql_error)?;
        let ciphertext: Vec<u8> = row.get(1).map_err(sql_error)?;
        let nonce: Vec<u8> = row.get(2).map_err(sql_error)?;
        drop(open(key, &account_aad(&id), &ciphertext, &nonce)?);
        check()?;
        accounts = accounts
            .checked_add(1)
            .ok_or("MFA account count overflow")?;
    }
    Ok(ExistingKeyCheck::Verified {
        accounts,
        key_check_present: record.is_some(),
    })
}

fn sql_error(error: rusqlite::Error) -> String {
    format!("mfa database: {error}")
}
