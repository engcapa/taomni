//! MFA authenticator (TOTP / HOTP) backed by a dedicated `mfa.db` SQLite file.
//!
//! Secrets are stored AES-256-GCM encrypted. The data key lives in the
//! credential vault as the fixed entry [`crate::vault::MFA_DATA_KEY_ENTRY_ID`]
//! (same protected-entry pattern as other plugin data keys), so every command needs the vault
//! unlocked and the renderer only ever receives codes, never stored secrets.
//! See `docs-feature/mfa-authenticator-design.md`.

#[cfg(any(test, feature = "legacy-mfa"))]
mod access;
pub(crate) mod backend;
pub mod capture;
pub mod commands;
#[cfg(any(test, feature = "legacy-mfa"))]
pub mod crypto;
#[cfg(any(test, feature = "legacy-mfa"))]
mod key_provider;
pub(crate) mod ownership;
#[cfg(any(test, feature = "legacy-mfa"))]
pub use taomni_mfa_engine::otp;
pub mod store;

#[cfg(test)]
mod access_tests;
#[cfg(test)]
mod test_keys;
#[cfg(test)]
mod tests;

pub use taomni_mfa_api::{ERR_INVALID_INPUT, ERR_KEY_MISMATCH, ERR_KEY_MISSING, ERR_NOT_FOUND};
#[cfg(any(test, feature = "legacy-mfa"))]
pub use taomni_mfa_engine::now_ms;
pub const ERR_CLIPBOARD_NO_IMAGE: &str = "MFA_CLIPBOARD_NO_IMAGE";
/// Only macOS gates screen capture behind a preflightable permission.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const ERR_SCREEN_PERMISSION: &str = "MFA_SCREEN_PERMISSION";
pub const ERR_NO_DISPLAY: &str = "MFA_NO_DISPLAY";
pub const ERR_CAPTURE_FAILED: &str = "MFA_CAPTURE_FAILED";
