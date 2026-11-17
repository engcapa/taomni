//! Module wiring only; every implementation is compiled from production files.
#[path = "../../../../src/vault/crypto.rs"]
pub mod crypto;
#[path = "../../../../src/vault/db.rs"]
pub mod db;
#[path = "../../../../src/vault/fixed_key_read.rs"]
mod fixed_key_read;
#[path = "../../../../src/vault/migration_check.rs"]
pub(crate) mod migration_check;
#[path = "../../../../src/vault/password_key.rs"]
mod password_key;
#[path = "../../../../src/vault/plugin_error.rs"]
mod plugin_error;

pub mod plugin_access {
    pub use super::plugin_error::PluginKeyError;
}

// These are existing wire error names, not alternate service implementations.
const ERR_VAULT_BAD_PASSWORD: &str = "VAULT_BAD_PASSWORD";
const ERR_VAULT_PASSWORD_REQUIRED: &str = "VAULT_PASSWORD_REQUIRED";
const ERR_VAULT_EMPTY: &str = "VAULT_EMPTY";
