//! Canonical input validation shared by imports and metadata updates.
use crate::{
    ERR_INVALID_INPUT,
    models::{MfaAccountInput, ValidAccount, default_period},
    otp::{self, OtpAlgorithm, OtpKind},
};
use zeroize::Zeroizing;

pub const SORT_MODES: &[&str] = &["custom", "issuer", "account", "recent", "frequent", "added"];
pub(crate) const MAX_ISSUER: usize = 128;
pub(crate) const MAX_ACCOUNT: usize = 256;
pub(crate) const MAX_GROUP: usize = 64;
pub(crate) const MAX_NOTE: usize = 1024;

pub(crate) fn invalid(field: &str, detail: &str) -> String {
    format!("{ERR_INVALID_INPUT}: {field}: {detail}")
}

pub(crate) fn clean_text(value: &str, field: &str, max: usize) -> Result<String, String> {
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
