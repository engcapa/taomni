use std::{ffi::OsString, io::Write, process::Stdio};

use super::*;
use crate::{ai::config::AiConfig, runtime::bootstrap::isolated_state};

const TEST_ROOT: &str = "TAOMNI_QA_MFA_MAINTENANCE_PROFILE";
const EXIT_MAINTENANCE_ERROR: i32 = 74;

pub(super) fn exercise_maintenance_process() {
    let legacy = Legacy::new();
    let root = legacy.root.path();
    fs::remove_file(root.join(JOURNAL)).unwrap();
    fs::create_dir_all(root.join("plugins")).unwrap();
    fs::write(root.join(REGISTRY_STATE), br#"{"hello":false}"#).unwrap();
    let original_state = fs::read(root.join(REGISTRY_STATE)).unwrap();

    let leases = ProfileRuntimeLeases::acquire(root, StartupMode::Desktop).unwrap();
    let busy = run_child(root, MASTER);
    assert_eq!(busy.status.code(), Some(EXIT_MAINTENANCE_ERROR));
    assert!(String::from_utf8_lossy(&busy.stderr).contains("Close the legacy application"));
    drop(leases);

    let wrong = run_child(root, "wrong password");
    assert_eq!(wrong.status.code(), Some(EXIT_MAINTENANCE_ERROR));
    assert!(String::from_utf8_lossy(&wrong.stderr).contains("VAULT_BAD_PASSWORD"));
    assert_eq!(fs::read(root.join(REGISTRY_STATE)).unwrap(), original_state);
    for path in [JOURNAL, PLAN, TARGET, POINTER] {
        assert!(!root.join(path).exists(), "failed migration wrote {path}");
    }
    legacy.assert_legacy_intact();

    let completed = run_child(root, MASTER);
    assert!(completed.status.success(), "{:?}", completed.stderr);
    assert!(String::from_utf8_lossy(&completed.stdout).contains("MFA data migrated"));
    let journal = fs::read(root.join(JOURNAL)).unwrap();
    let database = fs::read(root.join(TARGET)).unwrap();
    let retried = run_child(root, MASTER);
    assert!(retried.status.success(), "{:?}", retried.stderr);
    assert!(String::from_utf8_lossy(&retried.stdout).contains("MFA data already migrated"));
    assert_eq!(fs::read(root.join(JOURNAL)).unwrap(), journal);
    assert_eq!(fs::read(root.join(TARGET)).unwrap(), database);
    assert!(!root.join(PLAN).exists());
    assert_eq!(
        read_registry_state(root).unwrap(),
        BTreeMap::from([("hello".into(), false), ("mfa".into(), true)])
    );
    legacy.assert_legacy_intact();

    let state = isolated_state(root, AiConfig::default()).unwrap();
    assert!(state.legacy.mfa.legacy_store().unwrap().is_none());
    state
        .plugins
        .unlock_vault(&state.core.vault, MASTER)
        .unwrap();
    let codes = state
        .plugins
        .invoke_scoped(
            OWNER,
            "mfa_codes",
            json!({}),
            &uuid::Uuid::new_v4().to_string(),
            OperationKind::ReadData,
            std::time::Instant::now() + Duration::from_secs(15),
        )
        .unwrap();
    assert_eq!(codes[0]["id"], legacy.account_id);
    assert_eq!(codes[0]["code"], "755224");
    state.plugins.shutdown().unwrap();
}

fn run_child(root: &Path, password: &str) -> std::process::Output {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "plugin::migration_commit::tests::offline::entry_child",
            "--nocapture",
        ])
        .env(TEST_ROOT, root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(password.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn entry_child() {
    let Some(root) = std::env::var_os(TEST_ROOT) else {
        return;
    };
    let artifact = PathBuf::from(std::env::var_os("TAOMNI_SIGNED_MFA_PACKAGE_DIR").unwrap());
    let receipt: serde_json::Value =
        paths::read_json_bounded(&artifact.join("provenance.json")).unwrap();
    let local = |field: &str| -> OsString {
        let name = receipt[field].as_str().unwrap();
        assert_eq!(Path::new(name).file_name().unwrap(), name);
        artifact.join(name).into_os_string()
    };
    if let Err(error) = crate::run_mfa_maintenance([root, local("archive"), local("signature")]) {
        eprintln!("{error}");
        std::process::exit(EXIT_MAINTENANCE_ERROR);
    }
}
