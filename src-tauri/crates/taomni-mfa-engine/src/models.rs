use zeroize::Zeroizing;

use crate::otp::{OtpAlgorithm, OtpKind};
pub use taomni_mfa_api::models::*;

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
