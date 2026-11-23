use super::{AppState, MailDbHandle};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
pub(crate) use taomni_mail_engine::database::mail_db_file_stem;

pub(crate) struct MailRuntime {
    // Each account's database is separate from taomni.db and other accounts.
    cache_root: PathBuf,
    databases: Mutex<HashMap<String, MailDbHandle>>,
    mutation_gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pop3_owner_gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub(crate) migrated: Result<bool, String>,
    // The pool also owns each connection's account-level proxy forwarder.
    #[cfg(any(test, feature = "legacy-mail-imap"))]
    pub(crate) mail_imap_pool: Arc<crate::mail::MailImapPool>,
    pub(crate) mail_archive: Arc<crate::mail::archive::ArchiveManager>,
}

impl MailRuntime {
    pub(crate) fn new(profile: &Path) -> Self {
        Self {
            // MailDatabase creates the selected account directory when it opens storage.
            cache_root: profile.join("mail-cache"),
            databases: Mutex::new(HashMap::new()),
            mutation_gates: Mutex::new(HashMap::new()),
            pop3_owner_gates: Mutex::new(HashMap::new()),
            migrated: crate::plugin::migration_mail::profile_committed(profile),
            #[cfg(any(test, feature = "legacy-mail-imap"))]
            mail_imap_pool: Arc::new(crate::mail::MailImapPool::new()),
            mail_archive: Arc::default(),
        }
    }

    pub(crate) fn mutation_gate(&self, account_id: &str) -> Arc<Mutex<()>> {
        self.mutation_gates
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(account_id.to_owned())
            .or_default()
            .clone()
    }

    pub(crate) fn pop3_owner_gate(&self, account_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.pop3_owner_gates
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(account_id.to_owned())
            .or_default()
            .clone()
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
