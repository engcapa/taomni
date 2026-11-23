//! Ownership must be held by the real host, independently of its core process.
//! Compile locally; execute ignored scenarios only on GitHub hosted runners.
#[path = "support/profile_rpc.rs"]
mod profile_rpc;
mod support;

use std::{
    fs,
    time::{Duration, Instant},
};
use taomni_host_gates::host::{HostProcess, HostProcessError, HostProfileConfig};
use taomni_plugin_api::services::ProfileGeneration;
use taomni_profile_locks::{
    PluginDataLease, PluginSlug, ProfileRestoreLease, ProfileRoot, ProfileUseLease,
};

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
            serde_json::to_vec(&serde_json::json!({
                "formatVersion": 1, "generation": Self::generation()
            }))
            .unwrap(),
        )
        .unwrap();
        let data = root.path().join("plugins/hello-plugin/data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("unchanged.bin"), b"retained original\0bytes").unwrap();
        Self { root, _dir: dir }
    }

    fn generation() -> ProfileGeneration {
        ProfileGeneration::parse("a1234567-1234-1234-1234-123456789abc").unwrap()
    }

    fn owner() -> PluginSlug {
        PluginSlug::parse("hello-plugin").unwrap()
    }

    fn commands() -> Vec<String> {
        serde_json::from_value(
            serde_json::from_str::<serde_json::Value>(include_str!(
                "../../../plugins/hello-plugin/module.json"
            ))
            .unwrap()["commands"]
                .clone(),
        )
        .unwrap()
    }

    fn start(&self) -> Result<HostProcess, HostProcessError> {
        self.start_generation(Self::generation())
    }

    fn start_generation(
        &self,
        generation: ProfileGeneration,
    ) -> Result<HostProcess, HostProcessError> {
        let host = support::hello();
        HostProcess::start_profiled(
            HostProfileConfig::new(self.root.clone(), Self::owner(), generation),
            "taomni-plugin-hello-plugin",
            "0.1.0",
            &host,
            host.parent().unwrap(),
            &Self::commands(),
            &[],
            support::config(),
            None,
        )
    }

    fn assert_owned(&self) {
        assert!(ProfileRestoreLease::try_acquire(&self.root).is_err());
        assert!(PluginDataLease::try_acquire(&self.root, &Self::owner()).is_err());
        assert!(
            PluginDataLease::try_acquire(&self.root, &PluginSlug::parse("other").unwrap()).is_ok()
        );
    }

    fn assert_released(&self) {
        support::wait_for(
            || {
                ProfileRestoreLease::try_acquire(&self.root).is_ok()
                    && PluginDataLease::try_acquire(&self.root, &Self::owner()).is_ok()
            },
            "real host profile and writer leases released",
        );
    }

    fn assert_unchanged(&self) {
        let record: serde_json::Value = serde_json::from_slice(
            &fs::read(self.root.path().join(".profile-state.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            record,
            serde_json::json!({"formatVersion":1,"generation":Self::generation()})
        );
        assert_eq!(
            fs::read(
                self.root
                    .path()
                    .join("plugins/hello-plugin/data/unchanged.bin")
            )
            .unwrap(),
            b"retained original\0bytes",
        );
        assert_eq!(
            fs::read_dir(self.root.path().join("plugins/hello-plugin/data"))
                .unwrap()
                .count(),
            1
        );
    }
}

fn stop(process: &mut HostProcess) {
    process
        .stop_confirmed(Instant::now() + Duration::from_secs(5))
        .unwrap();
}

#[test]
#[ignore = "real host profile ownership: GitHub runners only"]
fn the_real_host_excludes_restore_and_duplicate_writers_after_core_lease_is_dropped() {
    let fixture = Fixture::new();
    let core = ProfileUseLease::try_acquire(&fixture.root).unwrap();
    let mut host = fixture.start().unwrap();
    assert_eq!(host.invoke("hello/ping", None).unwrap()["enabled"], true);
    drop(core);
    fixture.assert_owned();
    assert!(
        fixture.start().is_err(),
        "a second real host must not activate"
    );
    assert_eq!(host.invoke("hello/ping", None).unwrap()["enabled"], true);
    fixture.assert_owned();
    fixture.assert_unchanged();
    stop(&mut host);
    fixture.assert_released();
    fixture.assert_unchanged();
}

#[test]
#[ignore = "real host profile ownership: GitHub runners only"]
fn a_crash_releases_kernel_leases_and_restart_reacquires_the_same_profile() {
    let fixture = Fixture::new();
    let mut host = fixture.start().unwrap();
    fixture.assert_owned();
    assert!(host.invoke("hello/crash", None).is_err());
    fixture.assert_released();
    support::restart(&mut host);
    assert_eq!(host.invoke("hello/ping", None).unwrap()["enabled"], true);
    fixture.assert_owned();
    fixture.assert_unchanged();
    stop(&mut host);
    fixture.assert_released();
}

#[test]
#[ignore = "real host profile ownership: GitHub runners only"]
fn a_preexisting_writer_prevents_activation_and_can_retry_after_release() {
    let fixture = Fixture::new();
    let writer = PluginDataLease::try_acquire(&fixture.root, &Fixture::owner()).unwrap();
    assert!(fixture.start().is_err());
    assert!(PluginDataLease::try_acquire(&fixture.root, &Fixture::owner()).is_err());
    assert!(ProfileRestoreLease::try_acquire(&fixture.root).is_ok());
    fixture.assert_unchanged();
    drop(writer);
    let mut host = fixture.start().unwrap();
    fixture.assert_owned();
    stop(&mut host);
    fixture.assert_released();
    fixture.assert_unchanged();
}

#[test]
#[ignore = "real host profile ownership: GitHub runners only"]
fn restore_ownership_and_stale_generations_cannot_activate_or_change_business_data() {
    let fixture = Fixture::new();
    let restore = ProfileRestoreLease::try_acquire(&fixture.root).unwrap();
    assert!(fixture.start().is_err());
    fixture.assert_unchanged();
    drop(restore);
    let stale = ProfileGeneration::parse("b1234567-1234-1234-1234-123456789abc").unwrap();
    assert!(fixture.start_generation(stale).is_err());
    fixture.assert_released();
    fixture.assert_unchanged();
    let mut host = fixture.start().unwrap();
    fixture.assert_owned();
    stop(&mut host);
    fixture.assert_released();
}

#[test]
#[ignore = "real host profile ownership: GitHub runners only"]
fn a_legacy_host_without_profile_ack_is_reaped_before_any_enable_hook() {
    let fixture = Fixture::new();
    fs::write(fixture.root.path().join("activation.mode"), "accept").unwrap();
    let result = HostProcess::start_profiled(
        HostProfileConfig::new(
            fixture.root.clone(),
            PluginSlug::parse("activation-fixture").unwrap(),
            Fixture::generation(),
        ),
        "taomni-plugin-activation-fixture",
        "0.1.0",
        std::path::Path::new(env!("CARGO_BIN_EXE_host-gate-activation")),
        fixture.root.path(),
        &["plugin/enable".into(), "fixture/probe".into()],
        &[],
        support::config(),
        None,
    );
    assert!(matches!(result, Err(HostProcessError::Handshake(_))));
    assert_eq!(
        fs::read_to_string(fixture.root.path().join("activation.events")).unwrap(),
        "plugin/handshake\n"
    );
    let pid = fs::read_to_string(fixture.root.path().join("activation.pid"))
        .unwrap()
        .parse()
        .unwrap();
    support::wait_for(
        || !support::process_alive(pid),
        "host missing profile ack is terminated",
    );
    fixture.assert_released();
    fixture.assert_unchanged();
}
