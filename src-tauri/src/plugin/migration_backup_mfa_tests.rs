//! Round-trip the signed MFA data owner through the production backup barrier.
use std::path::Path;

use super::{InstalledMfa, Legacy, MASTER, OWNER, TARGET, commit, generation};
use crate::{
    ai::config::AiConfig,
    backup::{
        BackupCustomOptions, pack_staged_archive_with_plugins,
        plugins::contracts::{MODULAR_FORMAT_VERSION, PluginDataFile, PluginDataFileKind},
        range::resolve_scope_flags,
        restore::{RESTORE_INTENT_FILE, stage_restore_to_dir},
        snapshot_context::SnapshotContext,
        stage_protected_backup,
    },
    mfa::backend,
    plugin::{LifecycleState, verify::VerifiedPackage},
    runtime::bootstrap::isolated_state,
    state::AppState,
};
use serde_json::json;
use taomni_mfa_engine::models::MfaCode;
use taomni_plugin_services::OperationKind;

const CHANGED_PASSWORD: &str = "qa rotated MFA backup master";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum MfaState {
    Running,
    Disabled,
    Uninstalled,
}

pub(super) fn exercise_round_trip(lifecycle: MfaState) {
    let legacy = Legacy::new();
    let profile = legacy.root.path();
    let account = &legacy.account_id;
    let package = InstalledMfa::verified_package();
    commit(legacy.prepare(), &package, MASTER).unwrap();
    let state = isolated_state(profile, AiConfig::default()).unwrap();
    unlock(&state, MASTER);
    state.plugins.set_enabled(OWNER, true).unwrap();
    expect_code(&state, account, "755224", 0);
    advance(&state, account, "287082", 1);
    deactivate(&state, lifecycle);
    if lifecycle != MfaState::Running {
        state.plugins.lock_vault(&state.core.vault).unwrap();
    }

    let workspace = tempfile::tempdir().unwrap();
    let archive = workspace.path().join("mfa-data.taobak");
    // macOS exposes `/var` as a symlink to `/private/var`. The SQLite
    // no-follow check must receive the canonical staging root, otherwise a
    // valid snapshot is rejected before it can be inspected.
    let staging = workspace.path().canonicalize().unwrap();
    snapshot(&state, &staging, &archive, &package, lifecycle);

    if lifecycle != MfaState::Running {
        unlock(&state, MASTER);
        activate(&state, &package, lifecycle);
    }
    expect_code(&state, account, "287082", 1);
    advance(&state, account, "359152", 2);
    state
        .plugins
        .change_vault_master(&state.core.vault, MASTER, CHANGED_PASSWORD)
        .unwrap();
    deactivate(&state, lifecycle);
    let pointer = profile.join("plugins/mfa/active.json");
    let pointer_bytes = std::fs::read(&pointer).unwrap();
    let before_restore = generation::current(profile).unwrap();
    state
        .plugins
        .verify_restore_password(&state.core.vault, Some(CHANGED_PASSWORD))
        .unwrap();
    let staged = stage_restore_to_dir(profile, &archive, None).unwrap();
    assert!(staged.restart_required);
    assert_eq!(generation::current(profile).unwrap(), before_restore);
    state.plugins.shutdown().unwrap();
    drop(state);

    let restored = isolated_state(profile, AiConfig::default()).unwrap();
    assert!(!profile.join(RESTORE_INTENT_FILE).exists());
    assert_ne!(generation::current(profile).unwrap(), before_restore);
    assert_eq!(std::fs::read(pointer).unwrap(), pointer_bytes);
    assert_lifecycle(&restored, lifecycle);
    assert_eq!(
        restored
            .plugins
            .unlock_vault(&restored.core.vault, CHANGED_PASSWORD)
            .unwrap_err(),
        "VAULT_BAD_PASSWORD"
    );
    unlock(&restored, MASTER);
    match lifecycle {
        MfaState::Running => {}
        MfaState::Disabled => assert_eq!(codes(&restored).unwrap_err(), "plugin mfa is disabled"),
        MfaState::Uninstalled => {
            assert!(!profile.join("plugins/mfa/versions").exists());
            assert_eq!(codes(&restored).unwrap_err(), "plugin mfa is not installed");
        }
    }
    activate(&restored, &package, lifecycle);
    expect_code(&restored, account, "287082", 1);
    advance(&restored, account, "359152", 2);
    assert_eq!(
        std::fs::read(profile.join("mfa.db")).unwrap(),
        legacy.source_bytes[0]
    );
    assert_eq!(
        std::fs::read(profile.join("lanchat.sqlite")).unwrap(),
        legacy.source_bytes[2]
    );
    restored.plugins.shutdown().unwrap();
}

fn snapshot(
    state: &AppState,
    staging: &Path,
    archive: &Path,
    package: &VerifiedPackage,
    lifecycle: MfaState,
) {
    assert_lifecycle(state, lifecycle);
    assert_eq!(
        state.plugins.owns_snapshot_host(OWNER).unwrap(),
        lifecycle == MfaState::Running
    );
    let context = SnapshotContext::default();
    let options = BackupCustomOptions {
        include_mfa: true,
        ..Default::default()
    };
    let snapshot = stage_protected_backup(
        &state.plugins,
        &state.core.vault,
        state.legacy.mfa.legacy_store().unwrap(),
        staging,
        resolve_scope_flags("custom", Some(options)),
        &context,
    )
    .unwrap();
    let (manifest, _) = pack_staged_archive_with_plugins(
        &snapshot.files,
        env!("CARGO_PKG_VERSION"),
        "custom",
        None,
        archive,
        None,
        snapshot.datasets,
        &context,
    )
    .unwrap();
    assert_eq!(manifest.format_version, MODULAR_FORMAT_VERSION);
    let mut paths = manifest
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<Vec<_>>();
    paths.sort_unstable();
    assert_eq!(paths, ["databases/vault.db", TARGET]);
    assert_eq!(manifest.plugin_datasets.len(), 1);
    let dataset = &manifest.plugin_datasets[0];
    assert_eq!(dataset.slug, OWNER);
    assert!(dataset.requires_vault);
    assert_eq!(
        dataset.data_schema_version,
        package.manifest().data_schema_version
    );
    assert_eq!(
        dataset.files,
        [PluginDataFile {
            path: "mfa.db".into(),
            kind: PluginDataFileKind::Sqlite
        }]
    );
    assert_lifecycle(state, lifecycle);
    assert_eq!(
        state.plugins.owns_snapshot_host(OWNER).unwrap(),
        lifecycle == MfaState::Running
    );
}

fn assert_lifecycle(state: &AppState, lifecycle: MfaState) {
    let expected = match lifecycle {
        MfaState::Running => LifecycleState::Enabled,
        MfaState::Disabled => LifecycleState::Disabled,
        MfaState::Uninstalled => LifecycleState::Uninstalled,
    };
    let record = state.plugins.get(OWNER).unwrap();
    assert_eq!(record.state, expected);
    assert!(record.data_retained);
    assert!(state.legacy.mfa.legacy_store().unwrap().is_none());
}

fn activate(state: &AppState, package: &VerifiedPackage, prior: MfaState) {
    if prior == MfaState::Uninstalled {
        state.plugins.install_verified(package).unwrap();
    }
    if prior != MfaState::Running {
        state.plugins.set_enabled(OWNER, true).unwrap();
    }
}

fn deactivate(state: &AppState, lifecycle: MfaState) {
    match lifecycle {
        MfaState::Running => {}
        MfaState::Disabled => {
            state.plugins.set_enabled(OWNER, false).unwrap();
        }
        MfaState::Uninstalled => {
            state.plugins.uninstall(OWNER, false).unwrap();
        }
    }
}

fn unlock(state: &AppState, password: &str) {
    state
        .plugins
        .unlock_vault(&state.core.vault, password)
        .unwrap();
}

fn codes(state: &AppState) -> Result<Vec<MfaCode>, String> {
    tauri::async_runtime::block_on(backend::run(
        state,
        "mfa_codes",
        OperationKind::ReadData,
        (),
        |_| json!({}),
        |_, _, ()| panic!("The signed host owns the migrated data"),
    ))
}

fn expect_code(state: &AppState, id: &str, code: &str, counter: u64) {
    let codes = codes(state).unwrap();
    assert_eq!(codes.len(), 1);
    assert_eq!(codes[0].id, id);
    assert_eq!(codes[0].code, code);
    assert_eq!(codes[0].counter, counter);
}

fn advance(state: &AppState, id: &str, code: &str, counter: u64) {
    let updated: MfaCode = tauri::async_runtime::block_on(backend::run(
        state,
        "mfa_hotp_next",
        OperationKind::WriteData,
        id.to_owned(),
        |id| json!({"id": id}),
        |_, _, _| panic!("The signed host owns the migrated data"),
    ))
    .unwrap();
    assert_eq!(updated.id, id);
    assert_eq!(updated.code, code);
    assert_eq!(updated.counter, counter);
}
