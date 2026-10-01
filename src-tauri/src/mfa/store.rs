//! `mfa.db` storage. The connection is opened lazily so a damaged MFA database
//! only affects MFA commands instead of blocking application startup.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::crypto::{self, DataKey};
use super::otp::{self, OtpAlgorithm, OtpKind};
use super::{ERR_INVALID_INPUT, now_ms};

pub const SCHEMA_VERSION: i64 = 1;
pub const SORT_MODES: &[&str] = &["custom", "issuer", "account", "recent", "frequent", "added"];
const MAX_ISSUER: usize = 128;
const MAX_ACCOUNT: usize = 256;
const MAX_GROUP: usize = 64;
const MAX_NOTE: usize = 1024;

pub struct MfaStore {
    path: PathBuf,
    conn: Mutex<Option<Connection>>,
}

impl MfaStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            conn: Mutex::new(None),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Run `f` on the connection, opening and migrating `mfa.db` on first use.
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.conn.lock().map_err(|e| format!("mfa db lock: {e}"))?;
        if guard.is_none() {
            *guard = Some(open_db(&self.path)?);
        }
        f(guard.as_mut().expect("mfa connection initialised above"))
    }

    /// Consistent snapshot for backups. Returns `false` when MFA was never
    /// used (no file on disk and no open connection), so nothing is staged.
    pub fn backup_to(&self, dest: &Path) -> Result<bool, String> {
        {
            let guard = self.conn.lock().map_err(|e| format!("mfa db lock: {e}"))?;
            if guard.is_none() && !self.path.is_file() {
                return Ok(false);
            }
        }
        self.with_conn(|conn| crate::backup::engine::hot_backup_conn(conn, dest))?;
        Ok(true)
    }
}

fn open_db(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create mfa data dir: {e}"))?;
    }
    let conn =
        Connection::open(path).map_err(|e| format!("open mfa database {}: {e}", path.display()))?;
    init_db(&conn).map_err(|e| format!("init mfa database: {e}"))?;
    Ok(conn)
}

pub fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mfa_accounts (
            id TEXT PRIMARY KEY,
            issuer TEXT NOT NULL DEFAULT '',
            account_name TEXT NOT NULL DEFAULT '',
            group_name TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT 'totp',
            algorithm TEXT NOT NULL DEFAULT 'SHA1',
            digits INTEGER NOT NULL DEFAULT 6,
            period INTEGER NOT NULL DEFAULT 30,
            counter INTEGER NOT NULL DEFAULT 0,
            secret_ct BLOB NOT NULL,
            secret_nonce BLOB NOT NULL,
            fingerprint TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            use_count INTEGER NOT NULL DEFAULT 0,
            last_used_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mfa_accounts_fingerprint ON mfa_accounts(fingerprint);
        CREATE TABLE IF NOT EXISTS mfa_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS mfa_prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version < SCHEMA_VERSION {
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/// Account metadata sent to the renderer. Never carries the secret.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MfaAccount {
    pub id: String,
    pub issuer: String,
    pub account_name: String,
    pub group: String,
    pub note: String,
    pub kind: OtpKind,
    pub algorithm: OtpAlgorithm,
    pub digits: u32,
    pub period: u32,
    pub counter: u64,
    pub pinned: bool,
    pub sort_order: i64,
    pub use_count: i64,
    pub last_used_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Structured account the renderer parsed from a form, otpauth link or QR code.
/// Enumerations stay strings so bad values become field errors, not IPC errors.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaAccountInput {
    #[serde(default)]
    pub issuer: String,
    #[serde(default)]
    pub account_name: String,
    pub secret: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default = "default_algorithm")]
    pub algorithm: String,
    #[serde(default = "default_digits")]
    pub digits: u32,
    #[serde(default = "default_period")]
    pub period: u32,
    #[serde(default)]
    pub counter: u64,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub note: String,
}

fn default_kind() -> String {
    "totp".into()
}
fn default_algorithm() -> String {
    "SHA1".into()
}
fn default_digits() -> u32 {
    6
}
fn default_period() -> u32 {
    30
}

/// Full replacement of the user-editable metadata.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaAccountPatch {
    pub issuer: String,
    pub account_name: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MfaPrefs {
    pub sort_mode: String,
    #[serde(default)]
    pub group_filter: String,
}

impl Default for MfaPrefs {
    fn default() -> Self {
        Self {
            sort_mode: "custom".into(),
            group_filter: String::new(),
        }
    }
}

/// One generated code. TOTP rows carry their validity window; HOTP rows do not.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MfaCode {
    pub id: String,
    pub code: String,
    pub next_code: Option<String>,
    pub period: u32,
    pub counter: u64,
    pub valid_from_ms: Option<i64>,
    pub valid_until_ms: Option<i64>,
}

/// Validated input with the decoded secret held in zeroizing memory.
pub struct ValidAccount {
    pub issuer: String,
    pub account_name: String,
    pub group: String,
    pub note: String,
    pub kind: OtpKind,
    pub algorithm: OtpAlgorithm,
    pub digits: u32,
    pub period: u32,
    pub counter: u64,
    pub secret: Zeroizing<Vec<u8>>,
}

fn invalid(field: &str, detail: &str) -> String {
    format!("{ERR_INVALID_INPUT}: {field}: {detail}")
}

fn clean_text(value: &str, field: &str, max: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.chars().count() > max {
        return Err(invalid(field, &format!("longer than {max} characters")));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(invalid(field, "contains control characters"));
    }
    Ok(trimmed.to_string())
}

pub fn validate_input(input: &MfaAccountInput) -> Result<ValidAccount, String> {
    let issuer = clean_text(&input.issuer, "issuer", MAX_ISSUER)?;
    let account_name = clean_text(&input.account_name, "accountName", MAX_ACCOUNT)?;
    if issuer.is_empty() && account_name.is_empty() {
        return Err(invalid("issuer", "an issuer or account name is required"));
    }
    let group = clean_text(&input.group, "group", MAX_GROUP)?;
    let note = clean_text(&input.note, "note", MAX_NOTE)?;
    let kind = OtpKind::parse(&input.kind.trim().to_ascii_lowercase())
        .ok_or_else(|| invalid("kind", "must be totp or hotp"))?;
    let algorithm =
        OtpAlgorithm::parse(&input.algorithm.trim().to_ascii_uppercase().replace('-', ""))
            .ok_or_else(|| invalid("algorithm", "must be SHA1, SHA256 or SHA512"))?;
    if !(otp::MIN_DIGITS..=otp::MAX_DIGITS).contains(&input.digits) {
        return Err(invalid("digits", "must be 6, 7 or 8"));
    }
    let period = match kind {
        OtpKind::Totp => {
            if !(otp::MIN_PERIOD..=otp::MAX_PERIOD).contains(&input.period) {
                return Err(invalid("period", "must be between 15 and 300 seconds"));
            }
            input.period
        }
        OtpKind::Hotp => default_period(),
    };
    let counter = match kind {
        OtpKind::Hotp => input.counter,
        OtpKind::Totp => 0,
    };
    let secret =
        Zeroizing::new(otp::decode_base32(&input.secret).map_err(|e| invalid("secret", &e))?);
    if secret.is_empty() {
        return Err(invalid("secret", "is required"));
    }
    if secret.len() < otp::MIN_SECRET_BYTES {
        return Err(invalid(
            "secret",
            "is too short (at least 16 Base32 characters)",
        ));
    }
    Ok(ValidAccount {
        issuer,
        account_name,
        group,
        note,
        kind,
        algorithm,
        digits: input.digits,
        period,
        counter,
        secret,
    })
}

/// Current (and, for TOTP, next) code for `account` at `now_ms`.
pub fn code_for(account: &MfaAccount, secret: &[u8], now_ms: i64) -> MfaCode {
    match account.kind {
        OtpKind::Totp => {
            let step = otp::totp_step(now_ms, account.period);
            let period_ms = i64::from(account.period) * 1000;
            let valid_from = step as i64 * period_ms;
            MfaCode {
                id: account.id.clone(),
                code: otp::hotp(secret, step, account.digits, account.algorithm),
                next_code: Some(otp::hotp(
                    secret,
                    step + 1,
                    account.digits,
                    account.algorithm,
                )),
                period: account.period,
                counter: step,
                valid_from_ms: Some(valid_from),
                valid_until_ms: Some(valid_from + period_ms),
            }
        }
        OtpKind::Hotp => MfaCode {
            id: account.id.clone(),
            code: otp::hotp(secret, account.counter, account.digits, account.algorithm),
            next_code: None,
            period: account.period,
            counter: account.counter,
            valid_from_ms: None,
            valid_until_ms: None,
        },
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

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

fn sql_err(error: rusqlite::Error) -> String {
    format!("mfa database: {error}")
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
    let tx = conn.transaction().map_err(sql_err)?;
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

// ---------------------------------------------------------------------------
// Meta and preferences
// ---------------------------------------------------------------------------

pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<Vec<u8>>, String> {
    conn.query_row(
        "SELECT value FROM mfa_meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(sql_err)
}

pub fn meta_set(conn: &Connection, key: &str, value: &[u8]) -> Result<(), String> {
    conn.execute(
        "INSERT INTO mfa_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map(|_| ())
    .map_err(sql_err)
}

pub fn get_prefs(conn: &Connection) -> Result<MfaPrefs, String> {
    let mut prefs = MfaPrefs::default();
    let mut stmt = conn
        .prepare("SELECT key, value FROM mfa_prefs")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sql_err)?;
    for row in rows {
        let (key, value) = row.map_err(sql_err)?;
        match key.as_str() {
            "sort_mode" if SORT_MODES.contains(&value.as_str()) => prefs.sort_mode = value,
            "group_filter" => prefs.group_filter = value,
            _ => {}
        }
    }
    Ok(prefs)
}

pub fn set_prefs(conn: &mut Connection, prefs: &MfaPrefs) -> Result<(), String> {
    if !SORT_MODES.contains(&prefs.sort_mode.as_str()) {
        return Err(invalid("sortMode", "unknown sort mode"));
    }
    let group_filter = clean_text(&prefs.group_filter, "groupFilter", MAX_GROUP)?;
    let tx = conn.transaction().map_err(sql_err)?;
    for (key, value) in [
        ("sort_mode", prefs.sort_mode.as_str()),
        ("group_filter", group_filter.as_str()),
    ] {
        tx.execute(
            "INSERT INTO mfa_prefs (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(sql_err)?;
    }
    tx.commit().map_err(sql_err)
}
