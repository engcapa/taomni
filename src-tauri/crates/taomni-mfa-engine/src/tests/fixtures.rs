use crate::models::MfaAccountInput;
use crate::{crypto::DataKey, store};
use rusqlite::Connection;
use zeroize::Zeroizing;

pub(super) fn connection() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    store::init_db(&conn).unwrap();
    conn
}

pub(super) fn key() -> DataKey {
    Zeroizing::new([0x11; 32])
}

/// RFC 4226 Appendix D secret ("12345678901234567890") in Base32.
pub(super) const RFC4226_BASE32: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

pub(super) fn hotp_input(issuer: &str) -> MfaAccountInput {
    MfaAccountInput {
        issuer: issuer.into(),
        account_name: "qa.hotp@example.com".into(),
        secret: RFC4226_BASE32.into(),
        kind: "hotp".into(),
        algorithm: "SHA1".into(),
        digits: 6,
        period: 30,
        counter: 0,
        group: String::new(),
        note: String::new(),
    }
}

pub(super) fn totp_input(issuer: &str, secret: &str) -> MfaAccountInput {
    MfaAccountInput {
        kind: "totp".into(),
        secret: secret.into(),
        account_name: format!("{issuer}@example.com"),
        ..hotp_input(issuer)
    }
}
