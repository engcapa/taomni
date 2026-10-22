use super::lifetime::LaunchedCaptureHandle;
use super::limits::LAUNCHER_BYTES;
use super::model::LaunchedAppPhase;
use super::preparation::materialize_launcher;
use super::preparation::prepare_launch;
use super::preparation::resolve_executable;
use crate::sockscap::config::AppLaunchPreparation;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;

use crate::sockscap::config::{AppLaunchShell, RuleMode, ScopeMode, UpstreamKind};
use crate::sockscap::helper::HelperRegistry;
use crate::sockscap::relay::{RelayContext, ResolvedUpstream};
use crate::sockscap::rules::dns_map::DnsMap;
use crate::sockscap::stats::{DomainTracker, StatsCounters};

struct RootlessTestCapture {
    capture: LaunchedCaptureHandle,
    profile_id: String,
    stats: Arc<StatsCounters>,
    directory: tempfile::TempDir,
}

async fn start_rootless_test_capture() -> RootlessTestCapture {
    let proxy = std::env::var("TAOMNI_TEST_HTTP_PROXY")
        .expect("set TAOMNI_TEST_HTTP_PROXY, for example http://127.0.0.1:31128");
    let proxy = url::Url::parse(&proxy).expect("parse TAOMNI_TEST_HTTP_PROXY");
    assert_eq!(proxy.scheme(), "http");
    let proxy_host = proxy.host_str().unwrap().to_string();
    let proxy_port = proxy.port_or_known_default().unwrap();

    let mut config = crate::sockscap::config::SocksCapConfig::default();
    let profile = &mut config.profiles[0];
    profile.mode = ScopeMode::Apps;
    profile.rule_mode = RuleMode::ProxyAll;
    profile.upstream.kind = UpstreamKind::Http;
    profile.upstream.host = proxy_host.clone();
    profile.upstream.port = proxy_port;
    let profile_id = profile.id.clone();
    config.active_profile_ids = vec![profile_id.clone()];

    let stats = Arc::new(StatsCounters::default());
    let mut profile_upstreams = HashMap::new();
    profile_upstreams.insert(
        profile_id.clone(),
        ResolvedUpstream {
            kind: UpstreamKind::Http,
            host: proxy_host.clone(),
            port: proxy_port,
            user: String::new(),
            pass: String::new(),
            ssh_pool: None,
            xray_port: None,
        },
    );
    let context = Arc::new(RwLock::new(RelayContext {
        engine: RelayContext::build_engine(&config, None),
        config,
        rules: None,
        helper: Arc::new(HelperRegistry::new()),
        helper_client: None,
        stats: Arc::clone(&stats),
        upstream_host: proxy_host,
        upstream_port: proxy_port,
        upstream_user: String::new(),
        upstream_pass: String::new(),
        self_pid: std::process::id(),
        ssh_pool: None,
        xray_port: None,
        profile_upstreams,
        dns_map: Arc::new(Mutex::new(DnsMap::new(64, Duration::from_secs(60)))),
        domains: Arc::new(Mutex::new(DomainTracker::new(32))),
    }));

    let directory = tempfile::tempdir().unwrap();
    let capture = LaunchedCaptureHandle::start(context, directory.path())
        .await
        .expect("start ptrace/seccomp capture");
    RootlessTestCapture {
        capture,
        profile_id,
        stats,
        directory,
    }
}

async fn wait_for_text(path: &Path, expected: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if fs::read_to_string(path)
            .ok()
            .is_some_and(|body| body.contains(expected))
        {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {} to contain {expected:?}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn wait_for_nonempty_file(path: &Path) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if fs::metadata(path).is_ok_and(|metadata| metadata.len() > 0) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn wait_for_chrome_window(user_data: &Path) -> xcap::Window {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let user_data = user_data.to_string_lossy();
    loop {
        for window in xcap::Window::all().expect("enumerate X11 windows") {
            let Ok(pid) = window.pid() else {
                continue;
            };
            let command_line = fs::read(format!("/proc/{pid}/cmdline"))
                .ok()
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
            if command_line
                .as_deref()
                .is_some_and(|value| value.contains(user_data.as_ref()))
            {
                return window;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for a Chrome X11 window using {user_data}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn window_is_not_black(window: &xcap::Window) -> bool {
    let image = window.capture_image().expect("capture Chrome X11 window");
    let bright_pixels = image
        .pixels()
        .filter(|pixel| pixel.0[..3].iter().any(|channel| *channel > 32))
        .count();
    bright_pixels * 20 > image.width() as usize * image.height() as usize
}

async fn wait_for_window_rendered(window: &xcap::Window) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !window_is_not_black(window) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for Chrome to render its first X11 frame"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn assert_window_is_not_black(window: &xcap::Window) {
    assert!(
        window_is_not_black(window),
        "Chrome X11 window became black after ptrace/seccomp capture"
    );
}

fn curl_arguments(output: &Path) -> Vec<String> {
    vec![
        "--noproxy".into(),
        "*".into(),
        "--silent".into(),
        "--show-error".into(),
        "--max-time".into(),
        "20".into(),
        "--output".into(),
        output.to_string_lossy().into_owned(),
        "http://example.com/".into(),
    ]
}

#[test]
fn materialized_launcher_is_private_and_stable() {
    let directory = tempfile::tempdir().unwrap();
    let first = materialize_launcher(directory.path()).unwrap();
    let second = materialize_launcher(directory.path()).unwrap();
    assert_eq!(first, second);
    assert_eq!(fs::read(&first).unwrap(), LAUNCHER_BYTES);
    assert_eq!(
        fs::metadata(&first).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn resolves_launch_commands_through_path() {
    let executable = resolve_executable("sh").unwrap();
    assert!(executable.is_absolute());
    assert!(fs::metadata(executable).unwrap().permissions().mode() & 0o111 != 0);
}

#[test]
fn prepared_launch_preserves_cwd_environment_and_literal_arguments() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("prepared-target");
    let output = directory.path().join("prepared-output");
    fs::write(
        &target,
        r#"#!/bin/sh
printf '%s\n%s\n%s\n%s\n' "$PWD" "$STRUCTURED_ENV" "$PRE_COMMAND_ENV" "$1" > "$2"
"#,
    )
    .unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();

    let mut preparation = AppLaunchPreparation {
        working_directory: directory.path().to_string_lossy().into_owned(),
        pre_command: "export PRE_COMMAND_ENV='prepared value'".into(),
        shell: AppLaunchShell::Sh,
        ..Default::default()
    };
    preparation
        .environment
        .insert("STRUCTURED_ENV".into(), "literal $value".into());
    let launch = prepare_launch(
        "./prepared-target",
        &[
            "argument with spaces; not a command".into(),
            output.to_string_lossy().into_owned(),
        ],
        &preparation,
    )
    .unwrap();
    let status = Command::new(launch.executable)
        .args(launch.args)
        .current_dir(launch.working_directory.unwrap())
        .envs(launch.environment)
        .status()
        .unwrap();
    assert!(status.success());
    assert_eq!(
        fs::read_to_string(output).unwrap(),
        format!(
            "{}\nliteral $value\nprepared value\nargument with spaces; not a command\n",
            directory.path().display()
        )
    );
}

#[test]
fn failed_preparation_does_not_execute_target() {
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("must-not-exist");
    let preparation = AppLaunchPreparation {
        working_directory: directory.path().to_string_lossy().into_owned(),
        pre_command: "false".into(),
        ..Default::default()
    };
    let launch = prepare_launch(
        "sh",
        &[
            "-c".into(),
            "printf unexpected > \"$1\"".into(),
            "prepared-target".into(),
            output.to_string_lossy().into_owned(),
        ],
        &preparation,
    )
    .unwrap();
    let status = Command::new(launch.executable)
        .args(launch.args)
        .current_dir(launch.working_directory.unwrap())
        .envs(launch.environment)
        .status()
        .unwrap();
    assert!(!status.success());
    assert!(!output.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires TAOMNI_TEST_HTTP_PROXY and unprivileged ptrace/seccomp"]
async fn rootless_capture_routes_curl_through_http_upstream() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_test_writer()
        .try_init();
    let mut harness = start_rootless_test_capture().await;
    let output = harness.directory.path().join("example.html");
    let launched = harness
        .capture
        .launch_app(
            &harness.profile_id,
            "curl",
            &curl_arguments(&output),
            &AppLaunchPreparation::default(),
        )
        .await
        .expect("launch curl under rootless capture");
    wait_for_text(&output, "Example Domain").await;
    eprintln!(
        "rootless apps={:?}, stats={:?}",
        harness.capture.apps(),
        harness.stats.snapshot()
    );
    assert!(harness.stats.snapshot().flows_proxy >= 1);
    assert_eq!(harness.stats.snapshot().flow_failures, 0);
    harness.capture.stop_app(launched.pid).await.unwrap();
    harness.capture.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires TAOMNI_TEST_HTTP_PROXY, curl, and unprivileged ptrace/seccomp"]
async fn rootless_capture_prepares_desktop_and_terminal_applications() {
    let mut harness = start_rootless_test_capture().await;
    let working_directory = harness.directory.path().join("prepared-app");
    fs::create_dir(&working_directory).unwrap();
    let target = working_directory.join("prepared-client");
    fs::write(
        &target,
        r#"#!/bin/sh
set -eu
[ "$STRUCTURED_ENV" = "literal value" ]
[ "$PRE_COMMAND_ENV" = "prepared value" ]
[ "$PWD" = "$EXPECTED_CWD" ]
printf 'TAOMNI_PREPARATION_READY\n'
exec curl --noproxy '*' --silent --show-error --max-time 20 --output "$1" http://example.com/
"#,
    )
    .unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();

    let mut preparation = AppLaunchPreparation {
        working_directory: working_directory.to_string_lossy().into_owned(),
        pre_command: "export PRE_COMMAND_ENV='prepared value'".into(),
        ..Default::default()
    };
    preparation
        .environment
        .insert("STRUCTURED_ENV".into(), "literal value".into());
    preparation.environment.insert(
        "EXPECTED_CWD".into(),
        working_directory.to_string_lossy().into_owned(),
    );

    let desktop_output = harness.directory.path().join("prepared-desktop.html");
    let desktop = harness
        .capture
        .launch_app(
            &harness.profile_id,
            "./prepared-client",
            &[desktop_output.to_string_lossy().into_owned()],
            &preparation,
        )
        .await
        .expect("launch prepared desktop application");
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if harness
                .capture
                .apps()
                .into_iter()
                .find(|application| application.pid == desktop.pid)
                .is_some_and(|application| application.phase == LaunchedAppPhase::Running)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("prepared target exec should be observable");
    wait_for_text(&desktop_output, "Example Domain").await;
    harness.capture.stop_app(desktop.pid).await.unwrap();

    let failed_output = harness.directory.path().join("must-not-launch");
    let failed_preparation = AppLaunchPreparation {
        working_directory: working_directory.to_string_lossy().into_owned(),
        pre_command: "false".into(),
        ..Default::default()
    };
    let failed = harness
        .capture
        .launch_app(
            &harness.profile_id,
            "sh",
            &[
                "-c".into(),
                "printf unexpected > \"$1\"".into(),
                "prepared-target".into(),
                failed_output.to_string_lossy().into_owned(),
            ],
            &failed_preparation,
        )
        .await
        .expect("register failed preparation launch");
    let failed_status = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(application) = harness
                .capture
                .apps()
                .into_iter()
                .find(|application| application.pid == failed.pid)
                && application.phase == LaunchedAppPhase::Failed
            {
                break application;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("failed preparation should be observable");
    assert!(!failed_status.running);
    assert!(
        failed_status
            .launch_error
            .as_deref()
            .is_some_and(|error| error.contains("status 1"))
    );
    assert!(!failed_output.exists());

    let terminal_output = harness.directory.path().join("prepared-terminal.html");
    let (terminal, _handle, mut reader) = harness
        .capture
        .launch_terminal_app(
            &harness.profile_id,
            "./prepared-client",
            &[terminal_output.to_string_lossy().into_owned()],
            &preparation,
            "rootless-prepared-terminal",
            80,
            24,
        )
        .expect("launch prepared terminal application");
    let reader_task = tokio::task::spawn_blocking(move || {
        let mut output = String::new();
        let _ = reader.read_to_string(&mut output);
        output
    });
    wait_for_text(&terminal_output, "Example Domain").await;
    let terminal_text = tokio::time::timeout(Duration::from_secs(5), reader_task)
        .await
        .expect("prepared terminal reader should observe exit")
        .expect("prepared terminal reader should not panic");
    assert!(terminal_text.contains("TAOMNI_PREPARATION_READY"));
    assert!(harness.stats.snapshot().flows_proxy >= 2);
    assert_eq!(harness.stats.snapshot().flow_failures, 0);
    harness.capture.stop_app(terminal.pid).await.unwrap();
    harness.capture.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires TAOMNI_TEST_HTTP_PROXY, curl, and unprivileged ptrace/seccomp"]
async fn rootless_capture_follows_shell_children_and_terminal_apps() {
    let mut harness = start_rootless_test_capture().await;
    let concurrent = harness.directory.path().join("concurrent");
    fs::create_dir(&concurrent).unwrap();
    let script = r#"set -eu
for name in one two three four; do
  curl --noproxy '*' --silent --show-error --max-time 20 --output "$1/$name.html" http://example.com/ &
done
wait"#;
    let arguments = vec![
        "-c".into(),
        script.into(),
        "taomni-sockscap-test".into(),
        concurrent.to_string_lossy().into_owned(),
    ];
    let shell = harness
        .capture
        .launch_app(
            &harness.profile_id,
            "sh",
            &arguments,
            &AppLaunchPreparation::default(),
        )
        .await
        .expect("launch shell process tree under rootless capture");
    for name in ["one", "two", "three", "four"] {
        wait_for_text(&concurrent.join(format!("{name}.html")), "Example Domain").await;
    }
    assert!(harness.stats.snapshot().flows_proxy >= 4);
    harness.capture.stop_app(shell.pid).await.unwrap();

    let terminal_output = harness.directory.path().join("terminal.html");
    let terminal_script = "printf 'TAOMNI_PTY_READY\\n'; exec curl --noproxy '*' --silent --show-error --max-time 20 --output \"$1\" http://example.com/";
    let terminal_arguments = vec![
        "-c".into(),
        terminal_script.into(),
        "taomni-sockscap-test".into(),
        terminal_output.to_string_lossy().into_owned(),
    ];
    let (terminal, _handle, mut reader) = harness
        .capture
        .launch_terminal_app(
            &harness.profile_id,
            "sh",
            &terminal_arguments,
            &AppLaunchPreparation::default(),
            "rootless-test-terminal",
            80,
            24,
        )
        .expect("launch PTY application under rootless capture");
    let reader_task = tokio::task::spawn_blocking(move || {
        let mut output = String::new();
        let _ = reader.read_to_string(&mut output);
        output
    });
    wait_for_text(&terminal_output, "Example Domain").await;
    let terminal_text = tokio::time::timeout(Duration::from_secs(5), reader_task)
        .await
        .expect("PTY reader should observe application exit")
        .expect("PTY reader task should not panic");
    assert!(terminal_text.contains("TAOMNI_PTY_READY"));
    assert!(harness.stats.snapshot().flows_proxy >= 5);
    assert_eq!(harness.stats.snapshot().flow_failures, 0);
    harness.capture.stop_app(terminal.pid).await.unwrap();
    harness.capture.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires TAOMNI_TEST_HTTP_PROXY, Go, and unprivileged ptrace/seccomp"]
async fn rootless_capture_routes_static_go_direct_syscalls() {
    let go = std::env::var_os("TAOMNI_TEST_GO")
        .map(PathBuf::from)
        .or_else(|| which::which("go").ok())
        .expect("set TAOMNI_TEST_GO to a Go executable");
    let build_directory = tempfile::tempdir().unwrap();
    let source = build_directory.path().join("direct.go");
    let executable = build_directory.path().join("direct-client");
    fs::write(
        &source,
        r#"package main

import (
    "io"
    "net"
    "net/http"
    "os"
    "time"
)

func main() {
    transport := &http.Transport{
        Proxy: nil,
        DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
    }
    client := &http.Client{Transport: transport, Timeout: 20 * time.Second}
    response, err := client.Get("http://example.com/")
    if err != nil {
        panic(err)
    }
    defer response.Body.Close()
    body, err := io.ReadAll(response.Body)
    if err != nil {
        panic(err)
    }
    if err := os.WriteFile(os.Args[1], body, 0600); err != nil {
        panic(err)
    }
}
"#,
    )
    .unwrap();
    let build = Command::new(go)
        .env("CGO_ENABLED", "0")
        .arg("build")
        .arg("-trimpath")
        .arg("-o")
        .arg(&executable)
        .arg(&source)
        .output()
        .expect("run go build");
    assert!(
        build.status.success(),
        "go build failed: {}",
        String::from_utf8_lossy(&build.stderr)
    );

    let mut harness = start_rootless_test_capture().await;
    let output = harness.directory.path().join("go-example.html");
    let launched = harness
        .capture
        .launch_app(
            &harness.profile_id,
            executable.to_str().unwrap(),
            &[output.to_string_lossy().into_owned()],
            &AppLaunchPreparation::default(),
        )
        .await
        .expect("launch static Go client under rootless capture");
    wait_for_text(&output, "Example Domain").await;
    assert!(harness.stats.snapshot().flows_proxy >= 1);
    assert_eq!(harness.stats.snapshot().flow_failures, 0);
    harness.capture.stop_app(launched.pid).await.unwrap();
    harness.capture.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires TAOMNI_TEST_HTTP_PROXY, Chrome/Chromium, and unprivileged ptrace/seccomp"]
async fn rootless_capture_supports_chromium_process_tree() {
    let chrome = std::env::var_os("TAOMNI_TEST_CHROME")
        .map(PathBuf::from)
        .or_else(|| {
            ["google-chrome", "chromium", "chromium-browser"]
                .into_iter()
                .find_map(|command| which::which(command).ok())
        })
        .expect("set TAOMNI_TEST_CHROME to Chrome or Chromium");
    let mut harness = start_rootless_test_capture().await;
    let user_data = harness.directory.path().join("chrome-profile");
    let screenshot = harness.directory.path().join("example.png");
    let mut arguments = vec![
        "--headless=new".into(),
        "--disable-background-networking".into(),
        "--disable-component-update".into(),
        "--disable-default-apps".into(),
        "--disable-dev-shm-usage".into(),
        "--disable-gpu".into(),
        "--disable-sync".into(),
        "--metrics-recording-only".into(),
        "--no-first-run".into(),
        "--no-proxy-server".into(),
        "--window-size=800,600".into(),
        format!("--user-data-dir={}", user_data.display()),
        format!("--screenshot={}", screenshot.display()),
        "http://example.com/".into(),
    ];
    if unsafe { libc::geteuid() } == 0 {
        arguments.push("--no-sandbox".into());
    }
    let preparation = AppLaunchPreparation {
        pre_command: "export TAOMNI_SOCKSCAP_PREPARED=1".into(),
        ..Default::default()
    };
    let launched = harness
        .capture
        .launch_app(
            &harness.profile_id,
            chrome.to_str().unwrap(),
            &arguments,
            &preparation,
        )
        .await
        .expect("launch Chromium under rootless capture");
    wait_for_nonempty_file(&screenshot).await;
    assert!(harness.stats.snapshot().flows_proxy >= 1);
    assert_eq!(harness.stats.snapshot().flow_failures, 0);
    harness.capture.stop_app(launched.pid).await.unwrap();
    harness.capture.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires TAOMNI_TEST_HTTP_PROXY, TAOMNI_TEST_CHROME, X11, and unprivileged ptrace/seccomp"]
async fn rootless_capture_keeps_chromium_desktop_rendering() {
    let chrome = std::env::var_os("TAOMNI_TEST_CHROME")
        .map(PathBuf::from)
        .expect("set TAOMNI_TEST_CHROME to Chrome or Chromium");
    assert!(std::env::var_os("DISPLAY").is_some(), "set DISPLAY to X11");
    let mut harness = start_rootless_test_capture().await;
    let user_data = harness.directory.path().join("chrome-desktop-profile");
    let arguments = vec![
        "--disable-component-update".into(),
        "--disable-default-apps".into(),
        "--disable-dev-shm-usage".into(),
        "--disable-sync".into(),
        "--metrics-recording-only".into(),
        "--no-first-run".into(),
        "--no-proxy-server".into(),
        "--window-size=960,720".into(),
        format!("--user-data-dir={}", user_data.display()),
        "http://example.com/".into(),
    ];
    let preparation = AppLaunchPreparation {
        pre_command: "export TAOMNI_SOCKSCAP_PREPARED=1".into(),
        ..Default::default()
    };
    let launched = harness
        .capture
        .launch_app(
            &harness.profile_id,
            chrome.to_str().unwrap(),
            &arguments,
            &preparation,
        )
        .await
        .expect("launch desktop Chromium under rootless capture");
    let window = wait_for_chrome_window(&user_data).await;
    wait_for_window_rendered(&window).await;

    tokio::time::sleep(Duration::from_secs(25)).await;
    assert_window_is_not_black(&window);
    assert!(harness.stats.snapshot().flows_proxy >= 1);

    harness.capture.stop_app(launched.pid).await.unwrap();
    harness.capture.stop().await;
}
use std::os::unix::fs::PermissionsExt;
