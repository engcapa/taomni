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

pub const ERR_KEY_MISSING: &str = "MFA_KEY_MISSING";
pub const ERR_KEY_MISMATCH: &str = "MFA_KEY_MISMATCH";
pub const ERR_INVALID_INPUT: &str = "MFA_INVALID_INPUT";
pub const ERR_NOT_FOUND: &str = "MFA_NOT_FOUND";

/// Current Unix time in milliseconds; the existing schema uses this unit.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests;
