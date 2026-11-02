//! P1-1 owns only the idle selection WebView, never a capture session.
//!
//! The existing open guards and close-session ordering remain the owners of
//! capture state, restoration, artifacts and the process lease. This owner
//! replaces only the selection window's final close with hide + renderer reset.
//! Recording/scroll transfers and document editors keep their original paths.

use super::OVERLAY_LABEL;
use super::runtime::tool_state;
use super::startup_timing;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub(super) const SESSION_EVENT: &str = "screenshot://session";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Opening,
    Active,
    Closing,
    Idle,
}

#[derive(Clone, Copy, Debug)]
struct Slot {
    generation: u64,
    transparent: bool,
    phase: Phase,
}

static RESIDENT: Mutex<Option<Slot>> = Mutex::new(None);

/// Serialize hidden construction only; never holds OPENING or a session lease.
/// Prewarming and the first user trigger cannot create the same label twice.
pub(super) static WINDOW_BUILD: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    generation: u64,
    active: bool,
}

/// Called on the blocking window-builder thread, after begin_pending. A
/// renderer listener survives while idle; every active generation remounts the
/// complete overlay so selection, history, effects and cancellation are fresh.
pub(super) fn take_idle(
    app: &AppHandle,
    generation: u64,
    transparent: bool,
) -> Result<Option<WebviewWindow>, String> {
    let reusable = RESIDENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .is_some_and(|slot| slot.phase == Phase::Idle && slot.transparent == transparent);
    if !reusable {
        discard_idle(app)?;
        return Ok(None);
    }
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        forget();
        return Ok(None);
    };
    if window.is_visible().map_err(|e| e.to_string())? {
        return Err("idle screenshot window is unexpectedly visible".into());
    }
    remember(generation, transparent);
    if let Err(error) = window.emit(
        SESSION_EVENT,
        SessionEvent {
            generation,
            active: true,
        },
    ) {
        forget();
        let _ = window.close();
        return Err(format!("restart resident screenshot renderer: {error}"));
    }
    startup_timing::note("windowReused", serde_json::json!(true));
    startup_timing::mark("window_reused");
    Ok(Some(window))
}

/// The renderer subscribes first, then reads a generation snapshot. A trigger
/// that races initial listener setup cannot be lost, and an idle prewarm never
/// fetches/captures a screenshot by itself.
#[tauri::command]
pub async fn screenshot_overlay_session(
    window: WebviewWindow,
) -> Result<Option<SessionEvent>, String> {
    if window.label() != OVERLAY_LABEL {
        return Err("not the screenshot overlay".into());
    }
    let resident = *RESIDENT.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(slot) = resident {
        return Ok(match slot.phase {
            Phase::Opening | Phase::Active => Some(SessionEvent {
                generation: slot.generation,
                active: true,
            }),
            Phase::Closing | Phase::Idle => None,
        });
    }
    Ok(
        super::overlay_handoff::current_generation().map(|generation| SessionEvent {
            generation,
            active: true,
        }),
    )
}

pub(super) fn remember(generation: u64, transparent: bool) {
    *RESIDENT.lock().unwrap_or_else(|p| p.into_inner()) = Some(Slot {
        generation,
        transparent,
        phase: Phase::Opening,
    });
}

pub(super) fn remember_idle(generation: u64, transparent: bool) {
    *RESIDENT.lock().unwrap_or_else(|p| p.into_inner()) = Some(Slot {
        generation,
        transparent,
        phase: Phase::Idle,
    });
}

pub(super) fn presented(generation: u64) {
    let mut owner = RESIDENT.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(slot) = owner.as_mut().filter(|slot| slot.generation == generation) {
        slot.phase = Phase::Active;
    }
}

pub(super) fn forget() {
    *RESIDENT.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// An idle window is not an active tool surface. Native QA must additionally
/// observe its hidden state, empty renderer and released session ownership.
pub(super) fn is_idle() -> bool {
    RESIDENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .is_some_and(|slot| slot.phase == Phase::Idle)
}

/// At the existing close position, after Wayland restoration and border
/// teardown. No capture state is retained. Late reset delivery cannot unmount
/// a newer generation because the renderer rejects older generation numbers.
pub(super) fn retire(window: &WebviewWindow) -> Result<bool, String> {
    let resident = *RESIDENT.lock().unwrap_or_else(|p| p.into_inner());
    let Some(slot) = resident else {
        return Ok(false);
    };
    if slot.phase == Phase::Idle {
        return Ok(true);
    }
    // Never hold the owner mutex across native/UI dispatch. In particular the
    // synchronous session-snapshot command runs on that same event thread.
    let generation = slot.generation;
    window.hide().map_err(|e| e.to_string())?;
    window
        .emit(
            SESSION_EVENT,
            SessionEvent {
                generation,
                active: false,
            },
        )
        .map_err(|e| format!("reset resident screenshot renderer: {e}"))?;
    let mut owner = RESIDENT.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(slot) = owner.as_mut().filter(|slot| slot.generation == generation) {
        slot.phase = Phase::Idle;
    }
    Ok(true)
}

/// Only an active screenshot CloseRequested is intercepted. A recording has
/// already transferred ToolState.overlay to None; its close must still destroy
/// this surface rather than restore windows or reopen an idle overlay.
pub(super) fn intercept_close() -> Option<bool> {
    if tool_state().overlay.is_none() {
        return None;
    }
    let mut owner = RESIDENT.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(slot) = owner.as_mut().filter(|slot| slot.phase == Phase::Active) {
        slot.phase = Phase::Closing;
        Some(true)
    } else {
        // A second close event must not destroy the surface or enqueue cleanup
        // that could later retire an unrelated next session.
        owner
            .as_ref()
            .filter(|slot| slot.phase == Phase::Closing)
            .map(|_| false)
    }
}

/// Legacy mode or a pin document editor cannot inherit the resident surface.
/// Do not call while holding ToolState or the resident mutex.
pub(super) fn discard_idle(app: &AppHandle) -> Result<(), String> {
    let discard = {
        let mut owner = RESIDENT.lock().unwrap_or_else(|p| p.into_inner());
        if owner.as_ref().is_some_and(|slot| slot.phase == Phase::Idle) {
            owner.take();
            true
        } else {
            false
        }
    };
    if discard && let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
