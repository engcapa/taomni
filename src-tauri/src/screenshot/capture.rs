//! Display model, still capture and frame sources for the screenshot tool.
//!
//! Displays come from Tauri's monitor API, so every coordinate the tool
//! exchanges uses Tauri's per-monitor physical coordinates. On Linux, convert
//! those coordinates back to GDK logical geometry for portal/GTK monitor lookup.
//! Capture backends:
//!
//! - Windows / macOS stills: `xcap::Monitor::capture_image` (one shot).
//! - Linux stills: the RDP server's X11 SHM / Wayland portal capturer, which
//!   crops the X11 virtual desktop, or selects the target Wayland monitor stream.
//! - macOS recording: one-shot CoreGraphics snapshots, avoiding the display
//!   stream / selective-sharing path implicated in a macOS 14 WindowServer
//!   crash on a VMware display. Both GIF and MP4 use this compatibility path.
//! - Windows / Linux recording: the RDP server's persistent [`Capturer`]
//!   (WGC on Windows, X11/PipeWire on Linux)
//!   through [`FrameSource`], so the backend is not re-initialised per frame.
//!   A backend that fails to start falls back to one-shot capture.
//!
//! Temp artifacts live in a per-process directory that is only served back
//! to the UI through [`ensure_artifact_path`]-guarded commands.

#[cfg(target_os = "macos")]
#[path = "mac_snapshot.rs"]
mod mac_snapshot;

use std::path::{Path, PathBuf};

use std::sync::{Mutex, OnceLock};

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Context;

use image::RgbaImage;

use serde::Serialize;

use tauri::{AppHandle, Manager};

use crate::servers::rdp::capture::{Capturer, Frame};

mod displays;

mod artifacts;

mod permissions;

mod snapshot;

mod pixels;

mod source;

mod frames;

#[cfg(test)]
mod tests;

pub use displays::{DisplayInfo, display_at_cursor, list_displays, resolve_display};

#[cfg(target_os = "linux")]
pub(super) use displays::display_for_window;

use displays::{fallback_displays, native_display_id, primary_of, read_displays};

#[cfg(not(target_os = "linux"))]
use displays::xcap_monitor_for;

pub use artifacts::{
    ScreenshotFile, artifact_dir, ensure_artifact_path, purge_stale_artifacts, purge_tracked,
    save_png, temp_artifact_path, untracked_artifact_path,
};

pub(super) use artifacts::untrack_artifact;

use artifacts::{STALE_ARTIFACT_AGE, TRACKED, artifact_root, tracked};

pub(super) use permissions::{ensure_capture_permission, request_capture_permission};

#[cfg(all(debug_assertions, target_os = "macos"))]
pub(super) use permissions::QaPermissionDenial;

#[cfg(target_os = "macos")]
pub(super) use permissions::capture_permission_granted;

#[cfg(all(debug_assertions, target_os = "macos"))]
use permissions::QA_DENY_CAPTURE;

pub use snapshot::capture_display;

use snapshot::capture_one_shot;

#[cfg(target_os = "linux")]
use snapshot::wayland_monitor_capture;

#[cfg(target_os = "linux")]
use snapshot::crop_desktop_to_display;

pub use pixels::{clamp_region, crop, map_region};

pub(crate) use pixels::frame_to_rgba;

use pixels::frame_region_to_rgba;

pub use source::FrameSource;

#[cfg(all(debug_assertions, target_os = "macos"))]
pub(super) use source::qa_source_counts;

use source::Backend;

#[cfg(all(debug_assertions, target_os = "macos"))]
use source::QA_STREAM_OPENS;

#[cfg(all(debug_assertions, target_os = "macos"))]
use source::QA_SNAPSHOT_READS;
