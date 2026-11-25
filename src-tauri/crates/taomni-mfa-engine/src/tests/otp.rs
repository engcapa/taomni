use super::fixtures::RFC4226_BASE32;
use crate::otp::{self, OtpAlgorithm};

#[test]
fn rfc4226_hotp_vectors() {
    let secret = b"12345678901234567890";
    let expected = [
        "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871",
        "520489",
    ];
    for (counter, code) in expected.iter().enumerate() {
        assert_eq!(
            otp::hotp(secret, counter as u64, 6, OtpAlgorithm::Sha1),
            *code,
            "counter {counter}"
        );
    }
    assert_eq!(otp::decode_base32(RFC4226_BASE32).unwrap(), secret.to_vec());
}

#[test]
fn rfc6238_totp_vectors() {
    let sha1 = b"12345678901234567890".as_slice();
    let sha256 = b"12345678901234567890123456789012".as_slice();
    let sha512 = b"1234567890123456789012345678901234567890123456789012345678901234".as_slice();
    let cases: [(i64, &str, &str, &str); 6] = [
        (59, "94287082", "46119246", "90693936"),
        (1_111_111_109, "07081804", "68084774", "25091201"),
        (1_111_111_111, "14050471", "67062674", "99943326"),
        (1_234_567_890, "89005924", "91819424", "93441116"),
        (2_000_000_000, "69279037", "90698825", "38618901"),
        (20_000_000_000, "65353130", "77737706", "47863826"),
    ];
    for (secs, a, b, c) in cases {
        let ms = secs * 1000;
        assert_eq!(
            otp::totp(sha1, ms, 30, 8, OtpAlgorithm::Sha1),
            a,
            "sha1 @ {secs}"
        );
        assert_eq!(
            otp::totp(sha256, ms, 30, 8, OtpAlgorithm::Sha256),
            b,
            "sha256 @ {secs}"
        );
        assert_eq!(
            otp::totp(sha512, ms, 30, 8, OtpAlgorithm::Sha512),
            c,
            "sha512 @ {secs}"
        );
    }
}

#[test]
fn base32_accepts_grouped_lowercase_and_padding_but_rejects_other_characters() {
    let canonical = otp::decode_base32("JBSWY3DPEHPK3PXP").unwrap();
    assert_eq!(
        otp::decode_base32("jbsw y3dp-ehpk 3pxp==").unwrap(),
        canonical
    );
    assert_eq!(canonical, b"Hello!\xde\xad\xbe\xef".to_vec());
    assert!(
        otp::decode_base32("JBSW1Y3D")
            .unwrap_err()
            .contains("invalid Base32")
    );
    assert_eq!(otp::totp_step(29_999, 30), 0);
    assert_eq!(otp::totp_step(30_000, 30), 1);
}

#[test]
fn base32_encoding_matches_rfc4648_and_round_trips() {
    for (plain, encoded) in [
        ("f", "MY"),
        ("fo", "MZXQ"),
        ("foo", "MZXW6"),
        ("foob", "MZXW6YQ"),
        ("foobar", "MZXW6YTBOI"),
    ] {
        assert_eq!(otp::encode_base32(plain.as_bytes()), encoded);
    }
    assert_eq!(otp::encode_base32(b"12345678901234567890"), RFC4226_BASE32);
    assert_eq!(
        otp::encode_base32(&otp::decode_base32("jbsw y3dp ehpk 3pxp").unwrap()),
        "JBSWY3DPEHPK3PXP"
    );
}
