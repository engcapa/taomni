//! Password verification and root-key transitions. The registry coordinator
//! owns admission and cross-process leases before entering these methods.
use super::*;

impl Vault {
    pub fn init(&self, master_password: &str) -> Result<(), String> {
        if master_password.len() < 8 {
            return Err("master password must be at least 8 characters".into());
        }
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if db::get_meta(&inner.conn)
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Err("vault already initialized".into());
        }

        let salt = crypto::random_salt();
        let root_key = crypto::derive_root_key(
            master_password,
            &salt,
            crypto::ARGON2_M_COST,
            crypto::ARGON2_T_COST,
            crypto::ARGON2_P_COST,
        )
        .map_err(|e| e.to_string())?;

        let verifier_nonce = crypto::random_nonce();
        let verifier_ciphertext =
            crypto::aead_encrypt(&root_key, &verifier_nonce, crypto::VERIFIER_PLAINTEXT)
                .map_err(|e| e.to_string())?;

        let params_json = serde_json::to_string(&StoredKdfParams {
            m_cost: crypto::ARGON2_M_COST,
            t_cost: crypto::ARGON2_T_COST,
            p_cost: crypto::ARGON2_P_COST,
        })
        .map_err(|e| e.to_string())?;

        db::put_meta(
            &inner.conn,
            "argon2id",
            &salt,
            &params_json,
            &verifier_ciphertext,
            &verifier_nonce,
            Self::now(),
        )
        .map_err(|e| e.to_string())?;

        inner.root_revision = db::get_meta(&inner.conn).map_err(|e| e.to_string())?;
        inner.root_key = Some(root_key);
        let _ = db::touch_unlocked(&inner.conn, Self::now());
        Ok(())
    }

    /// Verify whether the provided master password is valid.
    /// - If vault is uninitialized (empty), returns `Ok(())` without checking.
    /// - If vault is initialized, requires a non-empty password and verifies it against the argon2id verifier.
    /// - On success, keeps the vault unlocked.
    pub fn verify_master_password(&self, password: Option<&str>) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let meta = match db::get_meta(&inner.conn).map_err(|e| e.to_string())? {
            Some(m) => m,
            None => return Ok(()),
        };

        let pw = password.unwrap_or_default().trim();
        if pw.is_empty() {
            return Err(ERR_VAULT_PASSWORD_REQUIRED.to_string());
        }

        if meta.kdf != "argon2id" {
            return Err(format!("unsupported kdf: {}", meta.kdf));
        }
        let params: StoredKdfParams =
            serde_json::from_str(&meta.kdf_params).map_err(|e| e.to_string())?;

        let root_key = crypto::derive_root_key(
            pw,
            &meta.kdf_salt,
            params.m_cost,
            params.t_cost,
            params.p_cost,
        )
        .map_err(|e| e.to_string())?;

        let nonce: [u8; crypto::NONCE_LEN] = meta
            .verifier_nonce
            .as_slice()
            .try_into()
            .map_err(|_| "verifier nonce shape".to_string())?;

        let plaintext = crypto::aead_decrypt(&root_key, &nonce, &meta.verifier_ciphertext)
            .map_err(|_| ERR_VAULT_BAD_PASSWORD.to_string())?;

        if plaintext.as_slice() != crypto::VERIFIER_PLAINTEXT {
            return Err(ERR_VAULT_BAD_PASSWORD.to_string());
        }

        inner.root_revision = Some(meta);
        inner.root_key = Some(root_key);
        let _ = db::touch_unlocked(&inner.conn, Self::now());
        Ok(())
    }

    pub fn unlock(&self, master_password: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let meta = db::get_meta(&inner.conn)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| ERR_VAULT_EMPTY.to_string())?;

        if meta.kdf != "argon2id" {
            return Err(format!("unsupported kdf: {}", meta.kdf));
        }
        let params: StoredKdfParams =
            serde_json::from_str(&meta.kdf_params).map_err(|e| e.to_string())?;

        let root_key = crypto::derive_root_key(
            master_password,
            &meta.kdf_salt,
            params.m_cost,
            params.t_cost,
            params.p_cost,
        )
        .map_err(|e| e.to_string())?;

        let nonce: [u8; crypto::NONCE_LEN] = meta
            .verifier_nonce
            .as_slice()
            .try_into()
            .map_err(|_| "verifier nonce shape".to_string())?;

        let plaintext = crypto::aead_decrypt(&root_key, &nonce, &meta.verifier_ciphertext)
            .map_err(|_| ERR_VAULT_BAD_PASSWORD.to_string())?;

        if plaintext.as_slice() != crypto::VERIFIER_PLAINTEXT {
            return Err(ERR_VAULT_BAD_PASSWORD.to_string());
        }

        inner.root_revision = Some(meta);
        inner.root_key = Some(root_key);
        let _ = db::touch_unlocked(&inner.conn, Self::now());
        Ok(())
    }

    pub fn lock(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.root_key = None;
        inner.root_revision = None;
        Ok(())
    }

    pub fn change_master(&self, old: &str, new: &str) -> Result<(), String> {
        if new.len() < 8 {
            return Err("new master password must be at least 8 characters".into());
        }

        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;

        let meta = db::get_meta(&inner.conn)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| ERR_VAULT_EMPTY.to_string())?;
        let params: StoredKdfParams =
            serde_json::from_str(&meta.kdf_params).map_err(|e| e.to_string())?;

        let old_key = crypto::derive_root_key(
            old,
            &meta.kdf_salt,
            params.m_cost,
            params.t_cost,
            params.p_cost,
        )
        .map_err(|e| e.to_string())?;

        let nonce: [u8; crypto::NONCE_LEN] = meta
            .verifier_nonce
            .as_slice()
            .try_into()
            .map_err(|_| "verifier nonce shape".to_string())?;
        let probe = crypto::aead_decrypt(&old_key, &nonce, &meta.verifier_ciphertext)
            .map_err(|_| ERR_VAULT_BAD_PASSWORD.to_string())?;
        if probe.as_slice() != crypto::VERIFIER_PLAINTEXT {
            return Err(ERR_VAULT_BAD_PASSWORD.to_string());
        }

        // Derive a fresh new salt + key.
        let new_salt = crypto::random_salt();
        let new_key = crypto::derive_root_key(
            new,
            &new_salt,
            crypto::ARGON2_M_COST,
            crypto::ARGON2_T_COST,
            crypto::ARGON2_P_COST,
        )
        .map_err(|e| e.to_string())?;

        // Rewrap every entry under the new key in a single transaction so a
        // crash mid-rekey does not leave the DB inconsistent.
        let entries = db::list_all_for_rekey(&inner.conn).map_err(|e| e.to_string())?;
        let tx = inner
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        for e in entries {
            let entry_nonce: [u8; crypto::NONCE_LEN] = e
                .nonce
                .as_slice()
                .try_into()
                .map_err(|_| "stored nonce shape".to_string())?;
            let plain = crypto::aead_decrypt(&old_key, &entry_nonce, &e.ciphertext)
                .map_err(|e| e.to_string())?;
            let new_nonce = crypto::random_nonce();
            let new_ct = crypto::aead_encrypt(&new_key, &new_nonce, plain.as_slice())
                .map_err(|e| e.to_string())?;
            db::update_entry(&tx, &e.id, &new_ct, &new_nonce, Self::now())
                .map_err(|e| e.to_string())?;
        }

        // Rewrap the verifier and rewrite meta.
        let new_verifier_nonce = crypto::random_nonce();
        let new_verifier_ct =
            crypto::aead_encrypt(&new_key, &new_verifier_nonce, crypto::VERIFIER_PLAINTEXT)
                .map_err(|e| e.to_string())?;
        let new_params_json = serde_json::to_string(&StoredKdfParams {
            m_cost: crypto::ARGON2_M_COST,
            t_cost: crypto::ARGON2_T_COST,
            p_cost: crypto::ARGON2_P_COST,
        })
        .map_err(|e| e.to_string())?;
        db::put_meta(
            &tx,
            "argon2id",
            &new_salt,
            &new_params_json,
            &new_verifier_ct,
            &new_verifier_nonce,
            Self::now(),
        )
        .map_err(|e| e.to_string())?;

        tx.commit().map_err(|e| e.to_string())?;
        inner.root_revision = db::get_meta(&inner.conn).map_err(|e| e.to_string())?;
        inner.root_key = Some(new_key);
        Ok(())
    }
}
