//! Metadata, order, usage, HOTP counters and explicit account reset.
use super::{
    accounts::{get_account, list_accounts},
    schema::sql_err,
};
use crate::{
    models::{MfaAccount, MfaAccountPatch},
    now_ms,
    validation::{MAX_ACCOUNT, MAX_GROUP, MAX_ISSUER, MAX_NOTE, clean_text, invalid},
};
use rusqlite::{Connection, params};

pub fn update_account(
    conn: &Connection,
    id: &str,
    patch: &MfaAccountPatch,
) -> Result<Option<MfaAccount>, String> {
    let issuer = clean_text(&patch.issuer, "issuer", MAX_ISSUER)?;
    let account_name = clean_text(&patch.account_name, "accountName", MAX_ACCOUNT)?;
    if issuer.is_empty() && account_name.is_empty() {
        return Err(invalid("issuer", "an issuer or account name is required"));
    }
    let group = clean_text(&patch.group, "group", MAX_GROUP)?;
    let note = clean_text(&patch.note, "note", MAX_NOTE)?;
    let changed = conn
        .execute(
            "UPDATE mfa_accounts SET issuer = ?2, account_name = ?3, group_name = ?4, note = ?5, \
             pinned = ?6, updated_at = ?7 WHERE id = ?1",
            params![
                id,
                issuer,
                account_name,
                group,
                note,
                patch.pinned as i64,
                now_ms()
            ],
        )
        .map_err(sql_err)?;
    if changed == 0 {
        return Ok(None);
    }
    get_account(conn, id)
}

pub fn delete_account(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.execute("DELETE FROM mfa_accounts WHERE id = ?1", params![id])
        .map(|n| n > 0)
        .map_err(sql_err)
}

/// Persist the custom order. Unknown ids are ignored and accounts missing from
/// `ids` keep their relative order after the listed ones, so a stale renderer
/// list can never drop an account out of the ordering.
pub fn reorder(conn: &mut Connection, ids: &[String]) -> Result<(), String> {
    let existing: Vec<String> = list_accounts(conn)?.into_iter().map(|a| a.id).collect();
    let mut ordered: Vec<&str> = Vec::with_capacity(existing.len());
    for id in ids {
        if existing.iter().any(|e| e == id) && !ordered.contains(&id.as_str()) {
            ordered.push(id.as_str());
        }
    }
    for id in &existing {
        if !ordered.contains(&id.as_str()) {
            ordered.push(id.as_str());
        }
    }
    let tx = conn.savepoint().map_err(sql_err)?;
    for (index, id) in ordered.iter().enumerate() {
        tx.execute(
            "UPDATE mfa_accounts SET sort_order = ?2 WHERE id = ?1",
            params![id, index as i64],
        )
        .map_err(sql_err)?;
    }
    tx.commit().map_err(sql_err)
}

/// Advance an HOTP counter. Returns `false` for unknown or non-HOTP accounts.
pub fn increment_counter(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.execute(
        "UPDATE mfa_accounts SET counter = counter + 1, updated_at = ?2 \
         WHERE id = ?1 AND kind = 'hotp'",
        params![id, now_ms()],
    )
    .map(|n| n > 0)
    .map_err(sql_err)
}

pub fn mark_used(conn: &Connection, id: &str) -> Result<Option<MfaAccount>, String> {
    let changed = conn
        .execute(
            "UPDATE mfa_accounts SET use_count = use_count + 1, last_used_at = ?2 WHERE id = ?1",
            params![id, now_ms()],
        )
        .map_err(sql_err)?;
    if changed == 0 {
        return Ok(None);
    }
    get_account(conn, id)
}

/// Remove every account and the key-check record (used after a lost key).
pub fn reset(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("DELETE FROM mfa_accounts; DELETE FROM mfa_meta;")
        .map_err(sql_err)
}
