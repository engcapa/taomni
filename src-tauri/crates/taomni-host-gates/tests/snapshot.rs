//! Compile locally; actual pipes, kernel leases and SQLite/WAL run on GitHub.
mod support;
use std::{
    fs,
    time::{Duration, Instant},
};
use taomni_host_gates::host::{HostProcess, HostProcessError, HostProfileConfig};
use taomni_plugin_api::services::*;
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRestoreLease, ProfileRoot};

const ID: &str = "a1234567-1234-1234-1234-123456789abc";
const OTHER: &str = "b1234567-1234-1234-1234-123456789abc";

struct Fixture {
    root: ProfileRoot,
    _dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(dir.path()).unwrap();
        fs::write(
            root.path().join(".profile-state.json"),
            serde_json::to_vec(&serde_json::json!({"formatVersion":1,"generation":ID})).unwrap(),
        )
        .unwrap();
        Self { root, _dir: dir }
    }
    fn start(&self) -> HostProcess {
        let host = support::hello();
        let commands = serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../plugins/hello-plugin/module.json"
        ))
        .unwrap()["commands"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().into())
            .collect::<Vec<_>>();
        HostProcess::start_profiled(
            HostProfileConfig::new(
                self.root.clone(),
                PluginSlug::parse("hello-plugin").unwrap(),
                ProfileGeneration::parse(ID).unwrap(),
            ),
            "taomni-plugin-hello-plugin",
            "0.1.0",
            &host,
            host.parent().unwrap(),
            &commands,
            &[],
            support::config(),
            None,
        )
        .unwrap()
    }
    fn request(&self, id: &str) -> PrepareSnapshot {
        let target = self.root.path().join(id);
        fs::create_dir(&target).unwrap();
        PrepareSnapshot {
            job: SnapshotJobId::parse(id).unwrap(),
            profile_generation: ProfileGeneration::parse(ID).unwrap(),
            destination: SnapshotDestinationGrant {
                token: StagingToken::parse(id).unwrap(),
                absolute_job_root: target,
                allowed_files: vec![SafeRelativePath::parse("hello.sqlite").unwrap()],
                opaque_files: Vec::new(),
            },
        }
    }
    fn source(&self) -> Vec<u8> {
        fs::read(
            self.root
                .path()
                .join("plugins/hello-plugin/data/hello.sqlite-wal"),
        )
        .unwrap()
    }
    fn assert_owned(&self) {
        assert!(ProfileRestoreLease::try_acquire(&self.root).is_err());
        assert!(
            PluginDataLease::try_acquire(&self.root, &PluginSlug::parse("hello-plugin").unwrap())
                .is_err()
        );
    }
    fn assert_released(&self) {
        support::wait_for(
            || {
                ProfileRestoreLease::try_acquire(&self.root).is_ok()
                    && PluginDataLease::try_acquire(
                        &self.root,
                        &PluginSlug::parse("hello-plugin").unwrap(),
                    )
                    .is_ok()
            },
            "snapshot owner released",
        );
    }
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(10)
}
fn write(process: &mut HostProcess, value: &str) {
    process
        .invoke("hello/write", Some(serde_json::json!({"value":value})))
        .unwrap();
}
fn values(process: &mut HostProcess) -> serde_json::Value {
    process.invoke("hello/read", None).unwrap()["values"].clone()
}

#[test]
#[ignore = "real running snapshot protocol: GitHub runners only"]
fn real_actor_wal_snapshot_preserves_source_and_releases_for_a_second_write() {
    let fixture = Fixture::new();
    let mut process = fixture.start();
    write(&mut process, "first committed record");
    let before = fixture.source();
    let request = fixture.request(ID);
    let prepared = process
        .prepare_snapshot(&request, deadline(), &|| false)
        .unwrap();
    assert_eq!(
        process
            .prepare_snapshot(&request, deadline(), &|| false)
            .unwrap(),
        prepared
    );
    fixture.assert_owned();
    assert_eq!(
        process
            .invoke(
                "hello/write",
                Some(serde_json::json!({"value":"must not be committed"}))
            )
            .unwrap_err()
            .rpc_code(),
        -32009
    );
    let result = process
        .snapshot(
            &prepared,
            request.destination.token.clone(),
            deadline(),
            &|| false,
        )
        .unwrap();
    assert_eq!(result.files.len(), 1);
    assert_eq!(result.files[0].relative_path.as_str(), "hello.sqlite");
    let db = rusqlite::Connection::open_with_flags(
        request.destination.absolute_job_root.join("hello.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        db.query_row("SELECT value FROM entries", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "first committed record"
    );
    db.close().unwrap();
    assert_eq!(fixture.source(), before);
    process.release_snapshot(&prepared, deadline()).unwrap();
    process.release_snapshot(&prepared, deadline()).unwrap();
    write(&mut process, "second record after release");
    assert_eq!(
        values(&mut process),
        serde_json::json!(["first committed record", "second record after release"])
    );
    fixture.assert_owned();
    process.stop_confirmed(deadline()).unwrap();
    fixture.assert_released();
    let mut restarted = fixture.start();
    // Snapshot immediately after the handshake, before any business command.
    // The normal startup factory must reopen its own persisted connection.
    let request = fixture.request(OTHER);
    let prepared = restarted
        .prepare_snapshot(&request, deadline(), &|| false)
        .unwrap();
    restarted
        .snapshot(&prepared, request.destination.token, deadline(), &|| false)
        .unwrap();
    let db = rusqlite::Connection::open_with_flags(
        request.destination.absolute_job_root.join("hello.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let values = db
        .prepare("SELECT value FROM entries ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        values,
        ["first committed record", "second record after release"]
    );
    db.close().unwrap();
    restarted.release_snapshot(&prepared, deadline()).unwrap();
    fixture.assert_owned();
}

#[test]
#[ignore = "real running snapshot protocol: GitHub runners only"]
fn a_wrong_barrier_cannot_export_or_release_the_real_store() {
    let fixture = Fixture::new();
    let mut process = fixture.start();
    write(&mut process, "only committed value");
    let request = fixture.request(ID);
    let prepared = process
        .prepare_snapshot(&request, deadline(), &|| false)
        .unwrap();
    let mut wrong = prepared.clone();
    wrong.barrier = SnapshotBarrierToken::parse(OTHER).unwrap();
    assert_eq!(
        process
            .snapshot(&wrong, request.destination.token, deadline(), &|| false)
            .unwrap_err()
            .rpc_code(),
        -32602
    );
    assert_eq!(
        process
            .release_snapshot(&wrong, deadline())
            .unwrap_err()
            .rpc_code(),
        -32602
    );
    assert_eq!(
        process.invoke("hello/read", None).unwrap_err().rpc_code(),
        -32009
    );
    assert_eq!(
        fs::read_dir(&request.destination.absolute_job_root)
            .unwrap()
            .count(),
        0
    );
    process.release_snapshot(&prepared, deadline()).unwrap();
    assert_eq!(
        values(&mut process),
        serde_json::json!(["only committed value"])
    );
}

#[test]
#[ignore = "real running snapshot protocol: GitHub runners only"]
fn cancellation_during_a_prepared_job_never_publishes_and_containment_releases_ownership() {
    let fixture = Fixture::new();
    let mut process = fixture.start();
    write(&mut process, "retained original value");
    let request = fixture.request(ID);
    let prepared = process
        .prepare_snapshot(&request, deadline(), &|| false)
        .unwrap();
    assert!(matches!(
        process.snapshot(&prepared, request.destination.token, deadline(), &|| true),
        Err(HostProcessError::Cancelled)
    ));
    assert_eq!(
        fs::read_dir(&request.destination.absolute_job_root)
            .unwrap()
            .count(),
        0
    );
    process.abort_snapshot(deadline()).unwrap();
    fixture.assert_released();
    support::restart(&mut process);
    fixture.assert_owned();
    assert_eq!(
        values(&mut process),
        serde_json::json!(["retained original value"])
    );
    let next = fixture.request(OTHER);
    let new = process
        .prepare_snapshot(&next, deadline(), &|| false)
        .unwrap();
    assert_ne!(new.host_instance, prepared.host_instance);
    assert!(process.release_snapshot(&prepared, deadline()).is_err());
    assert_eq!(
        process.invoke("hello/read", None).unwrap_err().rpc_code(),
        -32009
    );
    process.release_snapshot(&new, deadline()).unwrap();
    assert_eq!(
        values(&mut process),
        serde_json::json!(["retained original value"])
    );
}

#[test]
#[ignore = "real running snapshot protocol: GitHub runners only"]
fn stale_generation_and_a_business_directory_destination_do_not_freeze_or_mutate_data() {
    let fixture = Fixture::new();
    let mut process = fixture.start();
    write(&mut process, "original data");
    let before = fixture.source();
    let mut request = fixture.request(ID);
    request.profile_generation = ProfileGeneration::parse(OTHER).unwrap();
    assert!(
        process
            .prepare_snapshot(&request, deadline(), &|| false)
            .is_err()
    );
    request.profile_generation = ProfileGeneration::parse(ID).unwrap();
    request.destination.absolute_job_root = fixture.root.path().join("plugins/hello-plugin/data");
    assert!(
        process
            .prepare_snapshot(&request, deadline(), &|| false)
            .is_err()
    );
    assert_eq!(values(&mut process), serde_json::json!(["original data"]));
    assert_eq!(fixture.source(), before);
    fixture.assert_owned();
}
