//! QA-only RDP probe client.
//!
//! Connects to an RDP server (Taomni's local RDP server, or a reference server
//! such as Windows TermService / xrdp), runs exactly one scenario and writes a
//! JSON report (`schema: taomni.rdp-probe.v1`) to stdout and optionally to
//! `--out`. qa-ui-auto native cases use it as the protocol-level oracle and the
//! performance meter described in `docs-feature/rdp-server-parity-design.md`
//! §4.7/§4.8. It is a test tool: it is never bundled or launched by the app.
//!
//! Exit codes: 0 scenario passed its own preconditions, 2 usage error,
//! 3 authentication rejected, 4 connection/protocol failure, 5 scenario
//! timeout or unmet observation.

mod audio;
mod audio_input;
mod clipboard;
mod host_audio;
mod scenarios;
mod session;
mod stats;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};

pub(crate) const SCHEMA: &str = "taomni.rdp-probe.v1";

/// Parsed command line: `rdp-probe <scenario> [--key value | --flag]...`.
#[derive(Debug, Default, Clone)]
pub(crate) struct Args {
    pub scenario: String,
    values: HashMap<String, String>,
}

impl Args {
    fn parse(raw: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut iter = raw.into_iter();
        let scenario = iter
            .next()
            .ok_or_else(|| "missing scenario (try `rdp-probe help`)".to_string())?;
        let mut values = HashMap::new();
        let mut pending: Option<String> = None;
        for item in iter {
            if let Some(key) = item.strip_prefix("--") {
                if let Some(previous) = pending.take() {
                    values.insert(previous, "true".to_string());
                }
                if let Some((k, v)) = key.split_once('=') {
                    values.insert(k.to_string(), v.to_string());
                } else {
                    pending = Some(key.to_string());
                }
            } else if let Some(key) = pending.take() {
                values.insert(key, item);
            } else {
                return Err(format!("unexpected positional argument: {item}"));
            }
        }
        if let Some(previous) = pending.take() {
            values.insert(previous, "true".to_string());
        }
        Ok(Self { scenario, values })
    }

    /// Arguments carrying a single option, for scenarios composed of others.
    pub fn with_value(key: &str, value: &str) -> Self {
        let mut values = HashMap::new();
        values.insert(key.to_string(), value.to_string());
        Self {
            scenario: String::new(),
            values,
        }
    }

    pub fn str(&self, key: &str, default: &str) -> String {
        self.values
            .get(key)
            .cloned()
            .unwrap_or_else(|| default.to_string())
    }

    pub fn opt(&self, key: &str) -> Option<String> {
        self.values.get(key).cloned().filter(|v| !v.is_empty())
    }

    pub fn u64(&self, key: &str, default: u64) -> Result<u64, String> {
        match self.values.get(key) {
            Some(v) => v
                .parse()
                .map_err(|_| format!("--{key} expects an unsigned integer, got {v:?}")),
            None => Ok(default),
        }
    }

    pub fn i64(&self, key: &str, default: i64) -> Result<i64, String> {
        match self.values.get(key) {
            Some(v) => v
                .parse()
                .map_err(|_| format!("--{key} expects an integer, got {v:?}")),
            None => Ok(default),
        }
    }

    pub fn f64(&self, key: &str, default: f64) -> Result<f64, String> {
        match self.values.get(key) {
            Some(v) => v
                .parse()
                .map_err(|_| format!("--{key} expects a number, got {v:?}")),
            None => Ok(default),
        }
    }

    pub fn flag(&self, key: &str) -> bool {
        self.values
            .get(key)
            .is_some_and(|v| matches!(v.as_str(), "true" | "1" | "yes" | "on"))
    }

    pub fn duration_ms(&self, key: &str, default_ms: u64) -> Result<Duration, String> {
        Ok(Duration::from_millis(self.u64(key, default_ms)?))
    }
}

/// Error raised by a scenario; the kind selects the process exit code.
#[derive(Debug)]
pub(crate) struct ProbeError {
    pub kind: ErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ErrorKind {
    Usage,
    Auth,
    Connection,
    Unmet,
}

impl ErrorKind {
    fn exit_code(self) -> i32 {
        match self {
            ErrorKind::Usage => 2,
            ErrorKind::Auth => 3,
            ErrorKind::Connection => 4,
            ErrorKind::Unmet => 5,
        }
    }

    fn label(self) -> &'static str {
        match self {
            ErrorKind::Usage => "usage",
            ErrorKind::Auth => "auth",
            ErrorKind::Connection => "connection",
            ErrorKind::Unmet => "unmet",
        }
    }
}

impl ProbeError {
    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Usage,
            message: message.into(),
        }
    }
    pub fn connection(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Connection,
            message: message.into(),
        }
    }
    pub fn unmet(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Unmet,
            message: message.into(),
        }
    }
}

impl From<String> for ProbeError {
    fn from(message: String) -> Self {
        ProbeError::usage(message)
    }
}

/// A scenario's successful result plus the partial observations an error
/// should still report (so a failed run keeps its raw samples).
pub(crate) type ScenarioResult = Result<Value, (ProbeError, Value)>;

const HELP: &str = "rdp-probe <scenario> [options]

Scenarios:
  connect            connect, receive frames for --seconds (default 5)
  latency            click (or type) on a host target and time the frame change
  throughput         count visible changes and bytes inside --rect for --seconds
  clipboard-send     announce --text/--html/--image-png/--files to the server
  clipboard-receive  fetch the server clipboard (--expect text|html|image|files)
  audio-capture      record RDPSND audio for --seconds and analyse the tone
  mic-send           send a --freq tone through the AUDIO_INPUT channel
  autodetect         record auto-detect requests and network characteristics
  host-play          play a --freq tone on a local output device (no RDP)
  host-record        record a local input device and analyse the tone (no RDP)
  image-digest       print size and RGB/RGBA SHA-256 of --png (no RDP)
  image-make         write a deterministic test picture to --out-png (no RDP)

Connection options:
  --host 127.0.0.1 --port 3389 --user NAME --password-env QA_RDP_PASSWORD
  --domain DOMAIN --width 1280 --height 720 --timeout-sec 60
  --alternate-shell CMD --work-dir DIR   (reference-server initial program)
Output:
  --out report.json   also write the JSON report to this path
  --snapshot fb.png   save the decoded framebuffer whenever the report is built";

fn main() {
    let args = match Args::parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}\n\n{HELP}");
            std::process::exit(2);
        }
    };
    if matches!(args.scenario.as_str(), "help" | "--help" | "-h") {
        println!("{HELP}");
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()
        .expect("tokio runtime");
    let started = std::time::Instant::now();
    let outcome = runtime.block_on(scenarios::run(&args));
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let (code, mut report) = match outcome {
        Ok(value) => (0, value),
        Err((error, partial)) => {
            let mut report = partial;
            if !report.is_object() {
                report = json!({});
            }
            report["error"] = json!({ "kind": error.kind.label(), "message": error.message });
            (error.kind.exit_code(), report)
        }
    };
    report["schema"] = json!(SCHEMA);
    report["scenario"] = json!(args.scenario);
    report["ok"] = json!(code == 0);
    report["elapsed_ms"] = json!(elapsed_ms);
    let text = serde_json::to_string_pretty(&report).expect("serialize report");
    if let Some(path) = args.opt("out") {
        let path = PathBuf::from(path);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(error) = std::fs::write(&path, &text) {
            eprintln!("failed to write {}: {error}", path.display());
        }
    }
    println!("{text}");
    std::process::exit(code);
}
