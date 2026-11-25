use super::super::super::{LegacyVaultEvidence, MigrationCandidate};
use super::*;

fn snapshot(database: bool) -> LegacyInstallSnapshot {
    let mut source_fingerprints = BTreeMap::from([
        ("vault.db".into(), "vault-and-wal-fingerprint".into()),
        ("taomni.db".into(), "unrelated-core-fingerprint".into()),
    ]);
    if database {
        source_fingerprints.insert("mfa.db".into(), "mfa-and-wal-fingerprint".into());
    }
    LegacyInstallSnapshot {
        from_version: "0.5.9".into(),
        database_path: None,
        database_tables: Vec::new(),
        candidates: vec![MigrationCandidate {
            item: MigrationItem::Mfa,
            evidence: vec![if database { "mfa.db" } else { "vault.db" }.into()],
            plugin_slug: "mfa".into(),
        }],
        source_fingerprints,
        retained_paths: Vec::new(),
        vault: Some(LegacyVaultEvidence {
            path: "/profile/vault.db".into(),
            fixed_key_present: true,
        }),
    }
}

#[test]
fn encrypted_database_binds_only_its_own_data_and_vault_sources() {
    let sources = MfaSources::from_snapshot(&snapshot(true)).unwrap();
    assert!(sources.has_database());
    assert!(sources.fixed_key_present);
    assert_eq!(sources.fingerprints.len(), 2);
    assert_eq!(sources.fingerprints["mfa.db"], "mfa-and-wal-fingerprint");
    assert_eq!(
        sources.fingerprints["vault.db"],
        "vault-and-wal-fingerprint"
    );
    assert!(!sources.fingerprints.contains_key("taomni.db"));
}

#[test]
fn retained_vault_key_does_not_imply_an_existing_mfa_database() {
    let sources = MfaSources::from_snapshot(&snapshot(false)).unwrap();
    assert!(!sources.has_database());
    assert!(sources.fixed_key_present);
    assert_eq!(sources.fingerprints.len(), 1);
}

#[test]
fn an_existing_database_without_a_vault_never_manufactures_key_evidence() {
    let mut snapshot = snapshot(true);
    snapshot.vault = None;
    snapshot.source_fingerprints.remove("vault.db");
    let sources = MfaSources::from_snapshot(&snapshot).unwrap();
    assert!(sources.has_database());
    assert!(!sources.fixed_key_present);
    assert!(!sources.fingerprints.contains_key("vault.db"));
}

#[test]
fn missing_owner_wrong_owner_duplicate_and_unbound_evidence_are_rejected() {
    for invalid in [
        {
            let mut s = snapshot(true);
            s.candidates.clear();
            s
        },
        {
            let mut s = snapshot(true);
            s.candidates[0].plugin_slug = "hello-plugin".into();
            s
        },
        {
            let mut s = snapshot(true);
            s.candidates.push(s.candidates[0].clone());
            s
        },
        {
            let mut s = snapshot(true);
            s.candidates[0].evidence.clear();
            s
        },
        {
            let mut s = snapshot(true);
            s.candidates[0].evidence = vec!["taomni.db".into()];
            s
        },
    ] {
        assert!(MfaSources::from_snapshot(&invalid).is_err());
    }
}

#[test]
fn partial_vault_metadata_or_key_only_without_its_key_is_rejected() {
    for invalid in [
        {
            let mut s = snapshot(true);
            s.from_version.clear();
            s
        },
        {
            let mut s = snapshot(true);
            s.vault = None;
            s
        },
        {
            let mut s = snapshot(true);
            s.source_fingerprints.remove("vault.db");
            s
        },
        {
            let mut s = snapshot(false);
            s.vault.as_mut().unwrap().fixed_key_present = false;
            s
        },
        {
            let mut s = snapshot(false);
            s.source_fingerprints.remove("vault.db");
            s
        },
    ] {
        assert!(MfaSources::from_snapshot(&invalid).is_err());
    }
}
