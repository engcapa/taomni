use super::capture::{FRAME_MAGIC, LumaFrame, encode_frames, rgba_to_luma};
use super::crypto::{self, DataKey};
use super::otp::{self, OtpAlgorithm, OtpKind};
use super::store::{self, MfaAccountInput, MfaAccountPatch, MfaPrefs, MfaStore};
use super::{ERR_KEY_MISMATCH, ERR_KEY_MISSING};
use crate::vault::{ERR_VAULT_LOCKED, MFA_DATA_KEY_ENTRY_ID, Vault};
use tempfile::{TempDir, tempdir};

/// RFC 4226 Appendix D secret ("12345678901234567890") in Base32.
const RFC4226_BASE32: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

fn vault_in(dir: &TempDir, name: &str) -> Vault {
    let vault = Vault::open(&dir.path().join(name)).expect("open vault");
    vault.init("qa-master-password").expect("init vault");
    vault
}

fn hotp_input(issuer: &str) -> MfaAccountInput {
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

fn totp_input(issuer: &str, secret: &str) -> MfaAccountInput {
    MfaAccountInput {
        kind: "totp".into(),
        secret: secret.into(),
        account_name: format!("{issuer}@example.com"),
        ..hotp_input(issuer)
    }
}

fn add(conn: &rusqlite::Connection, key: &DataKey, input: &MfaAccountInput) -> store::MfaAccount {
    let valid = store::validate_input(input).expect("valid input");
    store::insert_account(conn, key, &valid).expect("insert")
}

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

#[test]
fn store_lifecycle_codes_order_prefs_and_usage() {
    let dir = tempdir().unwrap();
    let vault = vault_in(&dir, "vault.db");
    let mfa = MfaStore::new(dir.path().join("mfa.db"));
    mfa.with_conn(|conn| {
        let key = crypto::ensure_key(conn, &vault)?;
        let bank = add(conn, &key, &hotp_input("QA Bank"));
        let git = add(conn, &key, &totp_input("GitHub", "JBSWY3DPEHPK3PXP"));
        assert_eq!((bank.sort_order, git.sort_order), (0, 1));

        let sealed = store::get_sealed(conn, &bank.id)?.unwrap();
        let secret = store::open_secret(&key, &sealed)?;
        let code = store::code_for(&sealed.account, &secret, 0);
        assert_eq!((code.code.as_str(), code.valid_until_ms), ("755224", None));
        assert!(store::increment_counter(conn, &bank.id)?);
        let sealed = store::get_sealed(conn, &bank.id)?.unwrap();
        assert_eq!(store::code_for(&sealed.account, &secret, 0).code, "287082");
        assert!(
            !store::increment_counter(conn, &git.id)?,
            "TOTP has no counter"
        );

        let sealed = store::get_sealed(conn, &git.id)?.unwrap();
        let secret = store::open_secret(&key, &sealed)?;
        let code = store::code_for(&sealed.account, &secret, 59_000);
        assert_eq!(
            (code.valid_from_ms, code.valid_until_ms),
            (Some(30_000), Some(60_000))
        );
        assert_eq!(
            code.next_code.as_deref(),
            Some(otp::totp(&secret, 60_000, 30, 6, OtpAlgorithm::Sha1).as_str())
        );

        store::reorder(conn, &[git.id.clone(), "missing".into()])?;
        let order: Vec<String> = store::list_accounts(conn)?
            .into_iter()
            .map(|a| a.issuer)
            .collect();
        assert_eq!(order, ["GitHub", "QA Bank"]);

        let patch = MfaAccountPatch {
            issuer: " QA Bank ".into(),
            account_name: "renamed".into(),
            group: "Work".into(),
            note: "hardware token".into(),
            pinned: true,
        };
        let updated = store::update_account(conn, &bank.id, &patch)?.unwrap();
        assert_eq!(
            (
                updated.issuer.as_str(),
                updated.group.as_str(),
                updated.pinned
            ),
            ("QA Bank", "Work", true)
        );
        let used = store::mark_used(conn, &bank.id)?.unwrap();
        assert_eq!(used.use_count, 1);
        assert!(used.last_used_at.is_some());

        let prefs = MfaPrefs {
            sort_mode: "recent".into(),
            group_filter: "Work".into(),
        };
        store::set_prefs(conn, &prefs)?;
        assert_eq!(store::get_prefs(conn)?, prefs);
        assert!(
            store::set_prefs(
                conn,
                &MfaPrefs {
                    sort_mode: "random".into(),
                    group_filter: String::new()
                }
            )
            .is_err()
        );

        assert!(store::delete_account(conn, &git.id)?);
        assert!(!store::delete_account(conn, &git.id)?);
        assert_eq!(store::count_accounts(conn)?, 1);
        Ok(())
    })
    .unwrap();
}

#[test]
fn secrets_are_sealed_at_rest_bound_to_their_row_and_deduplicated() {
    let dir = tempdir().unwrap();
    let vault = vault_in(&dir, "vault.db");
    let db_path = dir.path().join("mfa.db");
    let mfa = MfaStore::new(db_path.clone());
    let (first, second) = mfa
        .with_conn(|conn| {
            let key = crypto::ensure_key(conn, &vault)?;
            let first = add(conn, &key, &hotp_input("QA Bank"));
            let second = add(conn, &key, &totp_input("GitHub", "JBSWY3DPEHPK3PXP"));
            let duplicate = store::validate_input(&hotp_input("Other name"))?;
            assert_eq!(store::find_duplicate(conn, &store::fingerprint_of(&key, &duplicate))?, Some(first.id.clone()));

            // Moving a ciphertext to another row must fail authentication.
            conn.execute(
                "UPDATE mfa_accounts SET secret_ct = (SELECT secret_ct FROM mfa_accounts WHERE id = ?1), \
                 secret_nonce = (SELECT secret_nonce FROM mfa_accounts WHERE id = ?1) WHERE id = ?2",
                rusqlite::params![first.id, second.id],
            )
            .unwrap();
            let swapped = store::get_sealed(conn, &second.id)?.unwrap();
            assert_eq!(store::open_secret(&key, &swapped).err().as_deref(), Some(ERR_KEY_MISMATCH));
            Ok((first, second))
        })
        .unwrap();
    assert_ne!(first.id, second.id);
    drop(mfa);
    let raw = std::fs::read(&db_path).unwrap();
    for needle in [
        b"12345678901234567890".as_slice(),
        RFC4226_BASE32.as_bytes(),
        b"JBSWY3DPEHPK3PXP",
    ] {
        assert!(
            !raw.windows(needle.len()).any(|w| w == needle),
            "plaintext secret found in mfa.db"
        );
    }
    assert!(
        vault.get_fixed(MFA_DATA_KEY_ENTRY_ID).unwrap().is_some(),
        "data key lives in the vault"
    );
}

#[test]
fn key_errors_locked_vault_and_master_password_change() {
    let dir = tempdir().unwrap();
    let vault = vault_in(&dir, "vault.db");
    let mfa = MfaStore::new(dir.path().join("mfa.db"));
    let id = mfa
        .with_conn(|conn| {
            let key = crypto::ensure_key(conn, &vault)?;
            Ok(add(conn, &key, &hotp_input("QA Bank")).id)
        })
        .unwrap();

    vault
        .change_master("qa-master-password", "qa-new-password")
        .unwrap();
    mfa.with_conn(|conn| {
        let key = crypto::ensure_key(conn, &vault)?;
        let sealed = store::get_sealed(conn, &id)?.unwrap();
        assert_eq!(
            store::code_for(&sealed.account, &store::open_secret(&key, &sealed)?, 0).code,
            "755224"
        );
        Ok(())
    })
    .unwrap();

    vault.lock().unwrap();
    assert_eq!(
        mfa.with_conn(|conn| crypto::ensure_key(conn, &vault).map(|_| ()))
            .err()
            .as_deref(),
        Some(ERR_VAULT_LOCKED)
    );

    let other = vault_in(&dir, "other-vault.db");
    assert_eq!(
        mfa.with_conn(|conn| crypto::ensure_key(conn, &other).map(|_| ()))
            .err()
            .as_deref(),
        Some(ERR_KEY_MISSING)
    );
    other
        .put_fixed(
            MFA_DATA_KEY_ENTRY_ID,
            crypto::KEY_KIND,
            crypto::KEY_LABEL,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        )
        .unwrap();
    assert_eq!(
        mfa.with_conn(|conn| crypto::ensure_key(conn, &other).map(|_| ()))
            .err()
            .as_deref(),
        Some(ERR_KEY_MISMATCH)
    );

    // Recovery: wipe and re-bind the empty store to the other vault's key.
    mfa.with_conn(|conn| {
        store::reset(conn)?;
        crypto::rebind_after_reset(conn, &other)?;
        assert_eq!(store::count_accounts(conn)?, 0);
        crypto::ensure_key(conn, &other).map(|_| ())
    })
    .unwrap();
}

#[test]
fn backup_snapshot_only_when_mfa_was_used() {
    let dir = tempdir().unwrap();
    let vault = vault_in(&dir, "vault.db");
    let mfa = MfaStore::new(dir.path().join("mfa.db"));
    let snapshot = dir.path().join("snapshot.db");
    assert!(
        !mfa.backup_to(&snapshot).unwrap(),
        "never-used MFA stages nothing"
    );
    assert!(!mfa.path().exists(), "backup must not create mfa.db");

    mfa.with_conn(|conn| {
        let key = crypto::ensure_key(conn, &vault)?;
        add(conn, &key, &hotp_input("QA Bank"));
        Ok(())
    })
    .unwrap();
    assert!(mfa.backup_to(&snapshot).unwrap());
    let copy = rusqlite::Connection::open(&snapshot).unwrap();
    let count: i64 = copy
        .query_row("SELECT COUNT(*) FROM mfa_accounts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);

    // A store reopened from disk (new app session) is snapshotted as well.
    let reopened = MfaStore::new(dir.path().join("mfa.db"));
    assert!(reopened.backup_to(&dir.path().join("second.db")).unwrap());
}

#[test]
fn luma_frames_composite_alpha_and_encode_little_endian() {
    let rgba = [
        255, 255, 255, 255, // white
        0, 0, 0, 255, // black
        0, 0, 0, 0, // transparent black -> white
        255, 0, 0, 255, // red
    ];
    let luma = rgba_to_luma(&rgba, 2, 2).unwrap();
    assert_eq!(luma, vec![255, 0, 255, 76]);
    assert!(rgba_to_luma(&rgba, 3, 2).is_err());

    let bytes = encode_frames(&[LumaFrame {
        width: 2,
        height: 2,
        luma,
    }]);
    assert_eq!(&bytes[..4], FRAME_MAGIC);
    assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 2);
    assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), 2);
    assert_eq!(&bytes[16..], &[255, 0, 255, 76]);
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

#[test]
fn export_uri_requires_the_master_password_and_round_trips_the_account() {
    use super::commands::export_with_password;
    use crate::vault::{ERR_VAULT_BAD_PASSWORD, ERR_VAULT_PASSWORD_REQUIRED};

    let dir = tempdir().unwrap();
    let vault = vault_in(&dir, "vault.db");
    let mfa = MfaStore::new(dir.path().join("mfa.db"));
    let (hotp_id, totp_id) = mfa
        .with_conn(|conn| {
            let key = crypto::ensure_key(conn, &vault)?;
            let hotp = add(conn, &key, &hotp_input("QA Bank & Co"));
            assert!(store::increment_counter(conn, &hotp.id)?);
            let totp = add(
                conn,
                &key,
                &MfaAccountInput {
                    algorithm: "SHA256".into(),
                    digits: 8,
                    ..totp_input("QA TOTP", "JBSWY3DPEHPK3PXP")
                },
            );
            Ok((hotp.id, totp.id))
        })
        .unwrap();

    assert_eq!(
        export_with_password(&vault, &mfa, &hotp_id, "wrong-password").unwrap_err(),
        ERR_VAULT_BAD_PASSWORD
    );
    assert_eq!(
        export_with_password(&vault, &mfa, &hotp_id, "  ").unwrap_err(),
        ERR_VAULT_PASSWORD_REQUIRED
    );
    assert_eq!(
        export_with_password(&vault, &mfa, &hotp_id, "qa-master-password").unwrap(),
        format!(
            "otpauth://hotp/QA%20Bank%20%26%20Co:qa.hotp%40example.com?secret={RFC4226_BASE32}&issuer=QA%20Bank%20%26%20Co&algorithm=SHA1&digits=6&counter=1"
        )
    );
    assert_eq!(
        export_with_password(&vault, &mfa, &totp_id, "qa-master-password").unwrap(),
        "otpauth://totp/QA%20TOTP:QA%20TOTP%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=QA%20TOTP&algorithm=SHA256&digits=8&period=30"
    );
    assert_eq!(
        export_with_password(&vault, &mfa, "missing", "qa-master-password").unwrap_err(),
        super::ERR_NOT_FOUND
    );

    // An account without an issuer is labelled by its name alone.
    let uri = otp::otpauth_uri(&otp::OtpauthFields {
        kind: OtpKind::Totp,
        issuer: "",
        account_name: "solo@example.com",
        secret: b"12345678901234567890",
        algorithm: OtpAlgorithm::Sha1,
        digits: 6,
        period: 30,
        counter: 0,
    });
    assert_eq!(
        uri,
        format!(
            "otpauth://totp/solo%40example.com?secret={RFC4226_BASE32}&algorithm=SHA1&digits=6&period=30"
        )
    );
}

#[cfg(target_os = "linux")]
#[test]
fn x11_zpixmap_luma_handles_both_byte_orders() {
    use super::capture::linux::zpixmap_to_luma;
    // White, black and pure red pixels.
    let bgrx = [255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 255, 0];
    assert_eq!(
        zpixmap_to_luma(&bgrx, 3, 1, true).unwrap(),
        vec![255, 0, 76]
    );
    let xrgb = [0, 255, 255, 255, 0, 0, 0, 0, 0, 255, 0, 0];
    assert_eq!(
        zpixmap_to_luma(&xrgb, 3, 1, false).unwrap(),
        vec![255, 0, 76]
    );
    assert!(zpixmap_to_luma(&bgrx, 4, 1, true).is_err());
}

#[test]
fn mfa_data_key_entry_is_protected_from_vault_deletion() {
    assert!(crate::vault::is_protected_entry(MFA_DATA_KEY_ENTRY_ID));
    assert!(!crate::vault::is_protected_entry("lanchat.message-key-v1"));
}
