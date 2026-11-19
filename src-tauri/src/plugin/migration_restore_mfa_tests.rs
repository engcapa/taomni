//! Restore a modular MFA backup to a profile with no old database or module.
use taomni_plugin_api::services::SnapshotJobId;

use super::*;
use crate::{
    ai::config::AiConfig,
    backup::{
        engine::StagedFile,
        pack_staged_archive_with_plugins,
        plugins::contracts::{PluginDataFile, PluginDataFileKind, PluginDataSet},
        restore::stage_restore_to_dir,
        snapshot_context::SnapshotContext,
    },
    mfa::backend,
    plugin::LifecycleState,
    runtime::bootstrap::isolated_state,
};

pub(super) fn exercise_modular_restore() {
    let legacy = Legacy::new();
    let source = legacy.root.path();
    let package = InstalledMfa::verified_package();
    commit(legacy.prepare(), &package, MASTER).unwrap();
    let archive = source.join("modular-mfa.taobak");
    let vault = "databases/vault.db";
    pack_staged_archive_with_plugins(
        &[
            StagedFile {
                archive_path: TARGET.into(),
                disk_path: source.join(TARGET),
            },
            StagedFile {
                archive_path: vault.into(),
                disk_path: source.join("vault.db"),
            },
        ],
        env!("CARGO_PKG_VERSION"),
        "core",
        None,
        &archive,
        None,
        vec![PluginDataSet {
            slug: OWNER.into(),
            data_schema_version: package.manifest().data_schema_version,
            requires_vault: true,
            job: SnapshotJobId::parse(uuid::Uuid::new_v4().to_string()).unwrap(),
            profile_generation: generation::current(source).unwrap(),
            files: vec![PluginDataFile {
                path: "mfa.db".into(),
                kind: PluginDataFileKind::Sqlite,
            }],
        }],
        &SnapshotContext::default(),
    )
    .unwrap();

    let destination = tempfile::tempdir().unwrap();
    let profile_root = ProfileRoot::prepare(destination.path()).unwrap();
    let profile = profile_root.path();
    stage_restore_to_dir(profile, &archive, None).unwrap();
    assert!(!profile.join(TARGET).exists());
    let state = isolated_state(profile, AiConfig::default()).unwrap();
    assert_eq!(
        fs::read(profile.join(TARGET)).unwrap(),
        fs::read(source.join(TARGET)).unwrap()
    );
    assert!(!profile.join("plugins/mfa/active.json").exists());
    let retained = state.plugins.get(OWNER).unwrap();
    assert_eq!(retained.state, LifecycleState::Uninstalled);
    assert!(retained.data_retained && retained.reason.is_none());
    let codes = || {
        tauri::async_runtime::block_on(backend::run::<Vec<mfa::models::MfaCode>, _>(
            &state,
            "mfa_codes",
            OperationKind::ReadData,
            (),
            |_| json!({}),
            |_, _, ()| panic!("The restored backup must use the module data store"),
        ))
    };
    assert_eq!(codes().unwrap_err(), "plugin mfa is not installed");
    state.plugins.install_verified(&package).unwrap();
    state.plugins.set_enabled(OWNER, true).unwrap();
    state
        .plugins
        .unlock_vault(&state.core.vault, MASTER)
        .unwrap();
    let restored = codes().unwrap();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].id, legacy.account_id);
    assert_eq!(restored[0].code, "755224");
    let next = tauri::async_runtime::block_on(backend::run::<mfa::models::MfaCode, _>(
        &state,
        "mfa_hotp_next",
        OperationKind::WriteData,
        legacy.account_id,
        |id| json!({"id": id}),
        |_, _, _| panic!("The signed host must commit the new HOTP counter"),
    ))
    .unwrap();
    assert_eq!(next.code, "287082");
    assert!(!profile.join(JOURNAL).exists());
    assert!(!profile.join("mfa.db").exists());
    state.plugins.shutdown().unwrap();
}
