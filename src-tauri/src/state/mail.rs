use super::{AppState, MailDbHandle};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub(crate) struct MailRuntime {
    // Each account's database is separate from taomni.db and other accounts.
    cache_root: PathBuf,
    databases: Mutex<HashMap<String, MailDbHandle>>,
    // The pool also owns each connection's account-level proxy forwarder.
    pub(crate) mail_imap_pool: Arc<crate::mail::MailImapPool>,
    pub(crate) mail_archive: crate::mail::archive::ArchiveManager,
}

impl MailRuntime {
    pub(crate) fn new(profile: &Path) -> Self {
        Self {
            // MailDatabase creates the selected account directory when it opens storage.
            cache_root: profile.join("mail-cache"),
            databases: Mutex::new(HashMap::new()),
            mail_imap_pool: Arc::new(crate::mail::MailImapPool::new()),
            mail_archive: crate::mail::archive::ArchiveManager::default(),
        }
    }

    pub(crate) fn database(
        &self,
        account_id: &str,
        load_options: impl FnOnce() -> Result<Option<String>, String>,
    ) -> Result<MailDbHandle, String> {
        let stem = mail_db_file_stem(account_id);
        let mut dbs = self.databases.lock().map_err(|e| e.to_string())?;
        if let Some(db) = dbs.get(&stem) {
            return Ok(Arc::clone(db));
        }

        let configured = load_options()?
            .map(|options| crate::mail::storage::configured_directory(&options, &self.cache_root))
            .transpose()?
            .unwrap_or_else(|| self.cache_root.clone());
        let path = configured.join(format!("{stem}.db"));
        let handle = Arc::new(crate::mail::coordination::mailbox_database(path));
        dbs.insert(stem, Arc::clone(&handle));
        Ok(handle)
    }
}

impl AppState {
    pub fn mail_cache_root(&self) -> &Path {
        &self.legacy.mail.cache_root
    }

    pub fn mail_db(&self, account_id: &str) -> Result<MailDbHandle, String> {
        self.legacy.mail.database(account_id, || {
            let db = self.core.db.lock().map_err(|error| error.to_string())?;
            Ok(crate::session::db::get_session(&db, account_id)
                .ok()
                .map(|session| session.options_json))
        })
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
