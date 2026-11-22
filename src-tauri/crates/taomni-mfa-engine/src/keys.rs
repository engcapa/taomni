//! Store/key consistency checks independent of the credential provider.
use crate::{
    ERR_KEY_MISMATCH, ERR_KEY_MISSING,
    crypto::{self, DataKey},
    store,
};
use rusqlite::Connection;

pub use taomni_mfa_api::legacy::ExistingKeyCheck;
use taomni_mfa_api::legacy::{
    self, KEY_CHECK_AAD, KEY_CHECK_META, KEY_CHECK_PLAINTEXT, key_matches_check,
};

/// Operation-scoped access to the protected MFA data key.
///
/// The caller must hold its read/write permit before `load`, an exclusive
/// initialization permit before `initialize_empty`, and the explicit reset
/// authorization before `repair_after_reset`. Implementations enforce those
/// capabilities; the engine never opens a Vault or manufactures a data key.
/// Keys may be used only within the enclosing admitted operation.
pub trait KeyProvider {
    fn load(&self) -> Result<Option<DataKey>, String>;
    fn initialize_empty(&self) -> Result<DataKey, String>;
    fn repair_after_reset(&self) -> Result<DataKey, String>;
}

fn write_key_check(conn: &Connection, key: &DataKey) -> Result<(), String> {
    let (ciphertext, nonce) = crypto::seal(key, KEY_CHECK_AAD, KEY_CHECK_PLAINTEXT)?;
    let mut record = nonce;
    record.extend_from_slice(&ciphertext);
    store::meta_set(conn, KEY_CHECK_META, &record)
}

/// Read the key under the caller's permit before checking the immutable snapshot.
pub fn verify_existing_key(
    conn: &Connection,
    keys: &dyn KeyProvider,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<ExistingKeyCheck, String> {
    check()?;
    let key = keys.load()?;
    legacy::verify_existing_key(conn, key.as_ref(), check)
}

/// Return the data key for `conn`, creating it on first use.
///
/// Errors: `VAULT_LOCKED` (vault empty/locked), [`ERR_KEY_MISSING`] when the
/// database holds sealed data but the vault has no key, [`ERR_KEY_MISMATCH`]
/// when the vault key does not open this database.
pub fn prepare_key(conn: &Connection, keys: &dyn KeyProvider) -> Result<Option<DataKey>, String> {
    let stored = keys.load()?;
    let check = store::meta_get(conn, KEY_CHECK_META)?;
    let accounts = store::count_accounts(conn)?;
    match (stored, check) {
        (Some(key), Some(record)) => {
            if key_matches_check(&key, &record) {
                Ok(Some(key))
            } else {
                Err(ERR_KEY_MISMATCH.to_string())
            }
        }
        (Some(key), None) => {
            if accounts > 0 && !store::first_secret_opens(conn, &key)? {
                return Err(ERR_KEY_MISMATCH.to_string());
            }
            write_key_check(conn, &key)?;
            Ok(Some(key))
        }
        (None, None) if accounts == 0 => Ok(None),
        (None, _) => Err(ERR_KEY_MISSING.to_string()),
    }
}

/// Called only after dropping the shared guard and acquiring the exclusive
/// initialization permit. Recheck the live DB before creating a fixed key.
pub fn ensure_key(conn: &Connection, keys: &dyn KeyProvider) -> Result<DataKey, String> {
    if let Some(key) = prepare_key(conn, keys)? {
        return Ok(key);
    }
    let key = keys.initialize_empty()?;
    write_key_check(conn, &key)?;
    Ok(key)
}

/// Re-bind an emptied database to the vault key. A missing or malformed vault
/// entry is replaced; a locked vault keeps returning `VAULT_LOCKED`.
pub fn rebind_after_reset(conn: &Connection, keys: &dyn KeyProvider) -> Result<DataKey, String> {
    let key = keys.repair_after_reset()?;
    write_key_check(conn, &key)?;
    Ok(key)
}
