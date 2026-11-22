use super::*;

fn snapshot() -> LegacyInstallSnapshot {
    LegacyInstallSnapshot {
        from_version: "0.5.9".into(),
        database_path: None,
        database_tables: vec![],
        candidates: vec![
            MigrationCandidate {
                item: MigrationItem::Mfa,
                evidence: vec!["mfa.db".into()],
                plugin_slug: "mfa".into(),
            },
            MigrationCandidate {
                item: MigrationItem::VncSessions,
                evidence: vec!["taomni.db".into()],
                plugin_slug: "vnc-client".into(),
            },
        ],
        source_fingerprints: [
            (
                "mfa.db".into(),
                format!("sha256:{}:bytes:20", "b".repeat(64)),
            ),
            (
                "taomni.db".into(),
                format!("sha256:{}:bytes:30", "c".repeat(64)),
            ),
        ]
        .into_iter()
        .collect(),
        retained_paths: vec![],
        vault: None,
    }
}

fn committed() -> MigrationJournal {
    let mut journal = MigrationJournal::default();
    journal.mark_with_source(
        MigrationItem::Mfa,
        MigrationStepState::Committed,
        format!("sha256:{}:bytes:10", "a".repeat(64)),
        "mfa.db".into(),
        MFA_MIGRATION_TARGET.into(),
    );
    journal
}

#[test]
fn refreshing_candidates_keeps_original_mfa_commit_and_returns_only_remaining_items() {
    let mut journal = committed();
    let original = journal.entries[0].clone();
    let mut scan = snapshot();
    for _ in 0..2 {
        let result = reconcile_pending(&mut journal, &scan, &[]).unwrap();
        assert_eq!(result.status, MigrationRunState::Pending);
        assert_eq!(result.committed, [MigrationItem::Mfa]);
        assert_eq!(result.pending, [MigrationItem::VncSessions]);
        assert_eq!(journal.entries[0], original);
        assert_eq!(
            journal.entries[1].source_fingerprint,
            scan.source_fingerprints["taomni.db"]
        );
    }
    scan.candidates.truncate(1);
    let result = reconcile_pending(&mut journal, &scan, &[]).unwrap();
    assert_eq!(result.status, MigrationRunState::Complete);
    assert!(result.pending.is_empty() && result.pending_reason.is_none());
    assert_eq!(journal.entries, [original]);
}

#[test]
fn an_unrecognized_target_or_duplicate_commit_requires_recovery_without_rewriting_history() {
    for duplicate in [false, true] {
        let mut journal = committed();
        if duplicate {
            journal.entries.push(journal.entries[0].clone());
        } else {
            journal.entries[0].target = "plugins/mfa/versions/0.1.0/mfa.db".into();
        }
        let original = journal.entries.clone();
        assert!(
            reconcile_pending(&mut journal, &snapshot(), &[])
                .unwrap_err()
                .contains("explicit recovery")
        );
        assert_eq!(journal.entries, original);
    }
}

#[test]
fn keeps_existing_vnc_sessions_in_the_core_database_when_the_viewer_is_available() {
    let mut journal = MigrationJournal::default();
    let mut scan = snapshot();
    assert_eq!(
        reconcile_pending(&mut journal, &scan, &[]).unwrap().pending,
        [MigrationItem::Mfa, MigrationItem::VncSessions]
    );
    let result = reconcile_pending(&mut journal, &scan, &[MigrationItem::VncSessions]).unwrap();
    assert_eq!(result.status, MigrationRunState::Pending);
    assert_eq!(result.pending, [MigrationItem::Mfa]);
    assert_eq!(result.committed, [MigrationItem::VncSessions]);
    assert!(journal.has_valid_commit(MigrationItem::VncSessions));
    let retained = journal
        .entries
        .iter()
        .find(|entry| entry.item == MigrationItem::VncSessions)
        .unwrap()
        .clone();
    assert_eq!(retained.target, Path::new("taomni.db"));

    scan.source_fingerprints.insert(
        "taomni.db".into(),
        format!("sha256:{}:bytes:31", "d".repeat(64)),
    );
    scan.candidates
        .retain(|entry| entry.item != MigrationItem::Mfa);
    assert_eq!(
        reconcile_pending(&mut journal, &scan, &[]).unwrap().status,
        MigrationRunState::Complete
    );
    assert_eq!(journal.entries, [retained]);
}

#[test]
fn only_the_verified_client_retires_its_sessions_and_mobile_keeps_its_core_policy() {
    let profile = tempfile::tempdir().unwrap();
    let policy = profile.path().join("mobile-desktop-remote.json");
    let original = br#"{ "allow_screen_capture": true }"#;
    fs::write(&policy, original).unwrap();
    let mobile = MigrationCandidate {
        item: MigrationItem::Mobile,
        evidence: vec!["mobile-desktop-remote.json".into()],
        plugin_slug: "mobile".into(),
    };
    let scan = inspect_legacy_install(profile.path(), "0.5.x").unwrap();
    assert!(scan.candidates.is_empty() && scan.source_fingerprints.is_empty());
    assert!(
        build_file_migration_specs(profile.path(), &[mobile])
            .unwrap()
            .is_empty()
    );
    let mut journal = MigrationJournal::default();
    journal.mark_with_source(
        MigrationItem::Mobile,
        MigrationStepState::Pending,
        format!("sha256:{}:bytes:31", "c".repeat(64)),
        policy.file_name().unwrap().into(),
        PathBuf::new(),
    );
    let mut scan = snapshot();
    scan.candidates
        .retain(|candidate| candidate.item == MigrationItem::VncSessions);
    scan.candidates.push(MigrationCandidate {
        item: MigrationItem::RdpVncSessions,
        evidence: vec!["taomni.db".into()],
        plugin_slug: "rdp-client".into(),
    });
    let result = reconcile_pending(&mut journal, &scan, &[MigrationItem::RdpVncSessions]).unwrap();
    assert_eq!(result.pending, [MigrationItem::VncSessions]);
    assert_eq!(result.committed, [MigrationItem::RdpVncSessions]);
    assert_eq!(journal.entries.len(), 2);
    assert!(journal.has_valid_commit(MigrationItem::RdpVncSessions));
    assert!(!journal.has_valid_commit(MigrationItem::VncSessions));
    let second = reconcile_pending(&mut journal, &scan, &[MigrationItem::VncSessions]).unwrap();
    assert_eq!(second.status, MigrationRunState::Complete);
    assert_eq!(fs::read(policy).unwrap(), original);
    assert!(!profile.path().join("plugins/mobile").exists());
}
