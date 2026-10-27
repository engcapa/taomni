//! QA-only end-to-end scenarios for the screenshot tool.
//!
//! Native UI tests drive only the main window, but the screenshot tool lives
//! in other windows (overlay, recorder bar, pins). These commands run each
//! real flow end to end from the backend: they open the real windows, drive
//! their DOM with the same events a user produces, inject real OS input
//! (wheel, hotkey) and verify outputs from outside the UI (clipboard, decoded
//! files, window visibility). Artifacts are written to
//! `$RUNNER_TEMP/taomni-qa-artifacts` for CI upload.
//!
//! Every command refuses to run outside the isolated debug QA app.

mod evidence;
use evidence::*;
mod fixture;
use fixture::*;
mod capture_scenarios;
pub use capture_scenarios::*;
mod ocr_scenario;
pub use ocr_scenario::*;
mod scroll_scenarios;
pub use scroll_scenarios::*;
mod recorder_scenarios;
pub use recorder_scenarios::*;
mod input_scenarios;
pub use input_scenarios::*;
mod platform_evidence;
pub use platform_evidence::*;
#[cfg(test)]
mod tests;

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::Context;
use image::RgbaImage;
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow};

use super::capture::{self, DisplayInfo};
use super::qa_oracle;
pub mod colors;
pub mod current_window;
pub mod displays;
#[cfg(target_os = "macos")]
mod macos_save_dialog;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod path_pasteboard;
pub mod pin_arrangement;
pub mod pin_tools;
#[cfg(any(target_os = "windows", test))]
mod save_dialog_observation;
pub mod scroll_exit;
pub mod scroll_manual;
#[cfg(target_os = "linux")]
mod wayland;
#[cfg(target_os = "windows")]
mod windows_save_dialog;

/// Window label of the QA content fixture (scrollable page / animation).
pub const QA_WINDOW_LABEL: &str = "screenshot-qa-fixture";

fn ensure_qa(app: &AppHandle) -> Result<(), String> {
    if !cfg!(debug_assertions) || app.config().identifier != crate::QA_APP_ID {
        return Err("screenshot QA scenarios require the isolated QA app".into());
    }
    Ok(())
}

fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

struct ScenarioCleanup(AppHandle);

impl Drop for ScenarioCleanup {
    fn drop(&mut self) {
        close_fixture(&self.0);
        for (label, window) in self.0.webview_windows() {
            if label.starts_with(super::PIN_LABEL_PREFIX) {
                let _ = window.destroy();
            }
        }
        super::close_session(&self.0);
    }
}

// ---------------------------------------------------------------------------
// Webview scripting
// ---------------------------------------------------------------------------

static EVAL_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceFrame {
    id: u32,
    at_ms: f64,
    data_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceEvidence {
    kind: String,
    css_width: f64,
    css_height: f64,
    width: u32,
    height: u32,
    scale: f64,
    nonce: u32,
    frames: Vec<SourceFrame>,
    frame_interval_ms: Option<f64>,
    data_url: Option<String>,
}

/// Incremental evidence survives a scenario timeout or a native process crash.
struct ScenarioTrace {
    path: std::path::PathBuf,
    started: Instant,
    events: Vec<Value>,
}

impl ScenarioTrace {
    fn new(name: &str) -> Self {
        Self {
            path: evidence_path(name),
            started: Instant::now(),
            events: Vec::new(),
        }
    }

    fn mark(&mut self, phase: &str, details: Value) {
        self.events.push(
            json!({"phase":phase,"elapsedMs":self.started.elapsed().as_millis(),"details":details}),
        );
        if std::fs::create_dir_all(artifact_dir()).is_ok() {
            if let Ok(bytes) = serde_json::to_vec_pretty(&self.events) {
                let _ = std::fs::write(&self.path, bytes);
            }
        }
    }
}

// Scroll fixture rows: index i is encoded in the background as
// R = 30 + (i % 8) * 28, G = 30 + (i / 8) * 28, B = 210. Rows are 48 CSS px
// tall with a 4 px white separator.
const ROW_STEP: f64 = 28.0;

// ---------------------------------------------------------------------------
// Overlay focus, compositing and display-state evidence (SHOT-N24/N25)
// ---------------------------------------------------------------------------

/// Real X11 window id of a mapped surface; None on Wayland or other backends.
#[cfg(target_os = "linux")]
#[link(name = "gdk-3")]
unsafe extern "C" {
    fn gdk_x11_window_get_xid(window: *mut gtk::gdk::ffi::GdkWindow) -> u32;
}
