//! In-memory decoder regression contracts shared with the maintenance harness.
use super::*;

const ID: &str = "mfa.data-key-v1";
const ROOT: [u8; 32] = [19; 32];

fn connection(encoded: &[u8]) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    db::init(&conn).unwrap();
    let nonce = crypto::random_nonce();
    let ciphertext = crypto::aead_encrypt(&ROOT, &nonce, encoded).unwrap();
    db::insert_entry(&conn, ID, "fixture", "mfa_secret", &ciphertext, &nonce, 123).unwrap();
    conn
}

#[test]
fn original_base64_key_load_is_read_only_and_absence_does_not_create_an_entry() {
    let conn = connection(STANDARD.encode([37u8; 32]).as_bytes());
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let before = conn.total_changes();
    let entry = db::get_entry(&conn, ID).unwrap().unwrap();
    assert_eq!(
        load(&conn, &ROOT, ID).unwrap().unwrap().as_bytes(),
        &[37; 32]
    );
    assert!(load(&conn, &ROOT, "missing").unwrap().is_none());
    let after = db::get_entry(&conn, ID).unwrap().unwrap();
    assert_eq!(entry.ciphertext, after.ciphertext);
    assert_eq!(entry.nonce, after.nonce);
    assert_eq!(entry.updated_at, after.updated_at);
    assert_eq!(conn.total_changes(), before);
}

#[test]
fn malformed_encoding_lengths_nonce_and_wrong_root_cannot_be_repaired_by_read() {
    for encoded in [
        STANDARD.encode([37u8; 31]).into_bytes(),
        STANDARD.encode([37u8; 33]).into_bytes(),
        b"not-base64!".to_vec(),
        vec![0xff],
    ] {
        let conn = connection(&encoded);
        conn.execute_batch("PRAGMA query_only=ON").unwrap();
        let before = conn.total_changes();
        assert!(matches!(
            load(&conn, &ROOT, ID),
            Err(PluginKeyError::KeyMismatch)
        ));
        assert_eq!(conn.total_changes(), before);
    }
    let conn = connection(STANDARD.encode([37u8; 32]).as_bytes());
    assert!(matches!(
        load(&conn, &[0; 32], ID),
        Err(PluginKeyError::KeyMismatch)
    ));
    conn.execute("UPDATE vault_entries SET nonce=x'00'", [])
        .unwrap();
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let before = conn.total_changes();
    assert!(matches!(
        load(&conn, &ROOT, ID),
        Err(PluginKeyError::KeyMismatch)
    ));
    assert_eq!(conn.total_changes(), before);
}
