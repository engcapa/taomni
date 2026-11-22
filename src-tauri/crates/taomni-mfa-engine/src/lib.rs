//! MFA business engine shared by the transitional core adapter and the MFA host.
//!
//! The owner supplies the SQLite connection and operation-scoped key provider.
//! This crate has no application, Vault, window, IPC, capture or profile owner.
//! Connection lifetime, admission, cancellation and snapshot barriers stay with
//! the caller; plaintext keys must not escape its admitted operation.

mod codes;
pub mod crypto;
pub mod keys;
pub mod models;
pub mod operations;
pub mod otp;
pub mod store;
mod validation;

pub use taomni_mfa_api::{
    ERR_INVALID_INPUT, ERR_KEY_MISMATCH, ERR_KEY_MISSING, ERR_NOT_FOUND, INITIALIZATION_REQUIRED,
};

/// Current Unix time in milliseconds; the existing schema uses this unit.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests;
