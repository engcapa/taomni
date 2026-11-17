//! Real OS process gates. Run explicitly on GitHub's three-platform runners.
use std::{
    fs,
    io::Read,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use taomni_profile_locks::*;

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
#[ignore = "helper for the hosted process lease gate"]
fn lease_child() {
    let Some(root) = std::env::var_os("TAOMNI_PROFILE_LEASE_GATE_ROOT") else {
        return;
    };
    let root = ProfileRoot::prepare(root).unwrap();
    let _profile = ProfileUseLease::try_acquire(&root).unwrap();
    let _writer = PluginDataLease::try_acquire(&root, &PluginSlug::parse("mfa").unwrap()).unwrap();
    let _vault = VaultOperationLease::try_read(&root).unwrap();
    eprintln!(
        "host {} owns profile, mfa writer, and vault reader leases",
        std::process::id()
    );
    fs::write(root.path().join("child-ready"), b"ready").unwrap();
    let mut byte = [0];
    let _ = std::io::stdin().read(&mut byte);
}

fn spawn_host(root: &Path, fixture: &str) -> ChildGuard {
    let mut child = ChildGuard(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", fixture, "--ignored", "--nocapture"])
            .env("TAOMNI_PROFILE_LEASE_GATE_ROOT", root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    while !root.join("child-ready").exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "host exited before acquiring its leases"
        );
        assert!(Instant::now() < deadline, "host did not acquire its leases");
        std::thread::sleep(Duration::from_millis(10));
    }
    child
}

#[test]
#[ignore = "requires the hosted real-process lease gate"]
fn surviving_host_excludes_restore_writer_and_rekey_until_a_crash_releases_them() {
    let directory = tempfile::tempdir().unwrap();
    let root = ProfileRoot::prepare(directory.path()).unwrap();
    let core = ProfileUseLease::try_acquire(&root).unwrap();
    let mut host = spawn_host(root.path(), "lease_child");
    drop(core); // The host's own lease still protects the profile.
    assert!(matches!(
        ProfileRestoreLease::try_acquire(&root),
        Err(LeaseError::Busy(_))
    ));
    assert!(matches!(
        PluginDataLease::try_acquire(&root, &PluginSlug::parse("mfa").unwrap()),
        Err(LeaseError::Busy(_))
    ));
    assert!(matches!(
        VaultOperationLease::try_write(&root),
        Err(LeaseError::Busy(_))
    ));
    let cancelled = || true;
    let wait = WaitControl::new(Instant::now() + Duration::from_secs(1), &cancelled);
    assert!(matches!(
        ProfileRestoreLease::acquire(&root, &wait),
        Err(LeaseError::Cancelled)
    ));
    let never = || false;
    let bounded = WaitControl::new(Instant::now() + Duration::from_millis(30), &never);
    assert!(matches!(
        VaultOperationLease::write(&root, &bounded),
        Err(LeaseError::TimedOut)
    ));
    eprintln!(
        "surviving host blocked restore, duplicate writer and rekey; cancellation/timeout observed"
    );
    host.0.kill().unwrap();
    host.0.wait().unwrap();
    assert!(ProfileRestoreLease::try_acquire(&root).is_ok());
    assert!(PluginDataLease::try_acquire(&root, &PluginSlug::parse("mfa").unwrap()).is_ok());
    assert!(VaultOperationLease::try_write(&root).is_ok());
    assert!(root.path().join(".profile-use.lock").exists());
    eprintln!("host crash released OS ownership; stable lock files remain");
}

#[test]
#[ignore = "helper selected only by the hosted legacy-mode process gate"]
fn legacy_mode_child() {
    let Some(root) = std::env::var_os("TAOMNI_PROFILE_LEASE_GATE_ROOT") else {
        return;
    };
    let root = ProfileRoot::prepare(root).unwrap();
    let mode = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.path().join(".mobile-mode.lock"))
        .unwrap();
    mode.try_lock_shared().unwrap();
    eprintln!(
        "legacy-mode fixture {} owns shared mode lease",
        std::process::id()
    );
    fs::write(root.path().join("child-ready"), b"ready").unwrap();
    let mut byte = [0];
    let _ = std::io::stdin().read(&mut byte);
}

#[test]
#[ignore = "requires the hosted real-process legacy-mode gate"]
fn legacy_mode_writer_blocks_upgrade_until_a_crash_releases_its_lease() {
    let directory = tempfile::tempdir().unwrap();
    let root = ProfileRoot::prepare(directory.path()).unwrap();
    // A legacy process does not know the newer profile-use lock. Holding it
    // here distinguishes the required old-mode exclusion from that new lock.
    let restore = ProfileRestoreLease::try_acquire(&root).unwrap();
    let mut legacy = spawn_host(root.path(), "legacy_mode_child");
    assert!(matches!(
        LegacyUpgradeLease::try_acquire(&root),
        Err(LeaseError::Busy(LeaseKind::LegacyUpgrade))
    ));
    drop(restore);
    assert!(ProfileRestoreLease::try_acquire(&root).is_ok());
    assert!(LegacyUpgradeLease::try_acquire(&root).is_err());
    let pid = legacy.0.id();
    legacy.0.kill().unwrap();
    let exit = legacy.0.wait().unwrap();
    let upgrade = LegacyUpgradeLease::try_acquire(&root).unwrap();
    let current = ProfileUseLease::try_acquire(&root).unwrap();
    assert!(ProfileRestoreLease::try_acquire(&root).is_err());
    drop(current);
    let _profile = ProfileRestoreLease::try_acquire(&root).unwrap();
    drop(upgrade);
    eprintln!(
        "legacy-mode fixture pid={pid} exit={exit}; old mode released; new profile ownership still independently enforced"
    );
}
