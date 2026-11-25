use std::cell::{Cell, RefCell};

use super::fixtures::{connection, hotp_input, key};
use crate::{
    ERR_KEY_MISMATCH, ERR_KEY_MISSING,
    crypto::DataKey,
    keys::{self, KeyProvider},
    operations, store,
};
use zeroize::Zeroizing;

struct Keys {
    value: RefCell<Option<[u8; 32]>>,
    initialized: Cell<u32>,
    repaired: Cell<u32>,
}

impl Keys {
    fn new(value: Option<[u8; 32]>) -> Self {
        Self {
            value: RefCell::new(value),
            initialized: Cell::new(0),
            repaired: Cell::new(0),
        }
    }
}

impl KeyProvider for Keys {
    fn load(&self) -> Result<Option<DataKey>, String> {
        Ok(self.value.borrow().as_ref().map(|key| Zeroizing::new(*key)))
    }

    fn initialize_empty(&self) -> Result<DataKey, String> {
        self.initialized.set(self.initialized.get() + 1);
        let mut value = self.value.borrow_mut();
        Ok(Zeroizing::new(*value.get_or_insert([0x11; 32])))
    }

    fn repair_after_reset(&self) -> Result<DataKey, String> {
        self.repaired.set(self.repaired.get() + 1);
        let mut value = self.value.borrow_mut();
        Ok(Zeroizing::new(*value.get_or_insert([0x22; 32])))
    }
}

#[test]
fn pristine_probe_does_not_create_a_key_and_empty_initialization_is_reusable() {
    let conn = connection();
    let provider = Keys::new(None);
    assert!(keys::prepare_key(&conn, &provider).unwrap().is_none());
    assert!(store::meta_get(&conn, "key_check").unwrap().is_none());
    assert_eq!(provider.initialized.get(), 0);
    let key = keys::ensure_key(&conn, &provider).unwrap();
    assert_eq!(*key, [0x11; 32]);
    let record = store::meta_get(&conn, "key_check").unwrap().unwrap();
    assert_eq!(*keys::ensure_key(&conn, &provider).unwrap(), *key);
    assert_eq!(provider.initialized.get(), 1);
    assert_eq!(provider.repaired.get(), 0);
    assert_eq!(
        store::meta_get(&conn, "key_check").unwrap().unwrap(),
        record
    );
}

#[test]
fn missing_or_wrong_keys_never_replace_existing_account_keys() {
    let mut conn = connection();
    let valid = Keys::new(Some([0x11; 32]));
    let key = keys::ensure_key(&conn, &valid).unwrap();
    let account = operations::add(&mut conn, &key, &[hotp_input("Bank")], false)
        .unwrap()
        .added
        .remove(0);
    let check = store::meta_get(&conn, "key_check").unwrap().unwrap();
    let missing = Keys::new(None);
    assert_eq!(
        keys::ensure_key(&conn, &missing).unwrap_err(),
        ERR_KEY_MISSING
    );
    let wrong = Keys::new(Some([0x99; 32]));
    assert_eq!(
        keys::prepare_key(&conn, &wrong).unwrap_err(),
        ERR_KEY_MISMATCH
    );
    assert_eq!(missing.initialized.get() + wrong.initialized.get(), 0);
    assert_eq!(missing.repaired.get() + wrong.repaired.get(), 0);
    assert_eq!(store::meta_get(&conn, "key_check").unwrap().unwrap(), check);
    assert_eq!(
        store::get_account(&conn, &account.id).unwrap().unwrap(),
        account
    );
    assert_eq!(
        operations::codes(&conn, &key, None, 0).unwrap()[0].code,
        "755224"
    );

    // Explicit reset is the only path allowing a missing key to be repaired.
    store::reset(&conn).unwrap();
    let replacement = keys::rebind_after_reset(&conn, &missing).unwrap();
    assert_eq!(*replacement, [0x22; 32]);
    assert_eq!(missing.repaired.get(), 1);
    assert_eq!(store::count_accounts(&conn).unwrap(), 0);
    assert_eq!(
        *keys::prepare_key(&conn, &missing).unwrap().unwrap(),
        *replacement
    );
}

#[test]
fn legacy_store_without_a_check_verifies_its_first_ciphertext_before_binding() {
    let mut conn = connection();
    let key = key();
    operations::add(&mut conn, &key, &[hotp_input("Legacy")], false).unwrap();
    let wrong = Keys::new(Some([0x99; 32]));
    assert_eq!(
        keys::prepare_key(&conn, &wrong).unwrap_err(),
        ERR_KEY_MISMATCH
    );
    assert!(store::meta_get(&conn, "key_check").unwrap().is_none());
    let missing = Keys::new(None);
    assert_eq!(
        keys::prepare_key(&conn, &missing).unwrap_err(),
        ERR_KEY_MISSING
    );
    assert!(store::meta_get(&conn, "key_check").unwrap().is_none());
    let valid = Keys::new(Some(*key));
    assert_eq!(*keys::prepare_key(&conn, &valid).unwrap().unwrap(), *key);
    assert!(store::meta_get(&conn, "key_check").unwrap().is_some());
    assert_eq!(valid.initialized.get(), 0);
}

#[test]
fn fixed_v1_ciphertext_and_key_check_still_decrypt_without_rewriting() {
    // Independently generated AES-256-GCM vectors (Python cryptography), using
    // the original v1 account AAD, key-check AAD/plaintext and record layout.
    let conn = connection();
    let ciphertext =
        hex::decode("22d185274e9502cc2d88e2adf79bc210fe9939584db2bae9c3126800cbfe8a59b6512975")
            .unwrap();
    let nonce: Vec<u8> = (0..12).collect();
    let check = hex::decode("0c0d0e0f1011121314151617c8bfd1f977b7ae712c7c812aba459cfb4ee20b60073a21b1cb52c492593be9724ff00b2898bfaf").unwrap();
    conn.execute(
        "INSERT INTO mfa_accounts (id, issuer, kind, secret_ct, secret_nonce, fingerprint, created_at, updated_at)
         VALUES ('legacy-account-0001', 'Legacy', 'hotp', ?1, ?2, 'legacy-fingerprint', 100, 100)",
        rusqlite::params![ciphertext, nonce],
    ).unwrap();
    store::meta_set(&conn, "key_check", &check).unwrap();
    let provider = Keys::new(Some([0x11; 32]));
    let key = keys::ensure_key(&conn, &provider).unwrap();
    assert_eq!(
        operations::codes(&conn, &key, None, 0).unwrap()[0].code,
        "755224"
    );
    let next = operations::hotp_next(&conn, &key, "legacy-account-0001").unwrap();
    assert_eq!((next.code.as_str(), next.counter), ("287082", 1));
    let sealed = store::get_sealed(&conn, "legacy-account-0001")
        .unwrap()
        .unwrap();
    assert_eq!(sealed.ciphertext, ciphertext);
    assert_eq!(sealed.nonce, nonce);
    assert_eq!(sealed.account.created_at, 100);
    assert_eq!(store::meta_get(&conn, "key_check").unwrap().unwrap(), check);
    assert_eq!(provider.initialized.get() + provider.repaired.get(), 0);
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
