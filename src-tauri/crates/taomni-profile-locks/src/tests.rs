use std::{
    fs::OpenOptions,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::fs::File;

use super::*;

fn profile() -> (tempfile::TempDir, ProfileRoot) {
    let directory = tempfile::tempdir().unwrap();
    let root = ProfileRoot::prepare(directory.path()).unwrap();
    (directory, root)
}

#[test]
fn shared_profile_leases_match_the_existing_core_lock_file() {
    let (directory, root) = profile();
    let old = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.path().join(".profile-use.lock"))
        .unwrap();
    old.try_lock_shared().unwrap();
    let first = ProfileUseLease::try_acquire(&root).unwrap();
    let second = ProfileUseLease::try_acquire(&root).unwrap();
    assert!(matches!(
        ProfileRestoreLease::try_acquire(&root),
        Err(LeaseError::Busy(LeaseKind::ProfileRestore))
    ));
    drop(first);
    drop(second);
    old.unlock().unwrap();
    let restore = ProfileRestoreLease::try_acquire(&root).unwrap();
    assert!(matches!(
        ProfileUseLease::try_acquire(&root),
        Err(LeaseError::Busy(LeaseKind::ProfileUse))
    ));
    drop(restore);
    assert!(ProfileUseLease::try_acquire(&root).is_ok());
}

#[test]
fn plugin_writers_are_exclusive_per_slug_and_leave_stable_files() {
    let (_directory, root) = profile();
    let mfa = PluginSlug::parse("mfa").unwrap();
    let other = PluginSlug::parse("other-plugin").unwrap();
    let writer = PluginDataLease::try_acquire(&root, &mfa).unwrap();
    assert!(matches!(
        PluginDataLease::try_acquire(&root, &mfa),
        Err(LeaseError::Busy(LeaseKind::PluginData))
    ));
    assert!(PluginDataLease::try_acquire(&root, &other).is_ok());
    drop(writer);
    assert!(PluginDataLease::try_acquire(&root, &mfa).is_ok());
    assert!(
        root.path()
            .join(".profile-locks/plugins/mfa.lock")
            .is_file()
    );
}

#[test]
fn vault_readers_exclude_rekey_and_release_ownership() {
    let (_directory, root) = profile();
    let first = VaultOperationLease::try_read(&root).unwrap();
    let second = VaultOperationLease::try_read(&root).unwrap();
    assert!(!first.is_exclusive());
    assert!(matches!(
        VaultOperationLease::try_write(&root),
        Err(LeaseError::Busy(LeaseKind::VaultWrite))
    ));
    drop(first);
    drop(second);
    let write = VaultOperationLease::try_write(&root).unwrap();
    assert!(write.is_exclusive());
    assert!(matches!(
        VaultOperationLease::try_read(&root),
        Err(LeaseError::Busy(LeaseKind::VaultRead))
    ));
}

#[test]
fn cancelled_or_expired_waits_do_not_acquire_available_or_busy_locks() {
    let (_directory, root) = profile();
    let cancelled = || true;
    let control = WaitControl::new(Instant::now() + Duration::from_secs(1), &cancelled);
    assert!(matches!(
        ProfileUseLease::acquire(&root, &control),
        Err(LeaseError::Cancelled)
    ));
    let never = || false;
    let expired = WaitControl::new(Instant::now(), &never);
    assert!(matches!(
        VaultOperationLease::write(&root, &expired),
        Err(LeaseError::TimedOut)
    ));
    assert!(ProfileRestoreLease::try_acquire(&root).is_ok());
}

#[test]
fn different_profiles_do_not_share_leases() {
    let (_a, first) = profile();
    let (_b, second) = profile();
    let _restore = ProfileRestoreLease::try_acquire(&first).unwrap();
    assert!(ProfileUseLease::try_acquire(&second).is_ok());
}

#[test]
fn slug_cannot_escape_a_lock_directory() {
    for invalid in [
        "", "..", "a/b", "a\\b", "-mfa", "mfa-", "MFA", "mfa\n", "con", "com1",
    ] {
        assert!(PluginSlug::parse(invalid).is_err(), "{invalid:?}");
    }
    assert!(PluginSlug::parse("rdp-client").is_ok());
}

#[cfg(unix)]
#[test]
fn symbolic_lock_directories_or_files_are_rejected() {
    use std::os::unix::fs::symlink;
    let (directory, root) = profile();
    let other = tempfile::tempdir().unwrap();
    symlink(other.path(), directory.path().join(".profile-locks")).unwrap();
    assert!(matches!(
        VaultOperationLease::try_read(&root),
        Err(LeaseError::UnsafeLockPath)
    ));
    let target = other.path().join("target");
    File::create(&target).unwrap();
    symlink(target, directory.path().join(".profile-use.lock")).unwrap();
    assert!(matches!(
        ProfileUseLease::try_acquire(&root),
        Err(LeaseError::UnsafeLockPath)
    ));
}
