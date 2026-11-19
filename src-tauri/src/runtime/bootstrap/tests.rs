//! In-process store/ownership tests only; native processes run on hosted runners.
use super::*;
fn config() -> AiConfig {
    AiConfig {
        fully_disabled: true,
        ..AiConfig::default()
    }
}

#[test]
fn construction_is_explicit_and_preserves_lazy_optional_data_and_mail_identity() {
    let root = tempfile::tempdir().unwrap();
    let plugins = root.path().join("plugins/broken");
    std::fs::create_dir_all(&plugins).unwrap();
    std::fs::write(plugins.join("module.json"), b"malformed").unwrap();
    // Startup never opens optional MFA data or removed LanChat data.
    std::fs::write(root.path().join("mfa.db"), b"damaged optional database").unwrap();
    let lanchat = root.path().join("lanchat.sqlite");
    std::fs::write(&lanchat, b"retained legacy bytes").unwrap();
    let boot = bootstrap(
        ProfilePaths::isolated(root.path()),
        StartupMode::Headless,
        Some(config()),
        false,
    )
    .unwrap();
    assert!(
        !boot
            .runtime
            .started
            .load(std::sync::atomic::Ordering::Acquire)
    );
    assert!(boot.runtime.tasks.cancellation().is_cancelled() == false);
    assert_eq!(boot.state.plugins.root(), boot.state.core.paths.plugins);
    assert!(
        boot.state
            .core
            .db
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM sessions", [], |row| row
                .get::<_, i64>(0))
            .is_ok()
    );
    let first = boot.state.mail_db("unknown-account").unwrap();
    let second = boot
        .state
        .legacy
        .mail
        .database("unknown-account", || {
            panic!("A cached handle must not reload session options")
        })
        .unwrap();
    assert!(
        Arc::ptr_eq(&first, &second),
        "compat facade must use the one legacy mail owner"
    );
    assert_eq!(boot.state.mail_cache_root(), root.path().join("mail-cache"));
    assert!(!boot.state.mail_cache_root().exists());
    let mail = first.lock().unwrap();
    assert!(std::path::Path::new(mail.path().unwrap()).is_file());
    assert_eq!(std::fs::read(lanchat).unwrap(), b"retained legacy bytes");
    assert_eq!(
        std::fs::read(root.path().join("mfa.db")).unwrap(),
        b"damaged optional database"
    );
}

#[test]
fn startup_failure_releases_both_mode_and_profile_ownership() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("taomni.db"), b"invalid sqlite").unwrap();
    assert!(
        bootstrap(
            ProfilePaths::isolated(root.path()),
            StartupMode::Headless,
            Some(config()),
            false,
        )
        .is_err()
    );
    std::fs::remove_file(root.path().join("taomni.db")).unwrap();
    let recovered = bootstrap(
        ProfilePaths::isolated(root.path()),
        StartupMode::Headless,
        Some(config()),
        false,
    )
    .unwrap();
    assert!(recovered.state.core.db.lock().is_ok());
}

#[test]
fn desktop_and_headless_share_core_schema_and_keep_profile_lock_through_extracted_core() {
    let root = tempfile::tempdir().unwrap();
    let desktop = bootstrap(
        ProfilePaths::isolated(root.path()),
        StartupMode::Desktop,
        Some(config()),
        false,
    )
    .unwrap();
    assert!(
        bootstrap(
            ProfilePaths::isolated(root.path()),
            StartupMode::Headless,
            Some(config()),
            false,
        )
        .is_err()
    );
    let core = desktop.state.core.clone();
    drop(desktop);
    assert!(
        bootstrap(
            ProfilePaths::isolated(root.path()),
            StartupMode::Headless,
            Some(config()),
            false,
        )
        .is_err()
    );
    drop(core);
    let headless = bootstrap(
        ProfilePaths::isolated(root.path()),
        StartupMode::Headless,
        Some(config()),
        false,
    )
    .unwrap();
    assert!(
        headless
            .state
            .core
            .db
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM sessions", [], |row| row
                .get::<_, i64>(0))
            .is_ok()
    );
}

#[test]
fn refused_startup_leaves_the_legacy_database_at_its_original_path() {
    use crate::runtime::profile::ModeLease;

    for (owner, contender) in [
        (StartupMode::Desktop, StartupMode::Headless),
        (StartupMode::Headless, StartupMode::Desktop),
    ] {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("newmob.db");
        let current = root.path().join("taomni.db");
        rusqlite::Connection::open(&legacy)
            .unwrap()
            .execute_batch("CREATE TABLE previous_profile (value TEXT); INSERT INTO previous_profile VALUES ('retained');")
            .unwrap();
        let original = std::fs::read(&legacy).unwrap();
        let lease = ModeLease::acquire(root.path(), owner).unwrap();
        let attempt = bootstrap(
            ProfilePaths::isolated(root.path()),
            contender,
            Some(config()),
            false,
        );
        assert_eq!(
            attempt.err().as_deref(),
            Some("Close the other Taomni mode using this profile first")
        );
        assert_eq!(std::fs::read(&legacy).unwrap(), original);
        assert!(!current.exists());

        drop(lease);
        let started = bootstrap(
            ProfilePaths::isolated(root.path()),
            contender,
            Some(config()),
            false,
        )
        .unwrap();
        assert!(!legacy.exists());
        let connection = started.state.core.db.lock().unwrap();
        let value: String = connection
            .query_row("SELECT value FROM previous_profile", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "retained");
    }
}
