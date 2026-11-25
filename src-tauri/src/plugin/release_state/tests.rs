use super::*;
use crate::plugin::{InstallIntent, PluginRegistry, install::ActivePointer, verify::test_support};
use tempfile::tempdir;

const PLATFORM: &str = "linux-x86_64";

fn catalog(sequence: u64, slugs: &[(&str, &str)]) -> ModuleCatalog {
    let plugins = slugs.iter().map(|(slug, platform)| {
        let id = format!("taomni-plugin-{slug}");
        (id.clone(), serde_json::json!({
            "id": id, "slug": slug, "name": slug, "version": "1.1.0",
            "description": format!("Use {slug}"), "coreApiVersion": "1",
            "platforms": { (*platform): { "url": "https://example.test/module", "signature": "signature", "sha256": "a".repeat(64), "size": 23 } },
        }))
    }).collect::<serde_json::Map<_, _>>();
    serde_json::from_value(serde_json::json!({
        "coreApiVersion": "1", "sequence": sequence, "updatedAt": "2026-11-18", "plugins": plugins,
    }))
    .unwrap()
}

fn id(slug: &str) -> String {
    format!("taomni-plugin-{slug}")
}

fn pointer(root: &Path, slug: &str, active: Option<&str>, previous: Option<&str>) {
    let path = root.join("plugins").join(slug).join("active.json");
    crate::backup::control::write_json(
        &path,
        &ActivePointer {
            active_version: active.map(str::to_owned),
            previous_version: previous.map(str::to_owned),
            ..ActivePointer::default()
        },
    )
    .unwrap();
}

#[test]
fn legacy_enrolls_all_eligible_modules_even_without_relevant_data() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("taomni.db"), b"legacy core database").unwrap();
    initialize(root).unwrap();
    let mut first = catalog(
        1,
        &[
            ("rdp", PLATFORM),
            ("vnc", PLATFORM),
            ("windows-only", "windows-x86_64"),
        ],
    );
    assert!(plan(root, &first, PLATFORM).unwrap().legacy_waiting);
    first.legacy_upgrade = Some(BTreeSet::from([id("rdp"), id("vnc"), id("windows-only")]));
    let enrolled = plan(root, &first, PLATFORM).unwrap();
    assert!(!enrolled.legacy_waiting);
    assert_eq!(
        enrolled.legacy_pending,
        BTreeSet::from([id("rdp"), id("vnc")])
    );

    // Crash between activating RDP and marking it complete. VNC was installed
    // manually and uninstalled before the next catalog reconciliation.
    pointer(root, "rdp", Some("1.1.0"), None);
    pointer(root, "vnc", None, Some("1.1.0"));
    let restarted = plan(root, &first, PLATFORM).unwrap();
    assert!(restarted.legacy_pending.is_empty());
    pointer(root, "rdp", None, Some("1.1.0"));
    assert!(
        plan(root, &first, PLATFORM)
            .unwrap()
            .legacy_pending
            .is_empty()
    );
}

#[test]
fn legacy_first_check_offers_new_modules_when_skipping_modular_releases() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("taomni.db"), b"legacy core database").unwrap();
    initialize(root).unwrap();
    let mut latest = catalog(
        5,
        &[
            ("mfa", PLATFORM),
            ("new", PLATFORM),
            ("foreign", "windows-x86_64"),
        ],
    );
    let mut waiting = latest.clone();
    waiting.sequence = 4;
    assert!(plan(root, &waiting, PLATFORM).unwrap().legacy_waiting);
    latest.legacy_upgrade = Some(BTreeSet::from([id("mfa")]));
    let release = plan(root, &latest, PLATFORM).unwrap();
    assert_eq!(release.legacy_pending, BTreeSet::from([id("mfa")]));
    assert_eq!(release.new_modules, BTreeSet::from([id("new")]));
    assert!(release.updates.is_empty());
    dismiss(root, &[id("new")]).unwrap();
    assert!(
        plan(root, &latest, PLATFORM)
            .unwrap()
            .new_modules
            .is_empty()
    );
}

#[test]
fn first_start_applies_legacy_restore_without_skipping_the_module_roster() {
    use crate::{
        backup::{
            engine::{StagedFile, pack_staged_archive},
            restore::{RESTORE_INTENT_FILE, stage_restore_to_dir},
        },
        runtime::profile::{ProfileRuntimeLeases, StartupMode},
    };

    let dir = tempdir().unwrap();
    let profile = dir.path().join("profile");
    fs::create_dir(&profile).unwrap();
    let restored = br#"{"version":1,"tunnels":[]}"#;
    let source = dir.path().join("tunnels.json");
    fs::write(&source, restored).unwrap();
    fs::write(profile.join("tunnels.json"), b"old live data").unwrap();
    rusqlite::Connection::open(profile.join(crate::migrate::LEGACY_DB_NAME)).unwrap();
    let archive = dir.path().join("legacy.taobak");
    pack_staged_archive(
        &[StagedFile {
            archive_path: "configs/tunnels.json".into(),
            disk_path: source,
        }],
        "0.5.10",
        "core",
        None,
        &archive,
    )
    .unwrap();
    stage_restore_to_dir(&profile, &archive, None).unwrap();
    assert!(!profile.join(".profile-state.json").exists());

    let _runtime = ProfileRuntimeLeases::acquire(&profile, StartupMode::Desktop).unwrap();
    assert!(!profile.join(RESTORE_INTENT_FILE).exists());
    assert!(profile.join("taomni.db").is_file());
    assert_eq!(fs::read(profile.join("tunnels.json")).unwrap(), restored);

    let mut first = catalog(1, &[("mfa", PLATFORM), ("rdp", PLATFORM)]);
    first.legacy_upgrade = Some(BTreeSet::from([id("mfa"), id("rdp")]));
    assert_eq!(
        plan(&profile, &first, PLATFORM).unwrap().legacy_pending,
        BTreeSet::from([id("mfa"), id("rdp")])
    );
}

#[test]
fn fresh_and_existing_empty_modular_profiles_do_not_enroll() {
    for modular in [false, true] {
        let dir = tempdir().unwrap();
        let root = dir.path();
        if modular {
            fs::write(root.join("taomni.db"), b"modern database").unwrap();
            fs::write(root.join(".profile-state.json"), b"existing modular marker").unwrap();
        }
        initialize(root).unwrap();
        // Simulate the initialization of SQLite after enrolling a fresh profile.
        fs::write(root.join("taomni.db"), b"core database now exists").unwrap();
        let mut first = catalog(1, &[("rdp", PLATFORM)]);
        first.legacy_upgrade = Some(BTreeSet::from([id("rdp")]));
        let release = plan(root, &first, PLATFORM).unwrap();
        assert!(release.legacy_pending.is_empty());
        assert!(!release.legacy_waiting);
        assert!(release.new_modules.is_empty());
    }
}

#[test]
fn later_catalog_uses_active_versions_and_notifies_each_new_id_once() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    initialize(root).unwrap();
    let initial = catalog(
        1,
        &[
            ("active", PLATFORM),
            ("uninstalled", PLATFORM),
            ("older-offer", PLATFORM),
        ],
    );
    plan(root, &initial, PLATFORM).unwrap();
    pointer(root, "active", Some("1.0.0"), None);
    fs::write(root.join("plugins/state.json"), br#"{"active":false}"#).unwrap();
    pointer(root, "uninstalled", None, Some("1.0.0"));
    pointer(root, "older-offer", Some("2.0.0"), None);
    let latest = catalog(
        2,
        &[
            ("active", PLATFORM),
            ("uninstalled", PLATFORM),
            ("older-offer", PLATFORM),
            ("new", PLATFORM),
        ],
    );
    let release = plan(root, &latest, PLATFORM).unwrap();
    assert_eq!(release.updates, BTreeSet::from([id("active")]));
    assert_eq!(release.new_modules, BTreeSet::from([id("new")]));
    assert_eq!(plan(root, &latest, PLATFORM).unwrap(), release);
    dismiss(root, &[id("new")]).unwrap();
    plan(root, &catalog(3, &[]), PLATFORM).unwrap();
    let returns = plan(
        root,
        &catalog(4, &[("new", PLATFORM), ("uninstalled", PLATFORM)]),
        PLATFORM,
    )
    .unwrap();
    assert!(returns.new_modules.is_empty());
    assert!(returns.updates.is_empty());
    assert_eq!(
        fs::read(root.join("plugins/state.json")).unwrap(),
        br#"{"active":false}"#
    );
}

#[test]
fn update_rechecks_the_installed_version_and_preserves_disabled_state() {
    let dir = tempdir().unwrap();
    let registry = PluginRegistry::new(dir.path().join("plugins"));
    let first = test_support::manifest();
    let mut next = first.clone();
    next.version = "2.0.0".into();
    let original = test_support::verified_package(&first);
    let update = test_support::verified_package(&next);
    let installed = registry.install_verified(&original).unwrap();
    registry.set_enabled(&first.slug, false).unwrap();
    let expected = &installed.manifest.version;
    let updated = registry
        .install_with_intent(&update, InstallIntent::Update(expected))
        .unwrap()
        .unwrap();
    assert_eq!(updated.manifest.version, next.version);
    assert_eq!(updated.state, crate::plugin::LifecycleState::Disabled);
    registry.uninstall(&first.slug, false).unwrap();
    assert!(
        registry
            .install_with_intent(&update, InstallIntent::Update(&next.version))
            .is_err()
    );
    assert!(
        registry
            .install_with_intent(&update, InstallIntent::Legacy)
            .unwrap()
            .is_none()
    );
}
