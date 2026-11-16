//! Account metadata, sealed records, duplicate lookup and insertion.
use super::schema::sql_err;
use crate::{
    crypto::{self, DataKey},
    models::{MfaAccount, ValidAccount},
    now_ms,
    otp::{OtpAlgorithm, OtpKind},
};
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;
use zeroize::Zeroizing;

const ACCOUNT_COLUMNS: &str = "id, issuer, account_name, group_name, note, kind, algorithm, \
    digits, period, counter, pinned, sort_order, use_count, last_used_at, created_at, updated_at";

fn row_to_account(row: &rusqlite::Row<'_>) -> rusqlite::Result<MfaAccount> {
    let kind: String = row.get(5)?;
    let algorithm: String = row.get(6)?;
    Ok(MfaAccount {
        id: row.get(0)?,
        issuer: row.get(1)?,
        account_name: row.get(2)?,
        group: row.get(3)?,
        note: row.get(4)?,
        kind: OtpKind::parse(&kind).unwrap_or(OtpKind::Totp),
        algorithm: OtpAlgorithm::parse(&algorithm).unwrap_or(OtpAlgorithm::Sha1),
        digits: row.get(7)?,
        period: row.get(8)?,
        counter: row.get::<_, i64>(9)?.max(0) as u64,
        pinned: row.get::<_, i64>(10)? != 0,
        sort_order: row.get(11)?,
        use_count: row.get(12)?,
        last_used_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

pub fn list_accounts(conn: &Connection) -> Result<Vec<MfaAccount>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ACCOUNT_COLUMNS} FROM mfa_accounts ORDER BY sort_order, created_at, id"
        ))
        .map_err(sql_err)?;
    let rows = stmt.query_map([], row_to_account).map_err(sql_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
}

pub fn get_account(conn: &Connection, id: &str) -> Result<Option<MfaAccount>, String> {
    conn.query_row(
        &format!("SELECT {ACCOUNT_COLUMNS} FROM mfa_accounts WHERE id = ?1"),
        params![id],
        row_to_account,
    )
    .optional()
    .map_err(sql_err)
}

pub fn count_accounts(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM mfa_accounts", [], |row| row.get(0))
        .map_err(sql_err)
}

/// Account metadata plus its sealed secret, used only inside the backend.
pub struct SealedAccount {
    pub account: MfaAccount,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
}

fn row_to_sealed(row: &rusqlite::Row<'_>) -> rusqlite::Result<SealedAccount> {
    Ok(SealedAccount {
        account: row_to_account(row)?,
        ciphertext: row.get(16)?,
        nonce: row.get(17)?,
    })
}

pub fn list_sealed(conn: &Connection) -> Result<Vec<SealedAccount>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ACCOUNT_COLUMNS}, secret_ct, secret_nonce FROM mfa_accounts \
             ORDER BY sort_order, created_at, id"
        ))
        .map_err(sql_err)?;
    let rows = stmt.query_map([], row_to_sealed).map_err(sql_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
}

pub fn get_sealed(conn: &Connection, id: &str) -> Result<Option<SealedAccount>, String> {
    conn.query_row(
        &format!(
            "SELECT {ACCOUNT_COLUMNS}, secret_ct, secret_nonce FROM mfa_accounts WHERE id = ?1"
        ),
        params![id],
        row_to_sealed,
    )
    .optional()
    .map_err(sql_err)
}

pub fn open_secret(key: &DataKey, sealed: &SealedAccount) -> Result<Zeroizing<Vec<u8>>, String> {
    crypto::open(
        key,
        &crypto::account_aad(&sealed.account.id),
        &sealed.ciphertext,
        &sealed.nonce,
    )
}

/// Whether the first stored secret opens with `key` (true for an empty table).
pub fn first_secret_opens(conn: &Connection, key: &DataKey) -> Result<bool, String> {
    let first = conn
        .query_row(
            &format!(
                "SELECT {ACCOUNT_COLUMNS}, secret_ct, secret_nonce FROM mfa_accounts \
                 ORDER BY created_at LIMIT 1"
            ),
            [],
            row_to_sealed,
        )
        .optional()
        .map_err(sql_err)?;
    Ok(first.is_none_or(|sealed| open_secret(key, &sealed).is_ok()))
}

pub fn find_duplicate(conn: &Connection, fingerprint: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id FROM mfa_accounts WHERE fingerprint = ?1 ORDER BY created_at LIMIT 1",
        params![fingerprint],
        |row| row.get(0),
    )
    .optional()
    .map_err(sql_err)
}

pub fn fingerprint_of(key: &DataKey, valid: &ValidAccount) -> String {
    crypto::fingerprint(
        key,
        valid.kind,
        valid.algorithm,
        valid.digits,
        valid.period,
        &valid.secret,
    )
}

pub fn insert_account(
    conn: &Connection,
    key: &DataKey,
    valid: &ValidAccount,
) -> Result<MfaAccount, String> {
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let (ciphertext, nonce) = crypto::seal(key, &crypto::account_aad(&id), &valid.secret)?;
    let fingerprint = fingerprint_of(key, valid);
    let sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM mfa_accounts",
            [],
            |row| row.get(0),
        )
        .map_err(sql_err)?;
    conn.execute(
        "INSERT INTO mfa_accounts (id, issuer, account_name, group_name, note, kind, algorithm, \
         digits, period, counter, secret_ct, secret_nonce, fingerprint, pinned, sort_order, \
         use_count, last_used_at, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, 0, NULL, ?15, ?15)",
        params![
            id,
            valid.issuer,
            valid.account_name,
            valid.group,
            valid.note,
            valid.kind.as_str(),
            valid.algorithm.as_str(),
            valid.digits,
            valid.period,
            valid.counter as i64,
            ciphertext,
            nonce,
            fingerprint,
            sort_order,
            now,
        ],
    )
    .map_err(sql_err)?;
    get_account(conn, &id)?.ok_or_else(|| "mfa account vanished after insert".to_string())
}
