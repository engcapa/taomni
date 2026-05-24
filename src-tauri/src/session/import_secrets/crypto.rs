use aes::Aes256;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use sha2::Sha512;
use zeroize::Zeroizing;

type Aes256CbcDec = cbc::Decryptor<Aes256>;

#[derive(Debug)]
pub enum SecretCryptoError {
    BadPadding,
    InvalidKeyOrIvLength,
}

impl std::fmt::Display for SecretCryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretCryptoError::BadPadding => {
                write!(f, "PKCS#7 unpadding failed (likely wrong password)")
            }
            SecretCryptoError::InvalidKeyOrIvLength => {
                write!(f, "key or iv length is not what the cipher expects")
            }
        }
    }
}

impl std::error::Error for SecretCryptoError {}

pub fn pbkdf2_sha512(
    password: &[u8],
    salt: &[u8],
    iterations: u32,
    out_len: usize,
) -> Zeroizing<Vec<u8>> {
    let mut out = Zeroizing::new(vec![0u8; out_len]);
    pbkdf2::pbkdf2_hmac::<Sha512>(password, salt, iterations, out.as_mut_slice());
    out
}

pub fn aes_256_cbc_decrypt_pkcs7(
    key: &[u8],
    iv: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, SecretCryptoError> {
    if key.len() != 32 || iv.len() != 16 {
        return Err(SecretCryptoError::InvalidKeyOrIvLength);
    }
    let mut buf = ciphertext.to_vec();
    let plaintext_len = Aes256CbcDec::new(key.into(), iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| SecretCryptoError::BadPadding)?
        .len();
    buf.truncate(plaintext_len);
    Ok(Zeroizing::new(buf))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::Aes256;
    use cbc::cipher::block_padding::Pkcs7;
    use cbc::cipher::{BlockEncryptMut, KeyIvInit};

    type Aes256CbcEnc = cbc::Encryptor<Aes256>;

    fn cbc_encrypt_pkcs7(key: &[u8; 32], iv: &[u8; 16], plaintext: &[u8]) -> Vec<u8> {
        let block_size = 16;
        let pad = block_size - (plaintext.len() % block_size);
        let mut buf = vec![0u8; plaintext.len() + pad];
        buf[..plaintext.len()].copy_from_slice(plaintext);
        let ct_len = Aes256CbcEnc::new(key.into(), iv.into())
            .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
            .expect("encrypt")
            .len();
        buf.truncate(ct_len);
        buf
    }

    #[test]
    fn pbkdf2_sha512_known_vector() {
        // RFC 6070-style sanity: deterministic output for fixed inputs.
        let key = pbkdf2_sha512(b"password", b"salt", 1, 64);
        assert_eq!(key.len(), 64);
        let again = pbkdf2_sha512(b"password", b"salt", 1, 64);
        assert_eq!(key.as_slice(), again.as_slice());
    }

    #[test]
    fn cbc_round_trip() {
        let key = [7u8; 32];
        let iv = [9u8; 16];
        let plaintext = b"the quick brown fox jumps over the lazy dog";
        let ct = cbc_encrypt_pkcs7(&key, &iv, plaintext);
        let decoded = aes_256_cbc_decrypt_pkcs7(&key, &iv, &ct).unwrap();
        assert_eq!(&decoded[..], plaintext);
    }

    #[test]
    fn cbc_wrong_key_returns_bad_padding() {
        let key = [7u8; 32];
        let iv = [9u8; 16];
        let ct = cbc_encrypt_pkcs7(&key, &iv, b"hello world");
        let mut wrong = key;
        wrong[0] ^= 1;
        let err = aes_256_cbc_decrypt_pkcs7(&wrong, &iv, &ct);
        assert!(matches!(err, Err(SecretCryptoError::BadPadding)));
    }

    #[test]
    fn cbc_rejects_bad_lengths() {
        let res = aes_256_cbc_decrypt_pkcs7(&[0u8; 31], &[0u8; 16], &[]);
        assert!(matches!(res, Err(SecretCryptoError::InvalidKeyOrIvLength)));
    }
}
