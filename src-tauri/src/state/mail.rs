use super::{AppState, MailDbHandle};
use crate::plugin::{LifecycleState, PluginRegistry, data_contract::PluginDataRoot};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use taomni_mail_api::{IMAP_MAILBOX_OWNER, SLUG};
pub(crate) use taomni_mail_engine::database::mail_db_file_stem;
use taomni_mail_engine::{database::MailDatabase, imap_ownership};

pub(crate) struct MailRuntime {
    // Each account's database is separate from taomni.db and other accounts.
    cache_root: PathBuf,
    databases: Mutex<HashMap<(String, bool), MailDbHandle>>,
    route_gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
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
            route_gates: Mutex::new(HashMap::new()),
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

    pub(crate) fn route_gate(&self, account_id: &str) -> Arc<Mutex<()>> {
        self.route_gates
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(account_id.to_owned())
            .or_default()
            .clone()
    }

    pub(crate) fn uses_legacy_handle(&self, account_id: &str) -> Result<bool, String> {
        let key = (mail_db_file_stem(account_id), false);
        Ok(self
            .databases
            .lock()
            .map_err(|error| error.to_string())?
            .contains_key(&key))
    }

    pub(crate) fn database(
        &self,
        registry: &PluginRegistry,
        account_id: &str,
        load_options: impl FnOnce() -> Result<Option<String>, String>,
    ) -> Result<MailDbHandle, String> {
        let routing = self.route_gate(account_id);
        let _route = routing.lock().map_err(|error| error.to_string())?;
        let stem = mail_db_file_stem(account_id);
        let owned = owned_database(registry.root(), account_id)?;
        if owned.is_some() {
            require_owner_support(registry)?;
        }
        let key = (stem.clone(), owned.is_some());
        let mut dbs = self.databases.lock().map_err(|e| e.to_string())?;
        if let Some(db) = dbs.get(&key) {
            return Ok(Arc::clone(db));
        }

        let handle = Arc::new(match owned {
            Some(path) => MailDatabase::new_owned(path),
            None => {
                let configured = load_options()?
                    .map(|options| {
                        crate::mail::storage::configured_directory(&options, &self.cache_root)
                    })
                    .transpose()?
                    .unwrap_or_else(|| self.cache_root.clone());
                crate::mail::coordination::mailbox_database(configured.join(format!("{stem}.db")))
            }
        });
        dbs.insert(key, Arc::clone(&handle));
        Ok(handle)
    }
}

fn owned_database(plugins: &Path, account: &str) -> Result<Option<PathBuf>, String> {
    match std::fs::symlink_metadata(plugins) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(_) => (),
    }
    let data = PluginDataRoot::open(plugins, SLUG).map_err(|error| error.to_string())?;
    imap_ownership::database(&data.data, account).map_err(|error| error.to_string())
}

fn require_owner_support(registry: &PluginRegistry) -> Result<(), String> {
    let active = registry
        .get(SLUG)
        .filter(|entry| entry.state == LifecycleState::Enabled)
        .ok_or("Enable the Mail module to open this IMAP mailbox")?;
    if !active.manifest.commands.contains(IMAP_MAILBOX_OWNER) {
        return Err("Update the Mail module in Module Store to open this IMAP mailbox".into());
    }
    Ok(())
}

impl AppState {
    pub fn mail_cache_root(&self) -> &Path {
        &self.legacy.mail.cache_root
    }

    pub(crate) fn has_owned_imap_mailbox(&self, account_id: &str) -> Result<bool, String> {
        Ok(owned_database(self.plugins.root(), account_id)?.is_some())
    }

    pub fn mail_db(&self, account_id: &str) -> Result<MailDbHandle, String> {
        self.legacy.mail.database(&self.plugins, account_id, || {
            let db = self.core.db.lock().map_err(|error| error.to_string())?;
            Ok(crate::session::db::get_session(&db, account_id)
                .ok()
                .map(|session| session.options_json))
        })
    }
}
