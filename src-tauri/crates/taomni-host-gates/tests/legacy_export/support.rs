use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::{Connection, OpenFlags};
use taomni_mfa_engine::{
    self as engine, crypto::DataKey, keys::KeyProvider, models::MfaAccountInput,
};
use taomni_profile_locks::ProfileRoot;
use taomni_sqlite_snapshot::{SnapshotControl, SnapshotObserver, SnapshotPhase, SnapshotProgress};
use zeroize::Zeroizing;

use super::migration::{LegacyInstallSnapshot, inspect_legacy_install};

pub struct Fixture {
    pub mfa: Connection,
    pub vault: Connection,
    pub root: ProfileRoot,
    _directory: tempfile::TempDir,
}

pub struct KnownKey;
impl KeyProvider for KnownKey {
    fn load(&self) -> Result<Option<DataKey>, String> {
        Ok(Some(key()))
    }
    fn initialize_empty(&self) -> Result<DataKey, String> {
        panic!("an exporter must not create a key")
    }
    fn repair_after_reset(&self) -> Result<DataKey, String> {
        panic!("an exporter must not repair a key")
    }
}

pub fn key() -> DataKey {
    Zeroizing::new([37; 32])
}

impl Fixture {
    pub fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(directory.path()).unwrap();
        let mut mfa = Connection::open(root.path().join("mfa.db")).unwrap();
        mfa.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        engine::store::init_db(&mfa).unwrap();
        engine::keys::prepare_key(&mfa, &KnownKey).unwrap();
        mfa.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        engine::operations::add(
            &mut mfa,
            &key(),
            &[MfaAccountInput {
                issuer: "legacy-export-fixture".into(),
                account_name: "fixture@example.com".into(),
                secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into(),
                kind: "hotp".into(),
                algorithm: "SHA1".into(),
                digits: 6,
                period: 30,
                counter: 0,
                group: "before-upgrade".into(),
                note: "original metadata".into(),
            }],
            false,
        )
        .unwrap();
        engine::store::meta_set(&mfa, "legacy-export-marker", b"original-meta").unwrap();
        mfa.execute("INSERT INTO mfa_prefs VALUES ('sort_mode', 'issuer')", [])
            .unwrap();
        let vault = Connection::open(root.path().join("vault.db")).unwrap();
        vault
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
             CREATE TABLE vault_entries (id TEXT PRIMARY KEY, ciphertext BLOB);
             PRAGMA wal_checkpoint(TRUNCATE);
             INSERT INTO vault_entries VALUES ('mfa.data-key-v1', X'01020304');",
            )
            .unwrap();
        fs::write(root.path().join("lanchat.sqlite"), b"retained-chat-bytes").unwrap();
        Self {
            mfa,
            vault,
            root,
            _directory: directory,
        }
    }

    pub fn snapshot(&self) -> LegacyInstallSnapshot {
        inspect_legacy_install(self.root.path(), "0.5.9").unwrap()
    }

    pub fn assert_no_staging(&self) {
        let exports = self.root.path().join("migration/exports");
        assert!(!exports.exists() || fs::read_dir(exports).unwrap().next().is_none());
    }

    pub fn bytes(&self) -> Vec<(PathBuf, Vec<u8>)> {
        [
            "mfa.db",
            "mfa.db-wal",
            "vault.db",
            "vault.db-wal",
            "lanchat.sqlite",
        ]
        .into_iter()
        .map(|relative| {
            let path = self.root.path().join(relative);
            let bytes = fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect()
    }
}

pub fn unchanged(files: &[(PathBuf, Vec<u8>)]) {
    for (path, bytes) in files {
        assert_eq!(
            &fs::read(path).unwrap(),
            bytes,
            "changed {}",
            path.display()
        );
    }
}

pub fn control() -> SnapshotControl {
    SnapshotControl::with_timeout(Duration::from_secs(10))
}

pub fn readonly(path: &Path) -> Connection {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

/// Invokes a mutation at a real snapshot progress boundary; no fixed sleep.
pub struct OnceAt {
    phase: SnapshotPhase,
    hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
impl OnceAt {
    pub fn control(phase: SnapshotPhase, hook: impl FnOnce() + Send + 'static) -> SnapshotControl {
        SnapshotControl::new(
            std::time::Instant::now() + Duration::from_secs(10),
            Arc::new(Self {
                phase,
                hook: Mutex::new(Some(Box::new(hook))),
            }),
        )
    }
}
impl SnapshotObserver for OnceAt {
    fn progress(&self, progress: SnapshotProgress) {
        if progress.phase == self.phase
            && let Some(hook) = self.hook.lock().unwrap().take()
        {
            hook();
        }
    }
}

pub fn evidence(name: &str, value: &impl serde::Serialize) {
    let directory = PathBuf::from(
        std::env::var_os("TAOMNI_GATE_EVIDENCE_DIR")
            .expect("GitHub export gate must retain its actual receipts"),
    );
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join(format!("{name}.json")),
        serde_json::to_vec_pretty(value).unwrap(),
    )
    .unwrap();
}
