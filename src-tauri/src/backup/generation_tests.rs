//! Legacy restore recovery advances core metadata before replacing databases.
use crate::runtime::generation;
use taomni_profile_locks::{ProfileRestoreLease, ProfileRoot};

#[test]
fn legacy_journal_rollback_never_restores_the_previous_profile_generation() {
    let dir = tempfile::tempdir().unwrap();
    let root = ProfileRoot::prepare(dir.path()).unwrap();
    let _exclusive = ProfileRestoreLease::try_acquire(&root).unwrap();
    let before = generation::current(dir.path()).unwrap();
    let database = dir.path().join("taomni.db");
    let saved = dir.path().join("rollback.db");
    std::fs::write(&database, b"partially applied new database").unwrap();
    std::fs::write(&saved, b"previous database").unwrap();
    crate::backup::control::write_json(
        &dir.path().join(super::restore::JOURNAL_FILE),
        &serde_json::json!({
            "entries": [{"path": database, "saved": saved, "existed": true}],
            "committed": false
        }),
    )
    .unwrap();
    super::restore::apply_pending_restore(dir.path()).unwrap();
    assert_eq!(std::fs::read(&database).unwrap(), b"previous database");
    let after = generation::current(dir.path()).unwrap();
    assert_ne!(before, after);
    super::restore::apply_pending_restore(dir.path()).unwrap();
    assert_eq!(generation::current(dir.path()).unwrap(), after);
}
