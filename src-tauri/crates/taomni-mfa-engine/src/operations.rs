//! MFA workflows used by IPC adapters. Admission and password grants belong to
//! the owner and must precede these operations on its connection and data key.
use rusqlite::Connection;

use crate::crypto::DataKey;
use crate::models::{
    MfaAccount, MfaAccountInput, MfaAccountPatch, MfaAddResult, MfaCode, MfaInspectItem,
    MfaSnapshot,
};
use crate::{ERR_INVALID_INPUT, ERR_NOT_FOUND, now_ms, otp, store};

pub use crate::store::{reorder, set_prefs};

fn not_found() -> String {
    ERR_NOT_FOUND.to_string()
}

pub fn list(conn: &Connection) -> Result<MfaSnapshot, String> {
    Ok(MfaSnapshot {
        accounts: store::list_accounts(conn)?,
        prefs: store::get_prefs(conn)?,
    })
}

pub fn codes(
    conn: &Connection,
    key: &DataKey,
    ids: Option<&[String]>,
    now_ms: i64,
) -> Result<Vec<MfaCode>, String> {
    let mut codes = Vec::new();
    for sealed in store::list_sealed(conn)? {
        if ids.is_some_and(|wanted| !wanted.contains(&sealed.account.id)) {
            continue;
        }
        let secret = store::open_secret(key, &sealed)?;
        codes.push(store::code_for(&sealed.account, &secret, now_ms));
    }
    Ok(codes)
}

pub fn inspect(
    conn: &Connection,
    key: &DataKey,
    inputs: &[MfaAccountInput],
) -> Result<Vec<MfaInspectItem>, String> {
    inputs
        .iter()
        .map(|input| match store::validate_input(input) {
            Ok(valid) => Ok(MfaInspectItem {
                ok: true,
                error: None,
                duplicate_of: store::find_duplicate(conn, &store::fingerprint_of(key, &valid))?,
            }),
            Err(error) => Ok(MfaInspectItem {
                ok: false,
                error: Some(error),
                duplicate_of: None,
            }),
        })
        .collect()
}

/// Validate all inputs before inserting; any duplicate rejection rolls back
/// the entire batch, including accounts inserted earlier in that batch.
pub fn add(
    conn: &mut Connection,
    key: &DataKey,
    inputs: &[MfaAccountInput],
    skip_duplicates: bool,
) -> Result<MfaAddResult, String> {
    let valid = inputs
        .iter()
        .map(store::validate_input)
        .collect::<Result<Vec<_>, _>>()?;
    let tx = conn.savepoint().map_err(|e| format!("mfa database: {e}"))?;
    let mut result = MfaAddResult {
        added: Vec::new(),
        duplicates: Vec::new(),
    };
    for (index, account) in valid.iter().enumerate() {
        let fingerprint = store::fingerprint_of(key, account);
        if store::find_duplicate(&tx, &fingerprint)?.is_some() {
            if skip_duplicates {
                result.duplicates.push(index);
                continue;
            }
            return Err(format!(
                "{ERR_INVALID_INPUT}: secret: account already exists"
            ));
        }
        result.added.push(store::insert_account(&tx, key, account)?);
    }
    tx.commit().map_err(|e| format!("mfa database: {e}"))?;
    Ok(result)
}

pub fn update(conn: &Connection, id: &str, patch: &MfaAccountPatch) -> Result<MfaAccount, String> {
    store::update_account(conn, id, patch)?.ok_or_else(not_found)
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    if store::delete_account(conn, id)? {
        Ok(())
    } else {
        Err(not_found())
    }
}

pub fn hotp_next(conn: &Connection, key: &DataKey, id: &str) -> Result<MfaCode, String> {
    if !store::increment_counter(conn, id)? {
        return Err(not_found());
    }
    let sealed = store::get_sealed(conn, id)?.ok_or_else(not_found)?;
    let secret = store::open_secret(key, &sealed)?;
    Ok(store::code_for(&sealed.account, &secret, now_ms()))
}

pub fn mark_used(conn: &Connection, id: &str) -> Result<MfaAccount, String> {
    store::mark_used(conn, id)?.ok_or_else(not_found)
}

/// Call only after the owner has verified an operation-scoped export grant.
/// This is the sole workflow returning a stored account secret to its caller.
pub fn export_uri(conn: &Connection, key: &DataKey, id: &str) -> Result<String, String> {
    let sealed = store::get_sealed(conn, id)?.ok_or_else(not_found)?;
    let secret = store::open_secret(key, &sealed)?;
    let account = &sealed.account;
    Ok(otp::otpauth_uri(&otp::OtpauthFields {
        kind: account.kind,
        issuer: &account.issuer,
        account_name: &account.account_name,
        secret: &secret,
        algorithm: account.algorithm,
        digits: account.digits,
        period: account.period,
        counter: account.counter,
    }))
}
