//! macOS system execution experiment; the signed harness owns the real adapter.
#![cfg(target_os = "macos")]
mod mfa_support;
mod support;

use std::time::{Duration, Instant};

fn require_hosted_experiment() {
    assert_eq!(std::env::var("GITHUB_ACTIONS").as_deref(), Ok("true"));
    assert!(matches!(
        std::env::var("TAOMNI_SYSTEM_EXECUTION_GATE").as_deref(),
        Ok("adhoc-hardened" | "fixed-hardened")
    ));
}

#[test]
#[ignore = "signed, quarantined native process experiment; GitHub macOS only"]
fn hardened_adapter_launches_the_quarantined_hello_host() {
    require_hosted_experiment();
    let mut process = support::start(support::config());
    let ping = process.invoke("hello/ping", None).unwrap();
    assert_eq!(ping["pluginId"], "taomni-plugin-hello-plugin");
    assert_eq!(ping["enabled"], true);
    process
        .stop_confirmed(Instant::now() + Duration::from_secs(5))
        .unwrap();
}

#[test]
#[ignore = "signed, quarantined native process experiment; GitHub macOS only"]
fn hardened_adapter_launches_the_quarantined_mfa_host_and_reads_real_codes() {
    require_hosted_experiment();
    let mut harness = mfa_support::Harness::new();
    harness.initialize();
    harness.add();
    assert_eq!(harness.codes()[0]["code"], "755224");
    harness
        .process
        .stop_confirmed(Instant::now() + Duration::from_secs(5))
        .unwrap();
}
