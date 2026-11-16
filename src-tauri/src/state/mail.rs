use super::{CoreState, MailDbHandle};
use std::sync::Arc;

impl CoreState {
    /// Root of the per-account mail caches (`<app_data>/mail-cache`).
    pub fn mail_cache_root(&self) -> &std::path::Path {
        &self.mail.mail_db_dir
    }

    pub fn mail_db(&self, account_id: &str) -> Result<MailDbHandle, String> {
        let stem = mail_db_file_stem(account_id);
        let mut dbs = self.mail.mail_dbs.lock().map_err(|e| e.to_string())?;
        if let Some(db) = dbs.get(&stem) {
            return Ok(Arc::clone(db));
        }

        let configured = {
            let db = self.db.lock().map_err(|e| e.to_string())?;
            crate::session::db::get_session(&db, account_id)
                .ok()
                .map(|session| {
                    crate::mail::storage::configured_directory(
                        &session.options_json,
                        &self.mail.mail_db_dir,
                    )
                })
                .transpose()?
                .unwrap_or_else(|| self.mail.mail_db_dir.clone())
        };
        let path = configured.join(format!("{stem}.db"));
        let handle = Arc::new(crate::mail::coordination::MailDatabase::new(path));
        dbs.insert(stem, Arc::clone(&handle));
        Ok(handle)
    }
}

pub(crate) fn mail_db_file_stem(account_id: &str) -> String {
    use sha2::{Digest, Sha256};

    let mut cleaned = account_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if cleaned.is_empty() {
        cleaned = "mail".into();
    }
    cleaned = cleaned.chars().take(80).collect();

    let digest = Sha256::digest(account_id.as_bytes());
    let digest_hex = hex::encode(digest);
    format!("{cleaned}-{}", &digest_hex[..16])
}
