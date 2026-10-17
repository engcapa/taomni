use crate::vault::crypto::{
    ARGON2_M_COST, ARGON2_P_COST, ARGON2_T_COST, NONCE_LEN, SALT_LEN, aead_decrypt, aead_encrypt,
    derive_root_key, random_nonce, random_salt,
};
use std::io::{Read, Write};

pub const BACKUP_ENC_MAGIC: &[u8; 13] = b"TAOBAK_ENC_V1";
pub const BACKUP_ENC_STREAM_MAGIC: &[u8; 13] = b"TAOBAK_ENC_V2";
const FRAME_BYTES: usize = 1024 * 1024;

pub const ERR_BACKUP_BAD_PASSWORD: &str = "BACKUP_BAD_PASSWORD";
pub const ERR_BACKUP_PASSWORD_REQUIRED: &str = "BACKUP_PASSWORD_REQUIRED";

/// Check if the stream starts with our encrypted archive magic header.
pub fn is_encrypted_stream<R: Read>(mut reader: R) -> bool {
    let mut magic = [0u8; 13];
    if reader.read_exact(&mut magic).is_ok() {
        is_encrypted_bytes(&magic)
    } else {
        false
    }
}

/// Check if byte slice starts with our encrypted archive magic header.
pub fn is_encrypted_bytes(bytes: &[u8]) -> bool {
    bytes.starts_with(BACKUP_ENC_MAGIC) || bytes.starts_with(BACKUP_ENC_STREAM_MAGIC)
}

/// Encrypt arbitrary payload bytes with password-derived AES-256-GCM.
///
/// Output format:
/// `[13 bytes magic][16 bytes salt][12 bytes nonce][ciphertext + tag]`
pub fn encrypt_payload(payload: &[u8], password: &str) -> Result<Vec<u8>, String> {
    if password.is_empty() {
        return Err("Password cannot be empty for encrypted backup".into());
    }
    let salt = random_salt();
    let nonce = random_nonce();
    let root_key = derive_root_key(password, &salt, ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST)
        .map_err(|e| format!("key derivation error: {e}"))?;

    let ciphertext =
        aead_encrypt(&root_key, &nonce, payload).map_err(|e| format!("encryption failed: {e}"))?;

    let mut out = Vec::with_capacity(13 + SALT_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(BACKUP_ENC_MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt an encrypted archive payload using the user-provided password.
pub fn decrypt_payload(data: &[u8], password: &str) -> Result<Vec<u8>, String> {
    if data.starts_with(BACKUP_ENC_STREAM_MAGIC) {
        let mut out = Vec::new();
        decrypt_stream(data, password, &mut out)?;
        return Ok(out);
    }
    let header_len = 13 + SALT_LEN + NONCE_LEN;
    if data.len() < header_len {
        return Err("corrupt or truncated encrypted backup file".into());
    }
    if !data.starts_with(BACKUP_ENC_MAGIC) {
        return Err("not an encrypted taobak archive".into());
    }
    if password.is_empty() {
        return Err(ERR_BACKUP_PASSWORD_REQUIRED.into());
    }

    let salt_slice = &data[13..13 + SALT_LEN];
    let nonce_slice = &data[13 + SALT_LEN..header_len];
    let ciphertext = &data[header_len..];

    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(nonce_slice);

    let root_key = derive_root_key(
        password,
        salt_slice,
        ARGON2_M_COST,
        ARGON2_T_COST,
        ARGON2_P_COST,
    )
    .map_err(|e| format!("key derivation error: {e}"))?;

    let decrypted = aead_decrypt(&root_key, &nonce, ciphertext)
        .map_err(|_| ERR_BACKUP_BAD_PASSWORD.to_string())?;

    Ok(decrypted.to_vec())
}

/// V2: independently authenticated 1 MiB frames, sequential nonces and an
/// authenticated empty final frame. Reordering, truncation and trailing bytes
/// fail validation. The random salt derives a different key for each archive.
pub fn encrypt_stream(
    mut source: impl Read,
    password: &str,
    mut target: impl Write,
) -> Result<(), String> {
    if password.is_empty() {
        return Err(ERR_BACKUP_PASSWORD_REQUIRED.into());
    }
    let salt = random_salt();
    let mut nonce = random_nonce();
    nonce[8..].fill(0);
    let key = derive_root_key(password, &salt, ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST)
        .map_err(|e| e.to_string())?;
    target
        .write_all(BACKUP_ENC_STREAM_MAGIC)
        .and_then(|_| target.write_all(&salt))
        .and_then(|_| target.write_all(&nonce))
        .map_err(|e| e.to_string())?;
    let mut buffer = vec![0u8; FRAME_BYTES];
    let mut index = 0u32;
    loop {
        let mut n = 0;
        while n < buffer.len() {
            let read = source.read(&mut buffer[n..]).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            n += read;
        }
        nonce[8..].copy_from_slice(&index.to_be_bytes());
        let encrypted = aead_encrypt(&key, &nonce, &buffer[..n]).map_err(|e| e.to_string())?;
        target
            .write_all(&(n as u32).to_be_bytes())
            .and_then(|_| target.write_all(&encrypted))
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(());
        }
        index = index
            .checked_add(1)
            .ok_or("Encrypted backup has too many frames")?;
    }
}

pub fn decrypt_stream(
    mut source: impl Read,
    password: &str,
    mut target: impl Write,
) -> Result<(), String> {
    if password.is_empty() {
        return Err(ERR_BACKUP_PASSWORD_REQUIRED.into());
    }
    let mut magic = [0u8; 13];
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    source
        .read_exact(&mut magic)
        .and_then(|_| source.read_exact(&mut salt))
        .and_then(|_| source.read_exact(&mut nonce))
        .map_err(|_| "Truncated encrypted backup")?;
    if &magic != BACKUP_ENC_STREAM_MAGIC || nonce[8..] != [0u8; 4] {
        return Err("Unsupported encrypted stream".into());
    }
    let key = derive_root_key(password, &salt, ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST)
        .map_err(|e| e.to_string())?;
    let mut index = 0u32;
    loop {
        let mut length = [0u8; 4];
        source
            .read_exact(&mut length)
            .map_err(|_| "Encrypted backup is missing its final frame")?;
        let n = u32::from_be_bytes(length) as usize;
        if n > FRAME_BYTES {
            return Err("Invalid encrypted frame size".into());
        }
        let mut encrypted = vec![0u8; n + 16];
        source
            .read_exact(&mut encrypted)
            .map_err(|_| "Truncated encrypted frame")?;
        nonce[8..].copy_from_slice(&index.to_be_bytes());
        let bytes = aead_decrypt(&key, &nonce, &encrypted).map_err(|_| ERR_BACKUP_BAD_PASSWORD)?;
        if n == 0 {
            let mut extra = [0u8; 1];
            if source.read(&mut extra).map_err(|e| e.to_string())? != 0 {
                return Err("Unexpected trailing encrypted data".into());
            }
            return Ok(());
        }
        target.write_all(&bytes).map_err(|e| e.to_string())?;
        index = index
            .checked_add(1)
            .ok_or("Encrypted backup has too many frames")?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let plaintext = b"Hello Taomni Backup World! SQLite Consistent Snapshot.";
        let password = "SuperSecretPassword123!";

        let encrypted = encrypt_payload(plaintext, password).expect("encrypt");
        assert!(is_encrypted_bytes(&encrypted));

        let wrong_pw_res = decrypt_payload(&encrypted, "wrong_pw");
        assert_eq!(wrong_pw_res.err().unwrap(), ERR_BACKUP_BAD_PASSWORD);

        let decrypted = decrypt_payload(&encrypted, password).expect("decrypt");
        assert_eq!(&decrypted, plaintext);
    }
}
