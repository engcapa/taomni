//! Actual execution from LocalAppData with a read-back Internet-zone ADS.
#![cfg(windows)]
mod mfa_support;
mod support;

use std::path::Path;
use std::time::{Duration, Instant};

fn require_download_mark(path: &Path) {
    assert_eq!(std::env::var("GITHUB_ACTIONS").as_deref(), Ok("true"));
    assert_eq!(
        std::env::var("TAOMNI_WINDOWS_SYSTEM_EXECUTION_GATE").as_deref(),
        Ok("zone-identifier-unsigned")
    );
    let local_data = std::fs::canonicalize(std::env::var_os("LOCALAPPDATA").unwrap()).unwrap();
    assert!(std::fs::canonicalize(path).unwrap().starts_with(local_data));
    let mut stream = path.as_os_str().to_os_string();
    stream.push(":Zone.Identifier");
    let mark = std::fs::read_to_string(stream).expect("actual Internet-zone ADS");
    assert!(mark.lines().any(|line| line == "[ZoneTransfer]"));
    assert!(mark.lines().any(|line| line == "ZoneId=3"));
}

#[test]
#[ignore = "actual Windows protection/process experiment; disposable GitHub only"]
fn adapter_launches_download_marked_unsigned_hello_and_confirms_exit() {
    require_download_mark(&support::hello());
    let mut process = support::start(support::config());
    let ping = process.invoke("hello/ping", None).unwrap();
    assert_eq!(ping["pluginId"], "taomni-plugin-hello-plugin");
    assert_eq!(ping["enabled"], true);
    process
        .stop_confirmed(Instant::now() + Duration::from_secs(5))
        .unwrap();
}

#[test]
#[ignore = "actual Windows protection/process experiment; disposable GitHub only"]
fn adapter_launches_download_marked_unsigned_mfa_and_reads_real_codes() {
    let executable = std::path::PathBuf::from(std::env::var_os("TAOMNI_MFA_PLUGIN_BIN").unwrap());
    require_download_mark(&executable);
    let mut harness = mfa_support::Harness::with_executable(&executable);
    harness.initialize();
    harness.add();
    assert_eq!(harness.codes()[0]["code"], "755224");
    harness
        .process
        .stop_confirmed(Instant::now() + Duration::from_secs(5))
        .unwrap();
}
