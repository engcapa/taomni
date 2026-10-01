//! MFA authenticator (TOTP / HOTP) backed by a dedicated `mfa.db` SQLite file.
//!
//! Secrets are stored AES-256-GCM encrypted. The data key lives in the
//! credential vault as the fixed entry [`crate::vault::MFA_DATA_KEY_ENTRY_ID`]
//! (same pattern as the LanChat message key), so every command needs the vault
//! unlocked and the renderer only ever receives codes, never stored secrets.
//! See `docs-feature/mfa-authenticator-design.md`.

pub mod capture;
pub mod commands;
pub mod crypto;
pub mod otp;
pub mod store;

#[cfg(test)]
mod tests;

/// Error codes surfaced to the frontend verbatim (prefix match on the string).
pub const ERR_KEY_MISSING: &str = "MFA_KEY_MISSING";
pub const ERR_KEY_MISMATCH: &str = "MFA_KEY_MISMATCH";
pub const ERR_INVALID_INPUT: &str = "MFA_INVALID_INPUT";
pub const ERR_NOT_FOUND: &str = "MFA_NOT_FOUND";
pub const ERR_CLIPBOARD_NO_IMAGE: &str = "MFA_CLIPBOARD_NO_IMAGE";
/// Only macOS gates screen capture behind a preflightable permission.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const ERR_SCREEN_PERMISSION: &str = "MFA_SCREEN_PERMISSION";
pub const ERR_NO_DISPLAY: &str = "MFA_NO_DISPLAY";
pub const ERR_CAPTURE_FAILED: &str = "MFA_CAPTURE_FAILED";

/// Current Unix time in milliseconds; all MFA timestamps use this unit.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
