//! Execute the exact vendored WebView2 script generator without starting a
//! native app. The Windows hosted HTML case still owns actual WebView2 proof.
#[path = "../../../vendor/wry/src/webview2/initialization.rs"]
mod initialization;

use initialization::{IPC_BOOTSTRAP, for_frame};
use std::io::Write;
use std::process::{Command, Stdio};

fn evaluate(script: &str, child: bool) -> serde_json::Value {
    let payload = serde_json::json!({ "script": script, "child": child });
    let mut process = Command::new("node")
        .args(["-e", r#"
const vm = require('node:vm');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => { input += part; });
process.stdin.on('end', () => {
  const config = JSON.parse(input);
  const window = { chrome: { webview: { postMessage() {} } } };
  Object.defineProperty(window, 'top', { value: config.child ? Object.freeze({}) : window, configurable: false, writable: false });
  vm.runInNewContext(config.script, { window });
  process.stdout.write(JSON.stringify({
    initialized: window.initialized === true,
    internals: typeof window.__TAURI_INTERNALS__,
    ipc: typeof window.ipc,
    shared: window.shared === true
  }));
});
"#])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node 22 is required to verify native initialization script execution");
    process
        .stdin
        .take()
        .unwrap()
        .write_all(payload.to_string().as_bytes())
        .unwrap();
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn guarded_tauri_bootstrap_runs_in_main_frame_and_never_in_opaque_child() {
    let script = for_frame(
        "Object.defineProperty(window, '__TAURI_INTERNALS__', {value: {invokeKey: 'secret'}}); window.initialized = true;".into(),
        true,
    );
    let main = evaluate(&script, false);
    assert_eq!(main["initialized"], true);
    assert_eq!(main["internals"], "object");
    let child = evaluate(&script, true);
    assert_eq!(child["initialized"], false);
    assert_eq!(child["internals"], "undefined");
}

#[test]
fn explicit_all_frame_scripts_preserve_child_execution() {
    let original = "window.shared = true;";
    let script = for_frame(original.into(), false);
    assert_eq!(script, original);
    assert_eq!(evaluate(&script, true)["shared"], true);
    assert_eq!(evaluate(&script, false)["shared"], true);
}

#[test]
fn wry_ipc_bootstrap_never_publishes_native_sender_in_child() {
    let script = for_frame(IPC_BOOTSTRAP.into(), true);
    assert_eq!(evaluate(&script, false)["ipc"], "object");
    assert_eq!(evaluate(&script, true)["ipc"], "undefined");
}

#[test]
fn webview2_uses_frame_flag_and_main_only_ipc_generator() {
    let source = include_str!("../../../vendor/wry/src/webview2/mod.rs");
    assert!(source.contains(
        "initialization::for_frame(init_script.script, init_script.for_main_frame_only)"
    ));
    assert!(
        source.contains("initialization::for_frame(initialization::IPC_BOOTSTRAP.into(), true)")
    );
}
