use super::credentials::DBEAVER_LOCAL_CREDENTIALS_KEY;
use super::credentials::parse_dbeaver_credentials_config;

use aes::Aes128;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockModeEncrypt, KeyIvInit};
use serde_json::json;

type Aes128CbcEnc = cbc::Encryptor<Aes128>;

fn encrypt_dbeaver_credentials_fixture(plaintext: &[u8]) -> Vec<u8> {
    let iv = [0x42u8; 16];
    let block_size = 16;
    let pad = block_size - (plaintext.len() % block_size);
    let mut buf = vec![0u8; plaintext.len() + pad];
    buf[..plaintext.len()].copy_from_slice(plaintext);
    let ct_len = Aes128CbcEnc::new_from_slices(&DBEAVER_LOCAL_CREDENTIALS_KEY, &iv)
        .expect("key and iv lengths are fixed")
        .encrypt_padded::<Pkcs7>(&mut buf, plaintext.len())
        .expect("encrypt")
        .len();
    buf.truncate(ct_len);

    let mut encrypted = iv.to_vec();
    encrypted.extend_from_slice(&buf);
    encrypted
}

#[test]
fn decrypts_dbeaver_credentials_config() {
    let payload = json!({
        "conn-1": {
            "#connection": {
                "user": "db_user",
                "password": "db_pass"
            },
            "#ssh": {
                "password": "ssh_pass"
            }
        },
        "conn-2": {
            "#connection": {
                "user": "readonly"
            }
        }
    })
    .to_string();
    let encrypted = encrypt_dbeaver_credentials_fixture(payload.as_bytes());

    let parsed = parse_dbeaver_credentials_config(&encrypted).unwrap();

    let first = parsed.get("conn-1").unwrap();
    assert_eq!(first.user.as_deref(), Some("db_user"));
    assert_eq!(first.password.as_deref(), Some("db_pass"));
    let second = parsed.get("conn-2").unwrap();
    assert_eq!(second.user.as_deref(), Some("readonly"));
    assert_eq!(second.password, None);
}

#[test]
fn rejects_short_dbeaver_credentials_payload() {
    let err = parse_dbeaver_credentials_config(&[0u8; 16]).unwrap_err();
    assert!(err.contains("too short"));
}
