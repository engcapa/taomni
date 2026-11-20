use super::*;
use crate::{HostConfig, Operation, PluginHandler, runtime::serve_owned};
use std::{
    collections::BTreeSet,
    io,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use taomni_plugin_api::{HandshakeRequest, RpcMessage, RpcRequest};
use taomni_profile_locks::ProfileRestoreLease;

fn context() -> HostProfileContext {
    HostProfileContext {
        owner: "hello-plugin".into(),
        generation: ProfileGeneration::parse("a1234567-1234-1234-1234-123456789abc").unwrap(),
    }
}

fn profile() -> (tempfile::TempDir, ProfileRoot) {
    let dir = tempfile::tempdir().unwrap();
    let root = ProfileRoot::prepare(dir.path()).unwrap();
    fs::write(
        root.path().join(".profile-state.json"),
        serde_json::to_vec(&serde_json::json!({
            "formatVersion":1,"generation":context().generation
        }))
        .unwrap(),
    )
    .unwrap();
    (dir, root)
}

#[test]
fn host_itself_excludes_restore_and_duplicate_writer_until_its_last_lease_drops() {
    let (_dir, root) = profile();
    let before = fs::read(root.path().join(".profile-state.json")).unwrap();
    let core = ProfileUseLease::try_acquire(&root).unwrap();
    let host = HostStorage::acquire(root.path(), context(), "taomni-plugin-hello-plugin").unwrap();
    drop(core);
    assert!(ProfileRestoreLease::try_acquire(&root).is_err());
    assert!(
        PluginDataLease::try_acquire(&root, &PluginSlug::parse("hello-plugin").unwrap()).is_err()
    );
    assert!(PluginDataLease::try_acquire(&root, &PluginSlug::parse("other").unwrap()).is_ok());
    assert_eq!(
        confirm_profile_handshake(Some(&host), Some(&context())).unwrap(),
        Some(context())
    );
    assert!(confirm_profile_handshake(Some(&host), None).is_err());
    assert!(confirm_profile_handshake(None, Some(&context())).is_err());
    assert_eq!(confirm_profile_handshake(None, None).unwrap(), None);
    drop(host);
    assert!(ProfileRestoreLease::try_acquire(&root).is_ok());
    assert!(
        PluginDataLease::try_acquire(&root, &PluginSlug::parse("hello-plugin").unwrap()).is_ok()
    );
    assert_eq!(
        fs::read(root.path().join(".profile-state.json")).unwrap(),
        before
    );
    assert!(!root.path().join("plugins").exists());
}

#[test]
fn stale_generation_wrong_compiled_owner_and_restore_ownership_cannot_activate_a_host() {
    let (_dir, root) = profile();
    let mut stale = context();
    stale.generation = ProfileGeneration::parse("b1234567-1234-1234-1234-123456789abc").unwrap();
    assert!(HostStorage::acquire(root.path(), stale, "taomni-plugin-hello-plugin").is_err());
    assert!(HostStorage::acquire(root.path(), context(), "taomni-plugin-mfa").is_err());
    let restore = ProfileRestoreLease::try_acquire(&root).unwrap();
    assert!(HostStorage::acquire(root.path(), context(), "taomni-plugin-hello-plugin").is_err());
    drop(restore);
    let host = HostStorage::acquire(root.path(), context(), "taomni-plugin-hello-plugin").unwrap();
    let mut wrong = context();
    wrong.owner = "mfa".into();
    assert!(confirm_profile_handshake(Some(&host), Some(&wrong)).is_err());
}

#[cfg(unix)]
#[test]
fn profile_alias_or_linked_generation_file_is_rejected_without_reading_other_metadata() {
    use std::os::unix::fs::symlink;
    let (dir, root) = profile();
    let alias = dir.path().join("alias");
    symlink(root.path(), &alias).unwrap();
    assert!(HostStorage::acquire(&alias, context(), "taomni-plugin-hello-plugin").is_err());
    let state = root.path().join(".profile-state.json");
    let saved = fs::read(&state).unwrap();
    let elsewhere = root.path().join("elsewhere");
    fs::write(&elsewhere, &saved).unwrap();
    fs::remove_file(&state).unwrap();
    symlink(&elsewhere, &state).unwrap();
    assert!(HostStorage::acquire(root.path(), context(), "taomni-plugin-hello-plugin").is_err());
    assert_eq!(fs::read(elsewhere).unwrap(), saved);
    assert!(ProfileRestoreLease::try_acquire(&root).is_ok());
}

struct BlockedHandler {
    entered: mpsc::SyncSender<()>,
    release: Mutex<mpsc::Receiver<()>>,
    root: ProfileRoot,
    dropped: mpsc::SyncSender<()>,
}
impl PluginHandler for BlockedHandler {
    fn invoke(
        &self,
        _: &Operation,
        _: &str,
        _: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, RpcError> {
        self.entered.send(()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        Ok(serde_json::json!(true))
    }
}
impl Drop for BlockedHandler {
    fn drop(&mut self) {
        assert!(
            ProfileRestoreLease::try_acquire(&self.root).is_err(),
            "stores close before the profile lease"
        );
        self.dropped.send(()).unwrap();
    }
}

struct EofAfterWorker {
    input: io::Cursor<Vec<u8>>,
    entered: mpsc::Receiver<()>,
}
impl Read for EofAfterWorker {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let count = self.input.read(output)?;
        if count == 0 {
            self.entered
                .recv_timeout(Duration::from_secs(5))
                .map_err(io::Error::other)?;
        }
        Ok(count)
    }
}

#[test]
fn reader_eof_does_not_release_ownership_while_a_business_worker_or_its_store_is_alive() {
    let (_dir, root) = profile();
    let storage =
        HostStorage::acquire(root.path(), context(), "taomni-plugin-hello-plugin").unwrap();
    let (entered, observe) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    let (dropped, closed) = mpsc::sync_channel(1);
    let handler = Arc::new(BlockedHandler {
        entered,
        release: Mutex::new(wait),
        root: root.clone(),
        dropped,
    });
    let config = HostConfig {
        plugin_id: "taomni-plugin-hello-plugin".into(),
        plugin_version: "0.1.0".into(),
        commands: BTreeSet::from(["work".into()]),
        permissions: BTreeSet::new(),
        required_services: Default::default(),
        optional_services: Default::default(),
        operation_timeout: Duration::from_secs(5),
        snapshot_timeout: Duration::from_secs(30),
    };
    let mut handshake = HandshakeRequest::new(
        &config.plugin_id,
        &config.plugin_version,
        "token",
        vec!["work".into()],
        vec![],
    );
    handshake.profile = Some(context());
    let mut input = Vec::new();
    for request in [
        RpcRequest::new(
            "hello",
            "plugin/handshake",
            Some(serde_json::to_value(handshake).unwrap()),
        ),
        RpcRequest::new("work", "work", None),
    ] {
        serde_json::to_writer(&mut input, &RpcMessage::Request(request)).unwrap();
        input.push(b'\n');
    }
    serve_owned(
        EofAfterWorker {
            input: io::Cursor::new(input),
            entered: observe,
        },
        io::sink(),
        "token".into(),
        config,
        handler,
        Some(Arc::new(storage)),
    )
    .unwrap();
    assert!(ProfileRestoreLease::try_acquire(&root).is_err());
    assert!(
        PluginDataLease::try_acquire(&root, &PluginSlug::parse("hello-plugin").unwrap()).is_err()
    );
    release.send(()).unwrap();
    closed.recv_timeout(Duration::from_secs(5)).unwrap();
    let expires = Instant::now() + Duration::from_secs(5);
    loop {
        if ProfileRestoreLease::try_acquire(&root).is_ok() {
            break;
        }
        assert!(
            Instant::now() < expires,
            "SDK worker leaked profile ownership"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        PluginDataLease::try_acquire(&root, &PluginSlug::parse("hello-plugin").unwrap()).is_ok()
    );
}
