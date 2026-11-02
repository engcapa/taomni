//! Generation-owned init/ready handoff for a hidden, opening overlay.
//! Pending payloads are not active overlays: repeated triggers must hit the
//! existing OPENING guard, never the active-overlay show/focus branch.

use super::OVERLAY_LABEL;
use super::model::OverlayInit;
use super::runtime::{SESSION_GENERATION, tool_state};
use super::startup_timing;
use std::sync::{OnceLock, atomic::Ordering};
use std::time::Duration;
use tauri::WebviewWindow;
use tokio::sync::watch;

#[derive(Clone, Debug, Default)]
struct Handoff {
    generation: Option<u64>,
    opening: bool,
    payload: Option<OverlayInit>,
    ready: bool,
}

impl Handoff {
    fn begin(&mut self, generation: u64) {
        *self = Self {
            generation: Some(generation),
            opening: true,
            ..Self::default()
        };
    }

    fn publish(&mut self, payload: OverlayInit) -> bool {
        if self.generation != Some(payload.generation) || !self.opening {
            return false;
        }
        self.payload = Some(payload);
        true
    }

    fn finish(&mut self, generation: u64) {
        if self.generation == Some(generation) {
            self.opening = false;
            self.payload = None;
        }
    }
}

fn channel() -> &'static watch::Sender<Handoff> {
    static CHANNEL: OnceLock<watch::Sender<Handoff>> = OnceLock::new();
    CHANNEL.get_or_init(|| watch::channel(Handoff::default()).0)
}

pub(super) fn begin_pending(generation: u64) {
    channel().send_modify(|state| state.begin(generation));
}

pub(super) fn publish(payload: OverlayInit) -> Result<(), String> {
    let mut accepted = false;
    channel().send_modify(|state| accepted = state.publish(payload));
    accepted
        .then_some(())
        .ok_or_else(|| "screenshot opening was cancelled".into())
}

pub(super) fn end_pending(generation: u64) {
    channel().send_modify(|state| state.finish(generation));
}

pub(super) fn current_generation() -> Option<u64> {
    let generation = SESSION_GENERATION.load(Ordering::SeqCst);
    let pending = channel().borrow();
    if pending.opening && pending.generation == Some(generation) {
        return Some(generation);
    }
    drop(pending);
    tool_state().overlay.as_ref().map(|init| init.generation)
}

pub(super) fn open_pending() -> bool {
    let state = channel().borrow();
    state.opening && state.generation == Some(SESSION_GENERATION.load(Ordering::SeqCst))
}

pub(super) fn is_base_image(path: &str) -> bool {
    channel()
        .borrow()
        .payload
        .as_ref()
        .is_some_and(|init| init.path == path)
        || tool_state()
            .overlay
            .as_ref()
            .is_some_and(|init| init.path == path)
}

/// Wait for the owning open, not an unrelated renderer timeout. Portal consent
/// may legitimately take minutes. Cancellation is observed from the existing
/// session generation even when no payload was ever published.
pub(super) async fn wait_for_init() -> Result<OverlayInit, String> {
    let generation = SESSION_GENERATION.load(Ordering::SeqCst);
    let mut rx = channel().subscribe();
    loop {
        if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
            return Err("screenshot opening was cancelled".into());
        }
        // Mark the revision before inspecting payload/pending together, so a
        // publication cannot be lost between two independent state reads.
        let state = rx.borrow_and_update().clone();
        if state.generation == Some(generation) && state.opening {
            if let Some(payload) = state.payload {
                return Ok(payload);
            }
        } else {
            return tool_state()
                .overlay
                .clone()
                .filter(|init| init.generation == generation)
                .ok_or_else(|| NO_PENDING_OVERLAY.to_string());
        }
        tokio::select! {
            changed = rx.changed() => if changed.is_err() { return Err(NO_PENDING_OVERLAY.into()); },
            _ = tokio::time::sleep(Duration::from_millis(50)) => {},
        }
    }
}

pub(super) const NO_PENDING_OVERLAY: &str = "no pending screenshot overlay";

pub(super) fn mark_ready(generation: u64) -> bool {
    if generation != SESSION_GENERATION.load(Ordering::SeqCst) {
        return false;
    }
    let mut accepted = false;
    channel().send_modify(|state| {
        if state.generation == Some(generation) && state.opening && state.payload.is_some() {
            state.ready = true;
            accepted = true;
        }
    });
    accepted
}

pub(super) async fn wait_ready(generation: u64, timeout: Duration) -> bool {
    let mut rx = channel().subscribe();
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
            return false;
        }
        let state = rx.borrow_and_update().clone();
        if state.generation != Some(generation) || !state.opening {
            return false;
        }
        if state.ready {
            return true;
        }
        tokio::select! {
            changed = rx.changed() => if changed.is_err() { return false; },
            _ = tokio::time::sleep_until(deadline) => return false,
            _ = tokio::time::sleep(Duration::from_millis(50)) => {},
        }
    }
}

#[tauri::command]
pub async fn screenshot_overlay_ready(
    window: WebviewWindow,
    generation: u64,
) -> Result<bool, String> {
    if window.label() != OVERLAY_LABEL {
        return Err("not the screenshot overlay".into());
    }
    let accepted = mark_ready(generation);
    if accepted {
        startup_timing::mark("ready_signal");
    }
    Ok(accepted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(generation: u64) -> OverlayInit {
        OverlayInit {
            path: "shot.png".into(),
            display_id: "0".into(),
            width: 1,
            height: 1,
            scale_factor: 1.0,
            window_region: None,
            document: false,
            source_pin: None,
            generation,
        }
    }

    #[test]
    fn payload_and_pending_are_published_atomically_and_owned_by_generation() {
        let mut state = Handoff::default();
        state.begin(7);
        assert!(!state.publish(payload(6)));
        assert!(state.payload.is_none());
        assert!(state.publish(payload(7)));
        assert_eq!(state.payload.as_ref().unwrap().generation, 7);
        assert!(state.opening);
        state.finish(6);
        assert!(state.opening);
        state.finish(7);
        assert!(!state.opening);
        assert!(state.payload.is_none());
    }

    #[test]
    fn next_open_discards_stale_payload_and_ready_state() {
        let mut state = Handoff::default();
        state.begin(7);
        assert!(state.publish(payload(7)));
        state.ready = true;
        state.begin(8);
        assert!(state.opening);
        assert!(!state.ready);
        assert!(state.payload.is_none());
        assert!(!state.publish(payload(7)));
    }
}
