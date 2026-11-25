use super::fixtures::{hotp_input, totp_input};
use crate::{
    otp::{OtpAlgorithm, OtpKind},
    store::{self, MfaAccountInput},
};

#[test]
fn validate_input_reports_field_errors() {
    let bad = |mutate: fn(&mut MfaAccountInput)| {
        let mut input = hotp_input("QA");
        mutate(&mut input);
        store::validate_input(&input)
            .err()
            .expect("should be rejected")
    };
    assert!(bad(|i| i.secret = "not base32!".into()).starts_with("MFA_INVALID_INPUT: secret"));
    assert!(bad(|i| i.secret = "JBSWY3DP".into()).contains("too short"));
    assert!(bad(|i| i.digits = 9).starts_with("MFA_INVALID_INPUT: digits"));
    assert!(bad(|i| i.kind = "steam".into()).starts_with("MFA_INVALID_INPUT: kind"));
    assert!(bad(|i| i.algorithm = "MD5".into()).starts_with("MFA_INVALID_INPUT: algorithm"));
    assert!(
        bad(|i| {
            i.issuer.clear();
            i.account_name.clear();
        })
        .starts_with("MFA_INVALID_INPUT: issuer")
    );
    let mut totp = totp_input("QA", "JBSWY3DPEHPK3PXP");
    totp.period = 5;
    assert!(
        store::validate_input(&totp)
            .err()
            .unwrap()
            .starts_with("MFA_INVALID_INPUT: period")
    );
    totp.period = 60;
    totp.algorithm = "sha-256".into();
    let valid = store::validate_input(&totp).unwrap();
    assert_eq!(
        (valid.algorithm, valid.period, valid.kind),
        (OtpAlgorithm::Sha256, 60, OtpKind::Totp)
    );
}
