//! Pure in-memory contracts. Real read-only files are checked on GitHub.
use std::cell::Cell;

use rusqlite::{Connection, params};
use zeroize::Zeroizing;

use super::fixtures::{connection, key};
use crate::{
    ERR_KEY_MISMATCH, ERR_KEY_MISSING,
    crypto::{self, DataKey},
    keys::{self, ExistingKeyCheck, KeyProvider},
    store,
};

struct LoadOnly {
    value: Option<[u8; 32]>,
    loads: Cell<u32>,
}

impl LoadOnly {
    fn new(value: Option<[u8; 32]>) -> Self {
        Self {
            value,
            loads: Cell::new(0),
        }
    }
}

impl KeyProvider for LoadOnly {
    fn load(&self) -> Result<Option<DataKey>, String> {
        self.loads.set(self.loads.get() + 1);
        Ok(self.value.map(Zeroizing::new))
    }
    fn initialize_empty(&self) -> Result<DataKey, String> {
        panic!("Read-only verification must never initialize a key")
    }
    fn repair_after_reset(&self) -> Result<DataKey, String> {
        panic!("Read-only verification must never repair a key")
    }
}

fn accounts(bound: bool) -> Connection {
    let conn = connection();
    for id in ["first", "zz-later"] {
        let (ciphertext, nonce) =
            crypto::seal(&key(), &crypto::account_aad(id), b"12345678901234567890").unwrap();
        conn.execute(
            "INSERT INTO mfa_accounts (id, issuer, kind, secret_ct, secret_nonce, fingerprint, created_at, updated_at)
             VALUES (?1, 'fixture', 'hotp', ?2, ?3, ?1, 100, 100)",
            params![id, ciphertext, nonce],
        ).unwrap();
    }
    if bound {
        keys::prepare_key(&conn, &LoadOnly::new(Some(*key()))).unwrap();
    }
    conn
}

fn readonly(conn: &Connection) {
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
}

#[test]
fn unused_and_key_only_empty_databases_never_bind_or_manufacture_a_key() {
    for (value, expected) in [
        (None, ExistingKeyCheck::Unused),
        (
            Some(*key()),
            ExistingKeyCheck::Verified {
                accounts: 0,
                key_check_present: false,
            },
        ),
    ] {
        let conn = connection();
        readonly(&conn);
        let before = conn.total_changes();
        let provider = LoadOnly::new(value);
        assert_eq!(
            keys::verify_existing_key(&conn, &provider, &|| Ok(())).unwrap(),
            expected
        );
        assert_eq!(provider.loads.get(), 1);
        assert!(store::meta_get(&conn, "key_check").unwrap().is_none());
        assert_eq!(conn.total_changes(), before);
    }
}

#[test]
fn both_bound_and_unbound_legacy_ciphertexts_verify_on_a_query_only_connection() {
    for bound in [false, true] {
        let conn = accounts(bound);
        let check_before = store::meta_get(&conn, "key_check").unwrap();
        readonly(&conn);
        let before = conn.total_changes();
        assert_eq!(
            keys::verify_existing_key(&conn, &LoadOnly::new(Some(*key())), &|| Ok(())).unwrap(),
            ExistingKeyCheck::Verified {
                accounts: 2,
                key_check_present: bound
            }
        );
        assert_eq!(store::meta_get(&conn, "key_check").unwrap(), check_before);
        assert_eq!(conn.total_changes(), before);
        assert_eq!(
            crate::operations::codes(&conn, &key(), None, 0).unwrap()[0].code,
            "755224"
        );
    }
}

#[test]
fn missing_and_wrong_keys_never_rebind_an_existing_database() {
    for bound in [false, true] {
        let conn = accounts(bound);
        readonly(&conn);
        let before = conn.total_changes();
        for (value, expected) in [
            (None, ERR_KEY_MISSING),
            (Some([0x99; 32]), ERR_KEY_MISMATCH),
        ] {
            let error =
                keys::verify_existing_key(&conn, &LoadOnly::new(value), &|| Ok(())).unwrap_err();
            assert_eq!(error, expected);
        }
        assert_eq!(conn.total_changes(), before);
    }
}

#[test]
fn valid_key_check_and_first_account_cannot_hide_a_corrupt_later_account() {
    for bound in [false, true] {
        let conn = accounts(bound);
        conn.execute(
            "UPDATE mfa_accounts SET secret_ct=x'00' WHERE id='zz-later'",
            [],
        )
        .unwrap();
        assert!(store::first_secret_opens(&conn, &key()).unwrap());
        readonly(&conn);
        let before = conn.total_changes();
        assert_eq!(
            keys::verify_existing_key(&conn, &LoadOnly::new(Some(*key())), &|| Ok(())).unwrap_err(),
            ERR_KEY_MISMATCH
        );
        assert_eq!(conn.total_changes(), before);
    }
}

#[test]
fn malformed_key_check_nonce_or_row_binding_is_rejected_without_repair() {
    for mutation in [
        "UPDATE mfa_meta SET value=x'00' WHERE key='key_check'",
        "UPDATE mfa_accounts SET secret_nonce=x'00' WHERE id='zz-later'",
        "UPDATE mfa_accounts SET id='different-row' WHERE id='zz-later'",
    ] {
        let conn = accounts(true);
        conn.execute(mutation, []).unwrap();
        readonly(&conn);
        let before = conn.total_changes();
        assert_eq!(
            keys::verify_existing_key(&conn, &LoadOnly::new(Some(*key())), &|| Ok(())).unwrap_err(),
            ERR_KEY_MISMATCH
        );
        assert_eq!(conn.total_changes(), before);
    }
}

#[test]
fn cancellation_prevents_key_access_and_interrupts_the_stream_before_corrupt_later_data() {
    let conn = accounts(true);
    conn.execute(
        "UPDATE mfa_accounts SET secret_ct=x'00' WHERE id='zz-later'",
        [],
    )
    .unwrap();
    readonly(&conn);
    let provider = LoadOnly::new(Some(*key()));
    assert_eq!(
        keys::verify_existing_key(&conn, &provider, &|| Err("BACKUP_CANCELLED".into()))
            .unwrap_err(),
        "BACKUP_CANCELLED"
    );
    assert_eq!(provider.loads.get(), 0);
    let checks = Cell::new(0);
    let result = keys::verify_existing_key(&conn, &provider, &|| {
        checks.set(checks.get() + 1);
        if checks.get() >= 6 {
            Err("BACKUP_CANCELLED".into())
        } else {
            Ok(())
        }
    });
    assert_eq!(result.unwrap_err(), "BACKUP_CANCELLED");
    assert_eq!(provider.loads.get(), 1);
}

#[test]
fn a_retained_key_check_without_accounts_is_not_an_unused_database() {
    let conn = connection();
    keys::ensure_key(&conn, &LoadOnly::new(Some(*key()))).unwrap();
    readonly(&conn);
    assert_eq!(
        keys::verify_existing_key(&conn, &LoadOnly::new(None), &|| Ok(())).unwrap_err(),
        ERR_KEY_MISSING
    );
    assert_eq!(store::count_accounts(&conn).unwrap(), 0);
    assert!(store::meta_get(&conn, "key_check").unwrap().is_some());
}

#[test]
fn cancellation_during_key_resolution_precedes_any_database_access() {
    // No schema: reaching even a metadata query would give a different error.
    let conn = Connection::open_in_memory().unwrap();
    let provider = LoadOnly::new(Some(*key()));
    let result = keys::verify_existing_key(&conn, &provider, &|| {
        if provider.loads.get() != 0 {
            Err("BACKUP_TIMEOUT".into())
        } else {
            Ok(())
        }
    });
    assert_eq!(result.unwrap_err(), "BACKUP_TIMEOUT");
    assert_eq!(provider.loads.get(), 1);
    assert_eq!(conn.total_changes(), 0);
}
