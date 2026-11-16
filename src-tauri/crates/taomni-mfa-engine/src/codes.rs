//! Current and next code windows for a validated, decrypted account.
use crate::{
    models::{MfaAccount, MfaCode},
    otp::{self, OtpKind},
};

/// Current (and, for TOTP, next) code for `account` at `now_ms`.
pub fn code_for(account: &MfaAccount, secret: &[u8], now_ms: i64) -> MfaCode {
    match account.kind {
        OtpKind::Totp => {
            let step = otp::totp_step(now_ms, account.period);
            let period_ms = i64::from(account.period) * 1000;
            let valid_from = step as i64 * period_ms;
            MfaCode {
                id: account.id.clone(),
                code: otp::hotp(secret, step, account.digits, account.algorithm),
                next_code: Some(otp::hotp(
                    secret,
                    step + 1,
                    account.digits,
                    account.algorithm,
                )),
                period: account.period,
                counter: step,
                valid_from_ms: Some(valid_from),
                valid_until_ms: Some(valid_from + period_ms),
            }
        }
        OtpKind::Hotp => MfaCode {
            id: account.id.clone(),
            code: otp::hotp(secret, account.counter, account.digits, account.algorithm),
            next_code: None,
            period: account.period,
            counter: account.counter,
            valid_from_ms: None,
            valid_until_ms: None,
        },
    }
}
