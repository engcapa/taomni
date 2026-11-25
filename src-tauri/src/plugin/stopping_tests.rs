//! No native processes are spawned here. These tests exercise registry
//! ownership and error propagation; hosted gates verify the kernel receipts.
use super::*;
use crate::plugin::{LifecycleState, PluginRecord, placeholder_manifest, runtime::RuntimeHost};

fn fixture(root: &std::path::Path) -> (PluginRegistry, Arc<RuntimeHost>) {
    let registry = PluginRegistry::new(root);
    let manifest = placeholder_manifest("mfa");
    registry.records.write().unwrap().insert(
        "mfa".into(),
        PluginRecord {
            manifest: manifest.clone(),
            state: LifecycleState::Enabled,
            reason: None,
            data_retained: false,
            previous_version: None,
            rollback_until: None,
        },
    );
    let runtime = Arc::new(RuntimeHost::stopped_for_test(manifest));
    registry
        .hosts
        .lock()
        .unwrap()
        .insert("mfa".into(), runtime.clone());
    (registry, runtime)
}

fn poison_process(runtime: &RuntimeHost) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _owner = runtime.process.lock().unwrap();
        panic!("simulate interrupted process owner");
    }));
    assert!(result.is_err());
}

#[test]
fn waiting_operation_timeout_retains_the_runtime_and_retry_removes_it() {
    let root = tempfile::tempdir().unwrap();
    let (registry, runtime) = fixture(root.path());
    let owner = runtime.process.lock().unwrap();
    assert!(matches!(
        registry.stop_host_until("mfa", Instant::now()),
        Err(PluginError::HostUnavailable(_))
    ));
    assert!(Arc::ptr_eq(
        registry.hosts.lock().unwrap().get("mfa").unwrap(),
        &runtime
    ));
    assert_eq!(registry.get("mfa").unwrap().state, LifecycleState::Enabled);
    drop(owner);
    registry.stop_host("mfa").unwrap();
    assert!(registry.hosts.lock().unwrap().is_empty());
}

#[test]
fn failed_quiescence_or_shutdown_retains_ownership_and_can_be_retried() {
    let root = tempfile::tempdir().unwrap();
    let (registry, runtime) = fixture(root.path());
    poison_process(&runtime);
    assert!(registry.quiesce().is_err());
    assert_eq!(registry.quiescence.load(Ordering::Acquire), 0);
    assert!(!registry.shutting_down.load(Ordering::Acquire));
    assert!(registry.shutdown().is_err());
    assert!(!registry.shutting_down.load(Ordering::Acquire));
    assert!(registry.hosts.lock().unwrap().contains_key("mfa"));
    runtime.process.clear_poison();
    let quiet = registry.quiesce().unwrap();
    assert_eq!(registry.quiescence.load(Ordering::Acquire), 1);
    assert!(registry.hosts.lock().unwrap().is_empty());
    drop(quiet);
    registry.shutdown().unwrap();
    registry.shutdown().unwrap();
    assert!(registry.shutting_down.load(Ordering::Acquire));
}

#[test]
fn failed_disable_and_uninstall_preserve_metadata_and_data() {
    let root = tempfile::tempdir().unwrap();
    let (registry, runtime) = fixture(root.path());
    let data = root.path().join("mfa/data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("kept.txt"), "original plugin data").unwrap();
    poison_process(&runtime);
    assert!(registry.set_enabled("mfa", false).is_err());
    assert_eq!(registry.get("mfa").unwrap().state, LifecycleState::Enabled);
    assert!(registry.uninstall("mfa", true).is_err());
    assert_eq!(
        std::fs::read_to_string(data.join("kept.txt")).unwrap(),
        "original plugin data"
    );
    assert!(registry.hosts.lock().unwrap().contains_key("mfa"));
    runtime.process.clear_poison();
    registry.stop_host("mfa").unwrap();
}

#[test]
fn disable_waits_for_the_desktop_resource_owner() {
    use std::sync::atomic::AtomicBool;

    #[derive(Debug)]
    struct BusyResource(Arc<AtomicBool>);

    impl ModuleCleanup for BusyResource {
        fn prepare_stop(&self, slug: &str) -> Result<(), String> {
            assert_eq!(slug, "mfa");
            if self.0.load(Ordering::Acquire) {
                Err("desktop resource still active".into())
            } else {
                Ok(())
            }
        }
    }

    let root = tempfile::tempdir().unwrap();
    let (registry, _) = fixture(root.path());
    let busy = Arc::new(AtomicBool::new(true));
    let registry = registry.with_module_cleanup(BusyResource(busy.clone()));
    assert!(matches!(
        registry.set_enabled("mfa", false),
        Err(PluginError::HostRequest(message)) if message == "desktop resource still active"
    ));
    assert_eq!(registry.get("mfa").unwrap().state, LifecycleState::Enabled);
    assert!(registry.hosts.lock().unwrap().contains_key("mfa"));

    busy.store(false, Ordering::Release);
    let result = registry.set_enabled("mfa", false).unwrap();
    assert_eq!(result.state, LifecycleState::Disabled);
    assert!(registry.hosts.lock().unwrap().is_empty());
}
