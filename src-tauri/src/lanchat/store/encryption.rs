use super::lifetime::LanChatStore;
use crate::vault::crypto;
use rusqlite::params;
use zeroize::Zeroizing;

impl LanChatStore {
    /// Attach the at-rest message-encryption key (idempotent; first set wins).
    pub fn set_message_key(&self, key: &[u8]) {
        if key.len() != crypto::KEY_LEN {
            log::error!("lanchat: message key has wrong length {}", key.len());
            return;
        }
        let mut arr = [0u8; crypto::KEY_LEN];
        arr.copy_from_slice(key);
        let _ = self.msg_key.set(Zeroizing::new(arr));
    }

    /// Encrypt a body to `nonce || ciphertext`, or `None` when no key is attached
    /// (callers then store plaintext with `enc_ver = 0`).
    pub(super) fn encrypt_body(&self, plaintext: &str) -> Option<Vec<u8>> {
        let key = self.msg_key.get()?;
        let nonce = crypto::random_nonce();
        let ct = crypto::aead_encrypt(key, &nonce, plaintext.as_bytes()).ok()?;
        let mut out = Vec::with_capacity(crypto::NONCE_LEN + ct.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Some(out)
    }

    /// Decrypt a `nonce || ciphertext` body blob; empty string on any failure
    /// (missing key, truncated blob, wrong key).
    pub(super) fn decrypt_body(&self, blob: &[u8]) -> String {
        let Some(key) = self.msg_key.get() else {
            return String::new();
        };
        if blob.len() < crypto::NONCE_LEN {
            return String::new();
        }
        let (nonce, ct) = blob.split_at(crypto::NONCE_LEN);
        let Ok(nonce) = <[u8; crypto::NONCE_LEN]>::try_from(nonce) else {
            return String::new();
        };
        match crypto::aead_decrypt(key, &nonce, ct) {
            Ok(pt) => String::from_utf8_lossy(&pt).to_string(),
            Err(_) => String::new(),
        }
    }

    /// Encrypt any legacy plaintext message rows in place (run once after the key
    /// is attached). Returns the number of rows migrated.
    pub fn migrate_message_encryption(&self) -> rusqlite::Result<usize> {
        if self.msg_key.get().is_none() {
            return Ok(0);
        }
        let pending: Vec<(String, String)> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt =
                conn.prepare("SELECT id, body FROM messages WHERE enc_ver = 0 AND body <> ''")?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut migrated = 0;
        for (id, body) in pending {
            if let Some(ct) = self.encrypt_body(&body) {
                let conn = self.conn.lock().unwrap();
                conn.execute(
                    "UPDATE messages SET body_cipher = ?2, enc_ver = 1, body = '' WHERE id = ?1",
                    params![id, ct],
                )?;
                migrated += 1;
            }
        }
        Ok(migrated)
    }
}
