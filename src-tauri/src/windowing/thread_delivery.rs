//! Window-scoped delivery for agent approval and side-effect events (issue #869).
//!
//! The Claude Code and ACP bridges used `AppHandle::emit`, which reaches every
//! webview. Every window that mounts `CcAgentBridge` (the main window and any
//! detached terminal/RDP/database window) therefore rendered its own copy of the
//! same approval card, and the `agent-cc-tool` side-effect could run twice.
//!
//! A chat turn is started by exactly one webview (`chat_stream` / `chat_send`
//! receive the calling `WebviewWindow`), so we remember `thread_id -> window
//! label` and deliver thread-scoped events to that window only. The broadcast is
//! kept as a fallback whenever the recorded owner is gone: showing an approval in
//! more than one place is bad, losing it is worse.
//!
//! Payloads delivered to a specific window carry a `windowLabel` field so the
//! receiving bridge can reject an event that was not addressed to it. The field
//! is absent on broadcast fallbacks, where every window must still be able to
//! act.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Emitter;
use tauri::Manager;

/// Payload key carrying the addressed window label.
pub(crate) const WINDOW_LABEL_FIELD: &str = "windowLabel";

/// Where a thread-scoped event was delivered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Delivery {
    /// Delivered to the webview with this label.
    Target(String),
    /// Delivered to every webview because the recorded owner is gone or was
    /// never known.
    Broadcast,
}

impl Delivery {
    /// The addressed label, or `None` for a broadcast.
    pub(crate) fn label(&self) -> Option<&str> {
        match self {
            Self::Target(label) => Some(label),
            Self::Broadcast => None,
        }
    }
}

/// Registry of `thread_id -> owning window label`.
///
/// It only remembers the *last* window that started a turn for a thread. That is
/// the window whose Tao chat surface is driving the thread, so it is the one the
/// approval belongs to.
#[derive(Debug, Default)]
pub(crate) struct ThreadWindows {
    owners: Mutex<HashMap<String, String>>,
}

impl ThreadWindows {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Remember that `label` is the window currently driving `thread_id`.
    pub(crate) fn record(&self, thread_id: &str, label: &str) {
        if thread_id.is_empty() || label.is_empty() {
            return;
        }
        let mut owners = self.owners.lock().unwrap_or_else(|e| e.into_inner());
        owners.insert(thread_id.to_string(), label.to_string());
    }

    /// Window label currently driving `thread_id`, if one was recorded.
    pub(crate) fn owner(&self, thread_id: &str) -> Option<String> {
        self.owners
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(thread_id)
            .cloned()
    }

    /// Drop any owner recorded for `thread_id`.
    pub(crate) fn forget(&self, thread_id: &str) {
        self.owners
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(thread_id);
    }

    /// Drop the owner only when it is still `label`, so a delayed teardown or
    /// fallback cannot delete a newer owner recorded by another window.
    pub(crate) fn forget_owner(&self, thread_id: &str, label: &str) {
        let mut owners = self.owners.lock().unwrap_or_else(|e| e.into_inner());
        if owners.get(thread_id).is_some_and(|owner| owner == label) {
            owners.remove(thread_id);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.owners.lock().unwrap().len()
    }
}

/// The event surface a thread-scoped event needs. Implemented for `AppHandle`;
/// unit tests substitute a recording fake so targeting and fallback are
/// observable without launching a Tauri application.
pub(crate) trait EventBus {
    /// Whether a webview with this label still exists.
    fn has_webview(&self, label: &str) -> bool;
    /// Deliver to one webview. Returns false when the delivery failed.
    fn emit_to_label(&self, label: &str, event: &str, payload: Value) -> bool;
    /// Deliver to every webview. Returns false when the delivery failed.
    fn emit_all(&self, event: &str, payload: Value) -> bool;
}

impl<R: tauri::Runtime> EventBus for tauri::AppHandle<R> {
    fn has_webview(&self, label: &str) -> bool {
        self.get_webview_window(label).is_some()
    }

    fn emit_to_label(&self, label: &str, event: &str, payload: Value) -> bool {
        self.emit_to(tauri::EventTarget::labeled(label), event, payload)
            .is_ok()
    }

    fn emit_all(&self, event: &str, payload: Value) -> bool {
        self.emit(event, payload).is_ok()
    }
}

/// Where an event for `thread_id` would be delivered right now.
pub(crate) fn plan_delivery<B: EventBus + ?Sized>(
    bus: &B,
    windows: &ThreadWindows,
    thread_id: &str,
) -> Delivery {
    match windows.owner(thread_id) {
        Some(label) if bus.has_webview(&label) => Delivery::Target(label),
        _ => Delivery::Broadcast,
    }
}

/// [`plan_delivery`] for an `AppHandle` (diagnostics and the isolated QA probe).
pub(crate) fn plan_thread_delivery(app: &tauri::AppHandle, thread_id: &str) -> Delivery {
    let state = app.state::<crate::state::AppState>();
    plan_delivery(app, &state.agent.thread_windows, thread_id)
}

/// Emit a thread-scoped event to the window that owns `thread_id`.
///
/// Targeted deliveries stamp [`WINDOW_LABEL_FIELD`] into the payload. When the
/// recorded window no longer exists (closed, or a renderer restart), the stale
/// mapping is dropped and the event is broadcast so the approval can still be
/// answered.
pub(crate) fn emit_thread_event<B: EventBus + ?Sized>(
    bus: &B,
    windows: &ThreadWindows,
    thread_id: &str,
    event: &str,
    payload: Value,
) -> Delivery {
    if let Delivery::Target(label) = plan_delivery(bus, windows, thread_id) {
        let mut targeted = payload.clone();
        stamp_window_label(&mut targeted, &label);
        if bus.emit_to_label(&label, event, targeted) {
            return Delivery::Target(label);
        }
        // The window disappeared between the existence probe and the emit.
        windows.forget_owner(thread_id, &label);
    } else if let Some(stale) = windows.owner(thread_id) {
        windows.forget_owner(thread_id, &stale);
    }
    let _ = bus.emit_all(event, payload);
    Delivery::Broadcast
}

/// Emit a thread-scoped event for an `AppHandle`, resolving `AppState` itself.
pub(crate) fn emit_thread_event_for_app(
    app: &tauri::AppHandle,
    thread_id: &str,
    event: &str,
    payload: Value,
) -> Delivery {
    let state = app.state::<crate::state::AppState>();
    emit_thread_event(app, &state.agent.thread_windows, thread_id, event, payload)
}

/// Event telling every window that a Claude Code approval is no longer
/// actionable. The renderer listens for exactly this name.
pub(crate) const CC_PERMISSION_RESOLVED_EVENT: &str = "agent-cc-permission-resolved";

/// Payload of [`CC_PERMISSION_RESOLVED_EVENT`].
///
/// `callId` identifies one prompt; when it is absent (thread stopped, bridge
/// exited) every pending prompt of `threadId` is resolved, which is why both
/// fields are always present.
pub(crate) fn cc_permission_resolved_payload(
    call_id: Option<&str>,
    thread_id: Option<&str>,
) -> Value {
    serde_json::json!({ "callId": call_id, "threadId": thread_id })
}

/// Broadcast that a pending Claude Code permission is no longer actionable, so
/// every window can drop a card it still shows. Resolving in one window must
/// never leave a dead card in another (issue #869).
pub(crate) fn broadcast_cc_permission_resolved(
    app: &tauri::AppHandle,
    call_id: Option<&str>,
    thread_id: Option<&str>,
) {
    let _ = app.emit(
        CC_PERMISSION_RESOLVED_EVENT,
        cc_permission_resolved_payload(call_id, thread_id),
    );
}

fn stamp_window_label(payload: &mut Value, label: &str) {
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            WINDOW_LABEL_FIELD.to_string(),
            Value::String(label.to_string()),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct FakeBus {
        live: RefCell<Vec<String>>,
        targeted: RefCell<Vec<(String, String, Value)>>,
        broadcasts: RefCell<Vec<(String, Value)>>,
        fail_targeted: AtomicBool,
    }

    impl FakeBus {
        fn with_windows(labels: &[&str]) -> Self {
            let bus = FakeBus::default();
            *bus.live.borrow_mut() = labels.iter().map(|l| l.to_string()).collect();
            bus
        }
    }

    impl EventBus for FakeBus {
        fn has_webview(&self, label: &str) -> bool {
            self.live.borrow().iter().any(|l| l == label)
        }

        fn emit_to_label(&self, label: &str, event: &str, payload: Value) -> bool {
            if self.fail_targeted.load(Ordering::SeqCst) {
                return false;
            }
            self.targeted
                .borrow_mut()
                .push((label.to_string(), event.to_string(), payload));
            true
        }

        fn emit_all(&self, event: &str, payload: Value) -> bool {
            self.broadcasts
                .borrow_mut()
                .push((event.to_string(), payload));
            true
        }
    }

    fn prompt_payload() -> Value {
        json!({ "callId": "call-1", "threadId": "thread-1", "tool": "Bash" })
    }

    #[test]
    fn records_and_replaces_the_owning_window() {
        let windows = ThreadWindows::new();
        assert_eq!(windows.owner("thread-1"), None);
        windows.record("thread-1", "main");
        assert_eq!(windows.owner("thread-1").as_deref(), Some("main"));
        windows.record("thread-1", "terminal-abc");
        assert_eq!(windows.owner("thread-1").as_deref(), Some("terminal-abc"));
        assert_eq!(windows.len(), 1);
    }

    #[test]
    fn ignores_empty_identifiers() {
        let windows = ThreadWindows::new();
        windows.record("", "main");
        windows.record("thread-1", "");
        assert_eq!(windows.owner("thread-1"), None);
        assert_eq!(windows.owner(""), None);
        assert_eq!(windows.len(), 0);
    }

    #[test]
    fn targeted_event_carries_its_window_label() {
        let windows = ThreadWindows::new();
        windows.record("thread-1", "terminal-abc");
        let bus = FakeBus::with_windows(&["main", "terminal-abc"]);

        let delivery = emit_thread_event(
            &bus,
            &windows,
            "thread-1",
            "agent-cc-permission",
            prompt_payload(),
        );

        assert_eq!(delivery, Delivery::Target("terminal-abc".into()));
        assert!(bus.broadcasts.borrow().is_empty());
        let targeted = bus.targeted.borrow();
        assert_eq!(targeted.len(), 1);
        assert_eq!(targeted[0].0, "terminal-abc");
        assert_eq!(targeted[0].1, "agent-cc-permission");
        assert_eq!(targeted[0].2["windowLabel"], "terminal-abc");
        // The original prompt data is preserved.
        assert_eq!(targeted[0].2["callId"], "call-1");
        assert_eq!(targeted[0].2["tool"], "Bash");
    }

    #[test]
    fn only_the_owning_window_receives_the_event() {
        let windows = ThreadWindows::new();
        windows.record("thread-1", "main");
        let bus = FakeBus::with_windows(&["main", "terminal-abc"]);

        emit_thread_event(
            &bus,
            &windows,
            "thread-1",
            "agent-cc-tool",
            json!({ "callId": "call-1" }),
        );

        let targeted = bus.targeted.borrow();
        assert_eq!(targeted.len(), 1, "exactly one window must be addressed");
        assert_eq!(targeted[0].0, "main");
    }

    #[test]
    fn missing_window_falls_back_to_broadcast_without_a_window_label() {
        let windows = ThreadWindows::new();
        windows.record("thread-1", "terminal-closed");
        let bus = FakeBus::with_windows(&["main"]);

        let delivery = emit_thread_event(
            &bus,
            &windows,
            "thread-1",
            "agent-cc-permission",
            prompt_payload(),
        );

        assert_eq!(delivery, Delivery::Broadcast);
        assert!(bus.targeted.borrow().is_empty());
        let broadcasts = bus.broadcasts.borrow();
        assert_eq!(broadcasts.len(), 1);
        assert_eq!(broadcasts[0].0, "agent-cc-permission");
        assert!(
            broadcasts[0].1.get(WINDOW_LABEL_FIELD).is_none(),
            "a broadcast must stay addressed to every window"
        );
        assert_eq!(
            windows.owner("thread-1"),
            None,
            "the stale owner mapping is dropped"
        );
    }

    #[test]
    fn unknown_thread_broadcasts() {
        let windows = ThreadWindows::new();
        let bus = FakeBus::with_windows(&["main", "terminal-abc"]);

        let delivery = emit_thread_event(
            &bus,
            &windows,
            "thread-without-turn",
            "agent-acp-permission",
            json!({ "callId": "acp-1" }),
        );

        assert_eq!(delivery, Delivery::Broadcast);
        assert_eq!(bus.broadcasts.borrow().len(), 1);
        assert!(bus.targeted.borrow().is_empty());
    }

    #[test]
    fn failed_targeted_emit_does_not_lose_the_event() {
        let windows = ThreadWindows::new();
        windows.record("thread-1", "terminal-closing");
        let bus = FakeBus::with_windows(&["terminal-closing"]);
        bus.fail_targeted.store(true, Ordering::SeqCst);

        let delivery = emit_thread_event(
            &bus,
            &windows,
            "thread-1",
            "agent-cc-permission",
            prompt_payload(),
        );

        assert_eq!(delivery, Delivery::Broadcast);
        let broadcasts = bus.broadcasts.borrow();
        assert_eq!(broadcasts.len(), 1);
        assert!(broadcasts[0].1.get(WINDOW_LABEL_FIELD).is_none());
    }

    #[test]
    fn forget_owner_does_not_drop_a_newer_owner() {
        let windows = ThreadWindows::new();
        windows.record("thread-1", "terminal-new");
        windows.forget_owner("thread-1", "terminal-old");
        assert_eq!(windows.owner("thread-1").as_deref(), Some("terminal-new"));
        windows.forget_owner("thread-1", "terminal-new");
        assert_eq!(windows.owner("thread-1"), None);
    }

    #[test]
    fn resolution_payload_identifies_one_call_or_a_whole_thread() {
        let one = cc_permission_resolved_payload(Some("call-1"), Some("thread-1"));
        assert_eq!(one["callId"], "call-1");
        assert_eq!(one["threadId"], "thread-1");

        // A stopped thread has no single call id; every prompt of the thread is
        // resolved, so the field stays explicit rather than disappearing.
        let thread_wide = cc_permission_resolved_payload(None, Some("thread-1"));
        assert!(thread_wide["callId"].is_null());
        assert_eq!(thread_wide["threadId"], "thread-1");
        assert_eq!(thread_wide.as_object().map(|o| o.len()), Some(2));
    }

    #[test]
    fn resolved_event_name_matches_the_renderer_listener() {
        // Pinned because the Rust emitter and the TSX listener are edited
        // independently; a rename on either side would silently stop cards from
        // clearing, which is exactly the bug this event fixes.
        assert_eq!(CC_PERMISSION_RESOLVED_EVENT, "agent-cc-permission-resolved");
    }

    #[test]
    fn non_object_payload_is_still_delivered() {
        // Defensive: the bridges always send objects, but a future event must
        // not crash the delivery path or silently drop the payload.
        let windows = ThreadWindows::new();
        windows.record("thread-1", "main");
        let bus = FakeBus::with_windows(&["main"]);

        let delivery = emit_thread_event(&bus, &windows, "thread-1", "evt", json!("plain"));

        assert_eq!(delivery, Delivery::Target("main".into()));
        assert_eq!(bus.targeted.borrow()[0].2, json!("plain"));
    }
}
