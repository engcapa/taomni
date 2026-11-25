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
        .database(&boot.state.plugins, "unknown-account", || {
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
        assert!(matches!(attempt, Err(ProfileStartupError::ModeInUse)));
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

#[test]
fn startup_modes_and_offline_mfa_share_legacy_profile_ownership() {
    use crate::runtime::profile::ModeLease;
    use taomni_profile_locks::{LeaseError, LeaseKind, LegacyUpgradeLease, ProfileRoot};

    let root = tempfile::tempdir().unwrap();
    let profile = ProfileRoot::prepare(root.path()).unwrap();
    let desktop = ModeLease::acquire(root.path(), StartupMode::Desktop).unwrap();
    let second_desktop = ModeLease::acquire(root.path(), StartupMode::Desktop).unwrap();
    assert!(matches!(
        LegacyUpgradeLease::try_acquire(&profile),
        Err(LeaseError::Busy(LeaseKind::LegacyUpgrade))
    ));
    drop(desktop);
    assert!(matches!(
        ModeLease::acquire(root.path(), StartupMode::Headless),
        Err(ProfileStartupError::ModeInUse)
    ));
    drop(second_desktop);

    let maintenance = LegacyUpgradeLease::try_acquire(&profile).unwrap();
    for mode in [StartupMode::Desktop, StartupMode::Headless] {
        assert!(matches!(
            ModeLease::acquire(root.path(), mode),
            Err(ProfileStartupError::ModeInUse)
        ));
    }
    drop(maintenance);
    assert!(ModeLease::acquire(root.path(), StartupMode::Headless).is_ok());
}

#[cfg(unix)]
#[test]
fn startup_rejects_a_linked_legacy_mode_lock() {
    use crate::runtime::profile::ModeLease;

    let root = tempfile::tempdir().unwrap();
    let original = root.path().join("unrelated");
    std::fs::write(&original, b"untouched").unwrap();
    std::os::unix::fs::symlink(&original, root.path().join(".mobile-mode.lock")).unwrap();
    for mode in [StartupMode::Desktop, StartupMode::Headless] {
        assert!(matches!(ModeLease::acquire(root.path(), mode),
            Err(ProfileStartupError::Failed(message)) if message.contains("unsafe profile lock path")));
    }
    assert_eq!(std::fs::read(&original).unwrap(), b"untouched");
}

#[test]
fn pending_mfa_recovery_preserves_mode_conflicts_and_the_transaction() {
    use crate::runtime::profile::ModeLease;

    for (owner, contender) in [
        (StartupMode::Desktop, StartupMode::Headless),
        (StartupMode::Headless, StartupMode::Desktop),
        (StartupMode::Desktop, StartupMode::Desktop),
    ] {
        let root = tempfile::tempdir().unwrap();
        for dir in ["migration", "plugins/mfa/versions"] {
            std::fs::create_dir_all(root.path().join(dir)).unwrap();
        }
        let transaction = root.path().join("migration/mfa-transaction.json");
        std::fs::write(&transaction, b"{}\n").unwrap();
        let lease = ModeLease::acquire(root.path(), owner).unwrap();
        let start = || {
            bootstrap(
                ProfilePaths::isolated(root.path()),
                contender,
                Some(config()),
                false,
            )
        };

        let error = start()
            .err()
            .expect("Recovery requires exclusive ownership");
        assert!(matches!(error, ProfileStartupError::ModeInUse), "{error}");
        assert_eq!(std::fs::read(&transaction).unwrap(), b"{}\n");
        assert!(!root.path().join("taomni.db").exists());

        drop(lease);
        let error = start().err().expect("Invalid MFA transaction must fail");
        assert!(
            matches!(error, ProfileStartupError::Failed(message) if message.contains("missing field"))
        );
        assert_eq!(std::fs::read(&transaction).unwrap(), b"{}\n");
        assert!(!root.path().join("taomni.db").exists());
        std::fs::remove_file(&transaction).unwrap();
        assert!(start().is_ok());
    }
}

#[test]
fn startup_preserves_committed_records_in_legacy_database_wal() {
    let root = tempfile::tempdir().unwrap();
    let legacy = root.path().join("newmob.db");
    let wal = root.path().join("newmob.db-wal");
    let source = rusqlite::Connection::open(&legacy).unwrap();
    source
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
             CREATE TABLE original_profile (value TEXT);
             PRAGMA wal_checkpoint(TRUNCATE);
             INSERT INTO original_profile VALUES ('committed to the WAL');",
        )
        .unwrap();
    let original_db = std::fs::read(&legacy).unwrap();
    let original_wal = std::fs::read(&wal).unwrap();
    assert!(!original_wal.is_empty());

    let started = bootstrap(
        ProfilePaths::isolated(root.path()),
        StartupMode::Headless,
        Some(config()),
        false,
    )
    .unwrap();
    let value: String = started
        .state
        .core
        .db
        .lock()
        .unwrap()
        .query_row("SELECT value FROM original_profile", [], |row| row.get(0))
        .unwrap();
    assert_eq!(value, "committed to the WAL");
    assert_eq!(std::fs::read(&legacy).unwrap(), original_db);
    assert_eq!(std::fs::read(&wal).unwrap(), original_wal);
}

#[test]
fn unreadable_legacy_wal_database_leaves_the_profile_retryable() {
    let root = tempfile::tempdir().unwrap();
    let legacy = root.path().join("newmob.db");
    let wal = root.path().join("newmob.db-wal");
    std::fs::write(&legacy, b"damaged database").unwrap();
    std::fs::write(&wal, b"damaged WAL").unwrap();
    let start = || {
        bootstrap(
            ProfilePaths::isolated(root.path()),
            StartupMode::Headless,
            Some(config()),
            false,
        )
    };

    let error = start().err().expect("Damaged data must fail startup");
    assert!(matches!(error, ProfileStartupError::Failed(message)
        if message.contains("Could not migrate the legacy database")));
    assert!(!root.path().join("taomni.db").exists());
    assert_eq!(std::fs::read(&legacy).unwrap(), b"damaged database");
    assert_eq!(std::fs::read(&wal).unwrap(), b"damaged WAL");

    std::fs::remove_file(&legacy).unwrap();
    std::fs::remove_file(&wal).unwrap();
    rusqlite::Connection::open(&legacy).unwrap();
    assert!(start().is_ok());
}
