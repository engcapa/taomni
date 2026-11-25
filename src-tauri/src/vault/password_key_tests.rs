//! Pure crypto/metadata checks; no store or filesystem is opened.
use super::*;

const PASSWORD: &str = "original-master-password";

fn metadata() -> db::MetaRow {
    let salt = crypto::random_salt();
    let params = StoredKdfParams {
        m_cost: 1024,
        t_cost: 1,
        p_cost: 1,
    };
    let root =
        crypto::derive_root_key(PASSWORD, &salt, params.m_cost, params.t_cost, params.p_cost)
            .unwrap();
    let nonce = crypto::random_nonce();
    db::MetaRow {
        schema_version: 1,
        kdf: "argon2id".into(),
        kdf_salt: salt.to_vec(),
        kdf_params: serde_json::to_string(&params).unwrap(),
        verifier_ciphertext: crypto::aead_encrypt(&root, &nonce, b"newmob-vault-v1").unwrap(),
        verifier_nonce: nonce.to_vec(),
    }
}

#[test]
fn legacy_verifier_and_original_kdf_parameters_survive_without_metadata_changes() {
    let meta = metadata();
    let before = meta.clone();
    let root = verify(&meta, PASSWORD).unwrap();
    let ciphertext = crypto::aead_encrypt(&root, &[7; 12], b"same-root").unwrap();
    let second = verify(&meta, PASSWORD).unwrap();
    assert_eq!(
        crypto::aead_decrypt(&second, &[7; 12], &ciphertext)
            .unwrap()
            .as_slice(),
        b"same-root"
    );
    assert_eq!(meta, before);
    assert_eq!(verify(&meta, "wrong").unwrap_err(), ERR_VAULT_BAD_PASSWORD);
    // Normalization belongs to the caller; this primitive must not change it.
    assert_eq!(
        verify(&meta, &format!(" {PASSWORD} ")).unwrap_err(),
        ERR_VAULT_BAD_PASSWORD
    );
    assert_eq!(meta, before);
}

#[test]
fn invalid_kdf_verifier_and_nonce_fail_without_replacing_metadata() {
    let original = metadata();
    for mutation in 0..4 {
        let mut meta = original.clone();
        match mutation {
            0 => meta.kdf = "unknown-kdf".into(),
            1 => meta.kdf_params = "invalid-json".into(),
            2 => meta.verifier_nonce = vec![0],
            _ => meta.verifier_ciphertext[0] ^= 1,
        }
        let before = meta.clone();
        assert!(verify(&meta, PASSWORD).is_err());
        assert_eq!(meta, before);
    }
}
