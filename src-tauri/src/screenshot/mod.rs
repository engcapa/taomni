//! Feishu-style system screenshot & screen recording tool.
//!
//! Captures the real OS screen on any display: fullscreen, region, scrolling
//! (auto-scroll + stitch), and video recording to GIF / MP4. Windows, macOS
//! and Linux are all supported.
//!
//! Overlay UX is static-background: [`open_overlay`] hides the app windows,
//! captures the display under the pointer, then opens a borderless overlay
//! covering that display which renders the captured PNG while the user
//! selects / annotates. Capture files are temp artifacts (see
//! `capture::temp_artifact_path`) read by the webview through
//! [`screenshot_read_file`] and deleted when the capture session ends.

pub use model::OverlayInit;

pub use model::PhysicalRegion;

pub use model::PinInit;

pub use model::RecordingFile;

pub use model::RecordingStarted;

pub use model::ScreenshotProbe;

pub(crate) use overlay_session::close_session;

pub use overlay_session::open_overlay;

pub(crate) use recording_controls::recording_ended;

pub use runtime::shutdown;

pub(crate) use runtime::stop_orphaned_capture_controls;

pub(crate) use runtime::wait_for_recovery_recording;

pub(crate) use window_lifecycle::focus_capture_window;

pub(crate) use window_lifecycle::window_builder;

mod window_lifecycle;

mod model;

mod runtime;

mod scroll_controls;

mod overlay_session;

mod pin_window;

mod recording_controls;

#[cfg(test)]
mod tests;

pub mod capture;

pub mod edit;

pub mod favorites;

pub mod ocr;

#[cfg(target_os = "macos")]
mod ocr_macos;

#[cfg(target_os = "windows")]
mod ocr_windows;

pub mod pins;

pub mod qa;

mod qa_oracle;

pub mod record;

mod recovery_file;

pub mod scroll;

pub(crate) mod scroll_input;

mod session;

pub mod shortcut;

#[cfg(target_os = "linux")]
mod surface_backend;

pub mod surfaces;

use self::overlay_session::open_overlay_with_window;

use self::overlay_session::watch_session_window;

use self::pin_window::open_pin;

use self::pin_window::open_pin_with_note;

use self::recording_controls::open_recorder_bar;

use self::recording_controls::recording_region;

use self::runtime::NATIVE_WAYLAND;

use self::runtime::OPENING;

#[cfg(all(debug_assertions, target_os = "macos"))]
use self::runtime::QA_WINDOW_HIDE_CALLS;

use self::runtime::RecordingStartGuard;

use self::runtime::SESSION_GENERATION;

use self::runtime::STARTING_RECORDING;

use self::runtime::blocking;

use self::runtime::capture_lease;

use self::runtime::internal_error;

use self::runtime::tool_state;

use self::scroll_controls::capture_control_position;

use self::scroll_controls::open_scroll_bar;

use self::scroll_controls::scroll_layout;

use self::window_lifecycle::HIDE_SETTLE;

use self::window_lifecycle::await_hidden_windows;

use self::window_lifecycle::cover_display;

use self::window_lifecycle::hide_app_windows;

use self::window_lifecycle::restore_app_windows;

use self::window_lifecycle::restore_app_windows_for_preview;

use crate::screenshot::capture::DisplayInfo;

use crate::screenshot::capture::ScreenshotFile;

use crate::screenshot::scroll::ScrollCaptureResult;

use crate::state::AppState;

use std::borrow::Cow;

use std::path::PathBuf;

use std::sync::Arc;

use std::sync::atomic::Ordering;

use std::time::Duration;

use tauri::AppHandle;

use tauri::Manager;

use tauri::WebviewWindow;

mod labels;

mod initialization;

mod capture_commands;

mod scroll_commands;

mod output_commands;

mod overlay_commands;

mod pin_commands;

mod ocr_commands;

mod recording_commands;

pub use labels::{OVERLAY_LABEL, PIN_LABEL_PREFIX, RECORDER_LABEL};

pub use initialization::init;

pub use capture_commands::{
    screenshot_capture_full, screenshot_capture_region, screenshot_list_displays, screenshot_probe,
    screenshot_read_file,
};

use capture_commands::to_file;

pub(crate) use capture_commands::{
    __cmd__screenshot_capture_full, __cmd__screenshot_capture_region,
    __cmd__screenshot_list_displays, __cmd__screenshot_probe, __cmd__screenshot_read_file,
    __tauri_command_name_screenshot_capture_full, __tauri_command_name_screenshot_capture_region,
    __tauri_command_name_screenshot_list_displays, __tauri_command_name_screenshot_probe,
    __tauri_command_name_screenshot_read_file,
};

pub use scroll_commands::{
    screenshot_scroll_capture, screenshot_scroll_plan, screenshot_scroll_status,
    screenshot_scroll_surface, screenshot_set_scroll_mode, screenshot_stop_scroll_capture,
};

pub(crate) use scroll_commands::{
    __cmd__screenshot_scroll_capture, __cmd__screenshot_scroll_plan,
    __cmd__screenshot_scroll_status, __cmd__screenshot_scroll_surface,
    __cmd__screenshot_set_scroll_mode, __cmd__screenshot_stop_scroll_capture,
    __tauri_command_name_screenshot_scroll_capture, __tauri_command_name_screenshot_scroll_plan,
    __tauri_command_name_screenshot_scroll_status, __tauri_command_name_screenshot_scroll_surface,
    __tauri_command_name_screenshot_set_scroll_mode,
    __tauri_command_name_screenshot_stop_scroll_capture,
};

pub use output_commands::{screenshot_copy_image, screenshot_save_data_url, screenshot_save_image};

use output_commands::clipboard_image;

pub(crate) use output_commands::{
    __cmd__screenshot_copy_image, __cmd__screenshot_save_data_url, __cmd__screenshot_save_image,
    __tauri_command_name_screenshot_copy_image, __tauri_command_name_screenshot_save_data_url,
    __tauri_command_name_screenshot_save_image,
};

pub use overlay_commands::{
    screenshot_close_overlay, screenshot_open_overlay, screenshot_overlay_init,
    screenshot_overlay_update, screenshot_switch_display,
};

pub(crate) use overlay_commands::{
    __cmd__screenshot_close_overlay, __cmd__screenshot_open_overlay,
    __cmd__screenshot_overlay_init, __cmd__screenshot_overlay_update,
    __cmd__screenshot_switch_display, __tauri_command_name_screenshot_close_overlay,
    __tauri_command_name_screenshot_open_overlay, __tauri_command_name_screenshot_overlay_init,
    __tauri_command_name_screenshot_overlay_update, __tauri_command_name_screenshot_switch_display,
};

pub use pin_commands::{
    screenshot_close_pin, screenshot_pin_init, screenshot_pin_to_screen, screenshot_set_pin_compact,
};

pub(crate) use pin_commands::{
    __cmd__screenshot_close_pin, __cmd__screenshot_pin_init, __cmd__screenshot_pin_to_screen,
    __cmd__screenshot_set_pin_compact, __tauri_command_name_screenshot_close_pin,
    __tauri_command_name_screenshot_pin_init, __tauri_command_name_screenshot_pin_to_screen,
    __tauri_command_name_screenshot_set_pin_compact,
};

pub use ocr_commands::{screenshot_auto_redact, screenshot_ocr};

pub(crate) use ocr_commands::{
    __cmd__screenshot_auto_redact, __cmd__screenshot_ocr,
    __tauri_command_name_screenshot_auto_redact, __tauri_command_name_screenshot_ocr,
};

pub use recording_commands::{
    screenshot_cancel_recording, screenshot_current_recording, screenshot_recording_status,
    screenshot_start_recording, screenshot_stop_recording,
};

pub(crate) use recording_commands::{
    __cmd__screenshot_cancel_recording, __cmd__screenshot_current_recording,
    __cmd__screenshot_recording_status, __cmd__screenshot_start_recording,
    __cmd__screenshot_stop_recording, __tauri_command_name_screenshot_cancel_recording,
    __tauri_command_name_screenshot_current_recording,
    __tauri_command_name_screenshot_recording_status,
    __tauri_command_name_screenshot_start_recording,
    __tauri_command_name_screenshot_stop_recording,
};
