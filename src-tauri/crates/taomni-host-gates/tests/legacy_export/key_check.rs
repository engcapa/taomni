//! Native file postconditions for the production engine's read-only verifier.
use std::fs;

use serde_json::json;
use taomni_mfa_engine::{
    self as engine,
    crypto::DataKey,
    keys::{ExistingKeyCheck, KeyProvider},
};
use zeroize::Zeroizing;

use super::{migration::export::PreparedMfaExport, support::*};

struct LoadOnly(Option<[u8; 32]>);
impl KeyProvider for LoadOnly {
    fn load(&self) -> Result<Option<DataKey>, String> {
        Ok(self.0.map(Zeroizing::new))
    }
    fn initialize_empty(&self) -> Result<DataKey, String> {
        panic!("Read-only key verification must not initialize")
    }
    fn repair_after_reset(&self) -> Result<DataKey, String> {
        panic!("Read-only key verification must not repair")
    }
}

#[test]
#[ignore = "real read-only SQLite, encrypted files and leases run only on GitHub"]
fn key_verification_keeps_bound_and_unbound_exports_identical_on_success_failure_and_cancel() {
    for bound in [false, true] {
        let fixture = Fixture::new();
        if !bound {
            fixture
                .mfa
                .execute("DELETE FROM mfa_meta WHERE key='key_check'", [])
                .unwrap();
        }
        let snapshot = fixture.snapshot();
        let sources_before = fixture.bytes();
        let prepared = PreparedMfaExport::prepare(&fixture.root, &snapshot, &control()).unwrap();
        let path = prepared.database_path().unwrap();
        let before = fs::read(&path).unwrap();
        let exported = readonly(&path);
        assert!(exported.is_readonly("main").unwrap());
        assert_eq!(
            engine::keys::verify_existing_key(&exported, &KnownKey, &|| Ok(())).unwrap(),
            ExistingKeyCheck::Verified {
                accounts: 1,
                key_check_present: bound,
            }
        );
        for (value, error) in [
            (None, engine::ERR_KEY_MISSING),
            (Some([0x99; 32]), engine::ERR_KEY_MISMATCH),
        ] {
            assert_eq!(
                engine::keys::verify_existing_key(&exported, &LoadOnly(value), &|| Ok(()))
                    .unwrap_err(),
                error
            );
            assert_eq!(fs::read(&path).unwrap(), before);
            prepared.verify().unwrap();
        }
        assert_eq!(
            engine::keys::verify_existing_key(&exported, &KnownKey, &|| {
                Err("BACKUP_CANCELLED".into())
            })
            .unwrap_err(),
            "BACKUP_CANCELLED"
        );
        assert_eq!(
            engine::store::meta_get(&exported, "key_check")
                .unwrap()
                .is_some(),
            bound
        );
        assert_eq!(exported.total_changes(), 0);
        assert_eq!(fs::read(&path).unwrap(), before);
        prepared.verify().unwrap();
        unchanged(&sources_before);
        drop(exported);
        drop(prepared);
        assert!(!path.exists());
        fixture.assert_no_staging();
    }
    evidence(
        "mfa-export-readonly-key-check",
        &json!({
            "bound_and_unbound": true,
            "real_readonly_connection": true,
            "all_ciphertexts_verified": true,
            "missing_and_wrong_keys_rejected": true,
            "cancellation_propagated": true,
            "snapshot_bytes_and_receipt_unchanged": true,
            "sources_unchanged": true,
            "cleanup_complete": true,
        }),
    );
}
