mod commands;
mod core_access;
pub mod crypto;
mod data_access;
pub mod db;
mod fixed_key_read;
pub(crate) mod migration_check;
mod password_key;
mod passwords;
pub mod plugin_access;
pub use commands::*;
pub(crate) use core_access::MfaKeyAction;
pub(crate) use data_access::VaultDataAccess;

#[cfg(test)]
mod data_access_tests;
#[cfg(test)]
mod tests;

use password_key::StoredKdfParams;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use taomni_plugin_services::OperationKind;
use uuid::Uuid;
use zeroize::Zeroizing;

pub const VAULT_REF_PREFIX: &str = "vault:";
pub const ERR_VAULT_LOCKED: &str = "VAULT_LOCKED";
pub const ERR_VAULT_EMPTY: &str = "VAULT_EMPTY";
pub const ERR_VAULT_BAD_PASSWORD: &str = "VAULT_BAD_PASSWORD";
pub const ERR_VAULT_PASSWORD_REQUIRED: &str = "VAULT_PASSWORD_REQUIRED";
pub const ERR_VAULT_NOT_FOUND: &str = "VAULT_NOT_FOUND";
pub const ERR_VAULT_ENTRY_PROTECTED: &str = "VAULT_ENTRY_PROTECTED";

/// Fixed entry holding the data key that seals `mfa.db` secrets. Deleting it
/// would make every stored MFA account permanently undecryptable.
pub const MFA_DATA_KEY_ENTRY_ID: &str = "mfa.data-key-v1";

/// Entries other stores depend on; the entry manager must not delete them.
pub fn is_protected_entry(id: &str) -> bool {
    id == MFA_DATA_KEY_ENTRY_ID
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultStateKind {
    Empty,
    Locked,
    Unlocked,
}

#[derive(Debug, Serialize)]
pub struct VaultStatus {
    pub state: VaultStateKind,
    pub entry_count: i64,
}

#[derive(Debug, Serialize)]
pub struct VaultPutResult {
    pub id: String,
    pub reference: String,
}

/// Owns the on-disk vault SQLite connection plus the in-memory unlock state.
/// Wrapped in a `Mutex` so all access is serialized; the operations are
/// already cheap (single-row reads, AEAD on small payloads).
pub struct Vault {
    inner: Mutex<VaultInner>,
    data_access: OnceLock<VaultDataAccess>,
}

struct VaultInner {
    conn: Connection,
    /// `Some` when unlocked. The key is zeroized on drop.
    root_key: Option<Zeroizing<[u8; crypto::KEY_LEN]>>,
    /// Nonsecret crypto metadata at the successful unlock, excluding mutable
    /// timestamps. Compared under this mutex and an outer operation lease.
    root_revision: Option<db::MetaRow>,
}

impl Vault {
    pub fn open(path: &PathBuf) -> Result<Self, String> {
        let conn = db::open(path).map_err(|e| format!("vault db open: {}", e))?;
        Ok(Self {
            data_access: OnceLock::new(),
            inner: Mutex::new(VaultInner {
                conn,
                root_key: None,
                root_revision: None,
            }),
        })
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    fn state_kind(inner: &VaultInner) -> Result<VaultStateKind, String> {
        if inner.root_key.is_some() {
            return Ok(VaultStateKind::Unlocked);
        }
        match db::get_meta(&inner.conn).map_err(|e| e.to_string())? {
            Some(_) => Ok(VaultStateKind::Locked),
            None => Ok(VaultStateKind::Empty),
        }
    }

    pub fn status(&self) -> Result<VaultStatus, String> {
        let _lease = self.metadata_lease()?;
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.root_key.is_some() {
            match self.verify_service_root(&mut inner) {
                Ok(()) | Err(plugin_access::PluginKeyError::VaultLocked) => (),
                Err(error) => return Err(error.to_string()),
            }
        }
        let state = Self::state_kind(&inner)?;
        let entry_count = db::count_entries(&inner.conn).map_err(|e| e.to_string())?;
        Ok(VaultStatus { state, entry_count })
    }

    /// Perform a consistent SQLite online hot-backup of the vault database.
    pub fn backup_to(&self, dest_path: &std::path::Path) -> Result<(), String> {
        self.backup_to_with_context(
            dest_path,
            &crate::backup::snapshot_context::SnapshotContext::default(),
        )
    }

    pub(crate) fn backup_to_with_context(
        &self,
        dest_path: &std::path::Path,
        context: &crate::backup::snapshot_context::SnapshotContext,
    ) -> Result<(), String> {
        let inner = context.lock(&self.inner)?;
        context.snapshot_connection(&inner.conn, dest_path)
    }

    /// Check if the vault has been initialized (i.e. master password has been set).
    pub fn is_initialized(&self) -> Result<bool, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let meta = db::get_meta(&inner.conn).map_err(|e| e.to_string())?;
        Ok(meta.is_some())
    }

    pub fn put(&self, kind: &str, label: &str, plaintext: &str) -> Result<VaultPutResult, String> {
        self.with_sensitive_data(OperationKind::WriteData, |inner| {
            let key = inner
                .root_key
                .as_ref()
                .ok_or_else(|| ERR_VAULT_LOCKED.to_string())?;

            let id = Uuid::new_v4().to_string();
            let nonce = crypto::random_nonce();
            let ciphertext = crypto::aead_encrypt(key, &nonce, plaintext.as_bytes())
                .map_err(|e| e.to_string())?;
            db::insert_entry(
                &inner.conn,
                &id,
                label,
                kind,
                &ciphertext,
                &nonce,
                Self::now(),
            )
            .map_err(|e| e.to_string())?;

            Ok(VaultPutResult {
                reference: format!("{}{}", VAULT_REF_PREFIX, id),
                id,
            })
        })
    }

    pub fn update(&self, id: &str, plaintext: &str) -> Result<(), String> {
        if is_protected_entry(id) {
            return Err(ERR_VAULT_ENTRY_PROTECTED.into());
        }
        self.with_sensitive_data(OperationKind::WriteData, |inner| {
            let key = inner
                .root_key
                .as_ref()
                .ok_or_else(|| ERR_VAULT_LOCKED.to_string())?;
            let nonce = crypto::random_nonce();
            let ciphertext = crypto::aead_encrypt(key, &nonce, plaintext.as_bytes())
                .map_err(|e| e.to_string())?;
            let updated = db::update_entry(&inner.conn, id, &ciphertext, &nonce, Self::now())
                .map_err(|e| e.to_string())?;
            if updated == 0 {
                return Err(ERR_VAULT_NOT_FOUND.to_string());
            }
            Ok(())
        })
    }

    pub fn put_fixed(
        &self,
        id: &str,
        kind: &str,
        label: &str,
        plaintext: &str,
    ) -> Result<(), String> {
        self.with_sensitive_data(OperationKind::WriteData, |inner| {
            let key = inner
                .root_key
                .as_ref()
                .ok_or_else(|| ERR_VAULT_LOCKED.to_string())?;

            let nonce = crypto::random_nonce();
            let ciphertext = crypto::aead_encrypt(key, &nonce, plaintext.as_bytes())
                .map_err(|e| e.to_string())?;
            db::upsert_entry(
                &inner.conn,
                id,
                label,
                kind,
                &ciphertext,
                &nonce,
                Self::now(),
            )
            .map_err(|e| e.to_string())
        })
    }

    pub fn get_fixed(&self, id: &str) -> Result<Option<Zeroizing<String>>, String> {
        self.with_sensitive_data(OperationKind::ReadData, |inner| {
            let key = inner
                .root_key
                .as_ref()
                .ok_or_else(|| ERR_VAULT_LOCKED.to_string())?;
            let Some(entry) = db::get_entry(&inner.conn, id).map_err(|e| e.to_string())? else {
                return Ok(None);
            };
            let nonce: [u8; crypto::NONCE_LEN] = entry
                .nonce
                .as_slice()
                .try_into()
                .map_err(|_| "stored nonce shape".to_string())?;
            let plaintext_bytes =
                crypto::aead_decrypt(key, &nonce, &entry.ciphertext).map_err(|e| e.to_string())?;
            let plaintext_str = std::str::from_utf8(plaintext_bytes.as_slice())
                .map_err(|_| "stored plaintext is not utf-8".to_string())?
                .to_string();
            Ok(Some(Zeroizing::new(plaintext_str)))
        })
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        if is_protected_entry(id) {
            return Err(ERR_VAULT_ENTRY_PROTECTED.into());
        }
        let _lease = self.metadata_lease()?;
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let removed = db::delete_entry(&inner.conn, id).map_err(|e| e.to_string())?;
        if removed == 0 {
            return Err(ERR_VAULT_NOT_FOUND.to_string());
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<db::EntrySummary>, String> {
        let _lease = self.metadata_lease()?;
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        db::list_entries(&inner.conn).map_err(|e| e.to_string())
    }

    /// Resolve a `vault:<id>` reference to its plaintext. Used by the SSH /
    /// SFTP / VNC / tunnel / proxy connection paths. Returns:
    /// - `Ok(Some(plaintext))` when the reference resolves successfully.
    /// - `Ok(None)` when the input is *not* a vault reference (caller should
    ///   treat the original string as plaintext for backwards compat).
    /// - `Err(ERR_VAULT_LOCKED)` when the value is a reference but the vault
    ///   is locked (caller bubbles up so the UI can prompt for unlock).
    /// - other `Err(_)` for missing entries / decryption failures.
    pub fn resolve(&self, value: &str) -> Result<Option<Zeroizing<String>>, String> {
        self.resolve_reference(value, None)
    }

    pub(crate) fn resolve_for_kind(
        &self,
        value: &str,
        kind: &str,
    ) -> Result<Option<Zeroizing<String>>, String> {
        self.resolve_reference(value, Some(kind))
    }

    fn resolve_reference(
        &self,
        value: &str,
        kind: Option<&str>,
    ) -> Result<Option<Zeroizing<String>>, String> {
        let id = match value.strip_prefix(VAULT_REF_PREFIX) {
            Some(s) => s,
            None => return Ok(None),
        };
        self.with_sensitive_data(OperationKind::ReadData, |inner| {
            let key = inner
                .root_key
                .as_ref()
                .ok_or_else(|| ERR_VAULT_LOCKED.to_string())?;
            let entry = db::get_entry(&inner.conn, id)
                .map_err(|e| e.to_string())?
                .filter(|entry| kind.is_none_or(|kind| entry.kind == kind))
                .ok_or_else(|| ERR_VAULT_NOT_FOUND.to_string())?;
            let nonce: [u8; crypto::NONCE_LEN] = entry
                .nonce
                .as_slice()
                .try_into()
                .map_err(|_| "stored nonce shape".to_string())?;
            let plaintext_bytes =
                crypto::aead_decrypt(key, &nonce, &entry.ciphertext).map_err(|e| e.to_string())?;
            let plaintext_str = std::str::from_utf8(plaintext_bytes.as_slice())
                .map_err(|_| "stored plaintext is not utf-8".to_string())?
                .to_string();
            Ok(Some(Zeroizing::new(plaintext_str)))
        })
    }
}

/// Helper used by setup() to choose the on-disk vault path.
pub fn default_vault_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    let mut p = crate::resolved_app_data_dir(app).expect("failed to resolve app data dir");
    p.push("vault.db");
    p
}
