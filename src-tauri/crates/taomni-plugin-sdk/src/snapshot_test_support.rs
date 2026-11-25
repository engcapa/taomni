use super::*;
use crate::client::ServiceClient;
use std::{
    fs,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};
use taomni_profile_locks::ProfileRoot;

pub(super) const ID: &str = "a1234567-1234-1234-1234-123456789abc";
pub(super) const OTHER: &str = "b1234567-1234-1234-1234-123456789abc";

pub(super) fn operation() -> Arc<Operation> {
    let (sender, _receiver) = mpsc::sync_channel(8);
    Arc::new(Operation::new(
        None,
        Instant::now() + Duration::from_secs(10),
        ServiceClient::new(sender),
    ))
}

pub(super) struct Fixture {
    pub storage: HostStorage,
    pub request: PrepareSnapshot,
    pub provider: Arc<Provider>,
    pub host: HostInstanceId,
    pub root: ProfileRoot,
    pub _dir: tempfile::TempDir,
}

impl Fixture {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(dir.path()).unwrap();
        let generation = ProfileGeneration::parse(ID).unwrap();
        fs::write(
            root.path().join(".profile-state.json"),
            serde_json::to_vec(&serde_json::json!({"formatVersion":1,"generation":generation}))
                .unwrap(),
        )
        .unwrap();
        let storage = HostStorage::acquire(
            root.path(),
            HostProfileContext {
                owner: "mfa".into(),
                generation: generation.clone(),
            },
            "taomni-plugin-mfa",
        )
        .unwrap();
        let source = root.path().join("plugins/mfa/data");
        fs::create_dir_all(&source).unwrap();
        let db = rusqlite::Connection::open(source.join("mfa.db")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE entries (secret BLOB); INSERT INTO entries VALUES (x'010002ff');").unwrap();
        let output = root.path().join("backup-job");
        fs::create_dir(&output).unwrap();
        let request = PrepareSnapshot {
            job: SnapshotJobId::parse(ID).unwrap(),
            profile_generation: generation,
            destination: SnapshotDestinationGrant {
                token: StagingToken::parse(ID).unwrap(),
                absolute_job_root: output,
                allowed_files: vec![SafeRelativePath::parse("mfa.db").unwrap()],
                opaque_files: Vec::new(),
            },
        };
        Self {
            storage,
            request,
            provider: Arc::new(Provider {
                db: Mutex::new(db),
                frozen: AtomicBool::new(false),
                freezes: AtomicUsize::new(0),
                exports: AtomicUsize::new(0),
                resumes: AtomicUsize::new(0),
                fail_freeze: AtomicBool::new(false),
            }),
            host: HostInstanceId::parse(ID).unwrap(),
            root,
            _dir: dir,
        }
    }

    pub fn call(
        &self,
        session: &mut SnapshotSession,
        method: &str,
        params: impl serde::Serialize,
    ) -> Result<Value, RpcError> {
        session.dispatch(
            method,
            Some(serde_json::to_value(params).unwrap()),
            Some(&self.storage),
            Some(&self.host),
            Some(self.provider.clone()),
            operation(),
        )
    }

    pub fn prepare(&self, session: &mut SnapshotSession) -> PreparedSnapshot {
        serde_json::from_value(
            self.call(session, SNAPSHOT_PREPARE_METHOD, &self.request)
                .unwrap(),
        )
        .unwrap()
    }

    pub fn export_request(&self, prepared: &PreparedSnapshot) -> SnapshotRequest {
        SnapshotRequest {
            job: prepared.job.clone(),
            barrier: prepared.barrier.clone(),
            staging: self.request.destination.token.clone(),
        }
    }
}

pub(super) struct Provider {
    pub db: Mutex<rusqlite::Connection>,
    pub frozen: AtomicBool,
    pub freezes: AtomicUsize,
    pub exports: AtomicUsize,
    pub resumes: AtomicUsize,
    pub fail_freeze: AtomicBool,
}

impl SnapshotProvider for Provider {
    fn freeze(&self, _: &Operation) -> Result<(), RpcError> {
        self.freezes.fetch_add(1, Ordering::SeqCst);
        assert!(!self.frozen.swap(true, Ordering::SeqCst));
        if self.fail_freeze.load(Ordering::SeqCst) {
            Err(invalid())
        } else {
            Ok(())
        }
    }
    fn export(
        &self,
        destination: &mut SnapshotExport,
        operation: &Operation,
    ) -> Result<(), RpcError> {
        assert!(self.frozen.load(Ordering::SeqCst));
        assert!(
            operation.context().is_none(),
            "snapshot must never have a key operation permit"
        );
        self.exports.fetch_add(1, Ordering::SeqCst);
        destination.sqlite("mfa.db", &self.db.lock().unwrap())
    }
    fn resume(&self) {
        assert!(self.frozen.swap(false, Ordering::SeqCst));
        self.resumes.fetch_add(1, Ordering::SeqCst);
    }
}
