//! Stable MFA request and response types used by the core and independent host.
pub mod models;
mod otp;
pub use otp::{OtpAlgorithm, OtpKind};

#[cfg(feature = "legacy-snapshot")]
pub mod legacy;

pub const ERR_KEY_MISSING: &str = "MFA_KEY_MISSING";
pub const ERR_KEY_MISMATCH: &str = "MFA_KEY_MISMATCH";
pub const ERR_INVALID_INPUT: &str = "MFA_INVALID_INPUT";
pub const ERR_NOT_FOUND: &str = "MFA_NOT_FOUND";
pub const INITIALIZATION_REQUIRED: &str = "MFA_INITIALIZATION_REQUIRED";
pub const LEGACY_MIGRATION_REQUIRED: &str = "MFA_LEGACY_MIGRATION_REQUIRED";
