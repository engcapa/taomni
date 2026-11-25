use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use rusqlite::Connection;
use serde_json::json;
use taomni_mfa_engine::{
    self as engine, crypto::DataKey, keys::KeyProvider, models::MfaAccountInput,
};
use taomni_profile_locks::ProfileRoot;
use taomni_sqlite_snapshot::{SnapshotControl, SnapshotObserver};
use zeroize::Zeroizing;

use super::{
    plugin::migration::{LegacyInstallSnapshot, inspect_legacy_install},
    vault,
};

pub const MASTER: &str = " legacy-mfa-readonly-master ";
pub const MFA_KEY: [u8; 32] = [37; 32];
pub const KEY_ID: &str = taomni_plugin_api::services::MFA_DATA_KEY_ID;

pub struct KnownKey;
impl KeyProvider for KnownKey {
    fn load(&self) -> Result<Option<DataKey>, String> {
        Ok(Some(Zeroizing::new(MFA_KEY)))
    }
    fn initialize_empty(&self) -> Result<DataKey, String> {
        panic!("no initialization during verification")
    }
    fn repair_after_reset(&self) -> Result<DataKey, String> {
        panic!("no key repair during verification")
    }
}

pub struct Fixture {
    pub root: ProfileRoot,
    pub mfa: Connection,
    pub vault: Connection,
    pub _directory: tempfile::TempDir,
}

impl Fixture {
    pub fn new(bound: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(directory.path()).unwrap();
        let mut mfa = Connection::open(root.path().join("mfa.db")).unwrap();
        mfa.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        engine::store::init_db(&mfa).unwrap();
        if bound {
            engine::keys::prepare_key(&mfa, &KnownKey).unwrap();
        }
        mfa.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        engine::operations::add(
            &mut mfa,
            &Zeroizing::new(MFA_KEY),
            &[MfaAccountInput {
                issuer: "legacy-real-vault".into(),
                account_name: "qa@example.com".into(),
                secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into(),
                kind: "hotp".into(),
                algorithm: "SHA1".into(),
                digits: 6,
                period: 30,
                counter: 0,
                group: "original-group".into(),
                note: "original-note".into(),
            }],
            false,
        )
        .unwrap();
        let vault = Connection::open(root.path().join("vault.db")).unwrap();
        vault
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        vault::db::init(&vault).unwrap();
        let salt = vault::crypto::random_salt();
        let key = vault::crypto::derive_root_key(
            MASTER,
            &salt,
            vault::crypto::ARGON2_M_COST,
            vault::crypto::ARGON2_T_COST,
            vault::crypto::ARGON2_P_COST,
        )
        .unwrap();
        let nonce = vault::crypto::random_nonce();
        let verifier =
            vault::crypto::aead_encrypt(&key, &nonce, vault::crypto::VERIFIER_PLAINTEXT).unwrap();
        let params = json!({"m_cost": vault::crypto::ARGON2_M_COST, "t_cost": vault::crypto::ARGON2_T_COST, "p_cost": vault::crypto::ARGON2_P_COST});
        vault::db::put_meta(
            &vault,
            "argon2id",
            &salt,
            &params.to_string(),
            &verifier,
            &nonce,
            123,
        )
        .unwrap();
        vault
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        let nonce = vault::crypto::random_nonce();
        let encoded = Zeroizing::new(STANDARD.encode(MFA_KEY));
        let ciphertext = vault::crypto::aead_encrypt(&key, &nonce, encoded.as_bytes()).unwrap();
        vault::db::insert_entry(
            &vault,
            KEY_ID,
            "MFA Data Key",
            "mfa_secret",
            &ciphertext,
            &nonce,
            456,
        )
        .unwrap();
        // Non-MFA entries must not be opened by this service.
        vault::db::insert_entry(
            &vault,
            "unrelated-secret",
            "other",
            "password",
            &[0x01],
            &[0x01],
            789,
        )
        .unwrap();
        fs::write(root.path().join("lanchat.sqlite"), b"untouched-legacy-chat").unwrap();
        Self {
            root,
            mfa,
            vault,
            _directory: directory,
        }
    }

    pub fn snapshot(&self) -> LegacyInstallSnapshot {
        inspect_legacy_install(self.root.path(), "0.5.9").unwrap()
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
        .map(|relative| self.root.path().join(relative))
        .map(|path| {
            let bytes = fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect()
    }

    pub fn assert_no_staging(&self) {
        let exports = self.root.path().join("migration/exports");
        assert!(!exports.exists() || fs::read_dir(exports).unwrap().next().is_none());
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
    SnapshotControl::with_timeout(Duration::from_secs(20))
}

#[derive(Default)]
pub struct Cancel(pub AtomicBool);
impl SnapshotObserver for Cancel {
    fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}
impl Cancel {
    pub fn control(self: &Arc<Self>) -> SnapshotControl {
        SnapshotControl::new(Instant::now() + Duration::from_secs(20), self.clone())
    }
}

pub fn evidence(name: &str, value: serde_json::Value) {
    let directory = PathBuf::from(
        std::env::var_os("TAOMNI_GATE_EVIDENCE_DIR").expect("hosted evidence directory required"),
    );
    assert!(directory.is_absolute());
    fs::write(
        directory.join(format!("{name}.json")),
        serde_json::to_vec_pretty(&value).unwrap(),
    )
    .unwrap();
}
