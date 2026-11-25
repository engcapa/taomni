use super::fixtures::{RFC4226_BASE32, connection, hotp_input, key, totp_input};
use crate::models::{MfaAccountPatch, MfaPrefs};
use crate::{ERR_INVALID_INPUT, ERR_KEY_MISMATCH, ERR_NOT_FOUND, operations, store};

#[test]
fn invalid_input_and_duplicate_rejection_leave_no_partial_import() {
    let mut conn = connection();
    let key = key();
    let hotp = hotp_input("Bank");
    let mut invalid = hotp.clone();
    invalid.secret = "not a secret!".into();
    assert!(
        operations::add(&mut conn, &key, &[hotp.clone(), invalid], false)
            .unwrap_err()
            .starts_with("MFA_INVALID_INPUT: secret")
    );
    assert_eq!(store::count_accounts(&conn).unwrap(), 0);

    let original = operations::add(&mut conn, &key, &[hotp.clone()], false)
        .unwrap()
        .added
        .remove(0);
    let totp = totp_input("Mail", "JBSWY3DPEHPK3PXP");
    assert_eq!(
        operations::add(&mut conn, &key, &[totp.clone(), hotp.clone()], false).unwrap_err(),
        format!("{ERR_INVALID_INPUT}: secret: account already exists")
    );
    assert_eq!(store::list_accounts(&conn).unwrap(), vec![original.clone()]);

    let imported = operations::add(&mut conn, &key, &[hotp, totp.clone(), totp], true).unwrap();
    assert_eq!(imported.duplicates, [0, 2]);
    assert_eq!(imported.added.len(), 1);
    assert_eq!(imported.added[0].issuer, "Mail");
    assert_eq!(store::count_accounts(&conn).unwrap(), 2);
    assert_eq!(
        store::get_account(&conn, &original.id).unwrap(),
        Some(original)
    );
}

#[test]
fn inspection_reports_fields_and_duplicates_without_mutating_accounts() {
    let mut conn = connection();
    let key = key();
    let input = hotp_input("Bank");
    let original = operations::add(&mut conn, &key, &[input.clone()], false)
        .unwrap()
        .added
        .remove(0);
    let mut invalid = input.clone();
    invalid.algorithm = "MD5".into();
    let result = operations::inspect(&conn, &key, &[input, invalid]).unwrap();
    assert!(result[0].ok);
    assert_eq!(
        result[0].duplicate_of.as_deref(),
        Some(original.id.as_str())
    );
    assert_eq!(result[0].error, None);
    assert!(!result[1].ok);
    assert!(
        result[1]
            .error
            .as_ref()
            .unwrap()
            .starts_with("MFA_INVALID_INPUT: algorithm")
    );
    assert_eq!(result[1].duplicate_of, None);
    assert_eq!(store::list_accounts(&conn).unwrap(), vec![original]);
}

#[test]
fn code_selection_hotp_next_and_export_preserve_existing_wire_contracts() {
    let mut conn = connection();
    let key = key();
    let added = operations::add(
        &mut conn,
        &key,
        &[hotp_input("Bank"), totp_input("Mail", "JBSWY3DPEHPK3PXP")],
        false,
    )
    .unwrap()
    .added;
    let ids = vec![added[0].id.clone()];
    let current = operations::codes(&conn, &key, Some(&ids), 59_000).unwrap();
    assert_eq!(current.len(), 1);
    assert_eq!(current[0].id, added[0].id);
    assert_eq!(current[0].code, "755224");
    assert_eq!(current[0].counter, 0);
    assert_eq!(current[0].valid_until_ms, None);
    let next = operations::hotp_next(&conn, &key, &ids[0]).unwrap();
    assert_eq!((next.code.as_str(), next.counter), ("287082", 1));
    assert_eq!(
        operations::hotp_next(&conn, &key, &added[1].id).unwrap_err(),
        ERR_NOT_FOUND
    );
    assert_eq!(
        store::get_account(&conn, &added[1].id)
            .unwrap()
            .unwrap()
            .counter,
        0
    );
    assert!(
        operations::codes(&conn, &key, Some(&[]), 59_000)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        operations::codes(&conn, &key, None, 59_000).unwrap().len(),
        2
    );
    assert_eq!(
        operations::export_uri(&conn, &key, &ids[0]).unwrap(),
        format!(
            "otpauth://hotp/Bank:qa.hotp%40example.com?secret={RFC4226_BASE32}&issuer=Bank&algorithm=SHA1&digits=6&counter=1"
        )
    );
    assert_eq!(
        operations::export_uri(&conn, &key, "missing").unwrap_err(),
        ERR_NOT_FOUND
    );

    let snapshot = serde_json::to_value(operations::list(&conn).unwrap()).unwrap();
    assert_eq!(
        snapshot["accounts"][0]["accountName"],
        "qa.hotp@example.com"
    );
    assert_eq!(snapshot["accounts"][0]["counter"], 1);
    assert_eq!(snapshot["prefs"]["sortMode"], "custom");
    for account in snapshot["accounts"].as_array().unwrap() {
        for field in ["secret", "secretCt", "secretNonce", "fingerprint"] {
            assert!(account.get(field).is_none(), "response leaked {field}");
        }
    }
    let sealed = store::get_sealed(&conn, &ids[0]).unwrap().unwrap();
    assert!(
        !sealed
            .ciphertext
            .windows(20)
            .any(|part| part == b"12345678901234567890")
    );
    conn.execute(
        "UPDATE mfa_accounts SET secret_nonce = zeroblob(12) WHERE id = ?1",
        [&ids[0]],
    )
    .unwrap();
    assert_eq!(
        operations::codes(&conn, &key, Some(&ids), 59_000).unwrap_err(),
        ERR_KEY_MISMATCH
    );
}

#[test]
fn metadata_preferences_usage_order_and_deletion_keep_account_secrets_bound() {
    let mut conn = connection();
    let key = key();
    let added = operations::add(
        &mut conn,
        &key,
        &[hotp_input("Bank"), totp_input("Mail", "JBSWY3DPEHPK3PXP")],
        false,
    )
    .unwrap()
    .added;
    let id = &added[0].id;
    let sealed_before = store::get_sealed(&conn, id).unwrap().unwrap();
    let patch = MfaAccountPatch {
        issuer: " Renamed ".into(),
        account_name: "new@example.com".into(),
        group: " Ops ".into(),
        note: " rotate yearly ".into(),
        pinned: true,
    };
    let account = operations::update(&conn, id, &patch).unwrap();
    assert_eq!(
        (
            account.issuer.as_str(),
            account.group.as_str(),
            account.note.as_str()
        ),
        ("Renamed", "Ops", "rotate yearly")
    );
    assert!(account.pinned);
    assert_eq!(
        (account.id.as_str(), account.created_at),
        (id.as_str(), added[0].created_at)
    );
    assert!(account.updated_at >= added[0].updated_at);
    let sealed_after = store::get_sealed(&conn, id).unwrap().unwrap();
    assert_eq!(sealed_after.ciphertext, sealed_before.ciphertext);
    assert_eq!(sealed_after.nonce, sealed_before.nonce);
    let used = operations::mark_used(&conn, id).unwrap();
    assert_eq!(used.use_count, 1);
    assert!(used.last_used_at.is_some());
    operations::reorder(
        &mut conn,
        &[added[1].id.clone(), "missing".into(), added[1].id.clone()],
    )
    .unwrap();
    let prefs = MfaPrefs {
        sort_mode: "issuer".into(),
        group_filter: "Ops".into(),
    };
    operations::set_prefs(&mut conn, &prefs).unwrap();
    let snapshot = operations::list(&conn).unwrap();
    assert_eq!(snapshot.prefs, prefs);
    assert_eq!(
        snapshot
            .accounts
            .iter()
            .map(|a| a.id.as_str())
            .collect::<Vec<_>>(),
        [added[1].id.as_str(), id.as_str()]
    );
    assert_eq!(
        operations::delete(&conn, "missing").unwrap_err(),
        ERR_NOT_FOUND
    );
    operations::delete(&conn, id).unwrap();
    assert_eq!(operations::mark_used(&conn, id).unwrap_err(), ERR_NOT_FOUND);
    assert_eq!(
        operations::update(&conn, id, &patch).unwrap_err(),
        ERR_NOT_FOUND
    );
    assert_eq!(
        operations::list(&conn).unwrap().accounts,
        vec![store::get_account(&conn, &added[1].id).unwrap().unwrap()]
    );
}
