//! Presentation ownership for pending desktop approvals. The provider continues to
//! own the responder, offered options, cancellation and deadline during reattach.

use super::thread_delivery::{EventBus, ThreadWindows, emit_thread_event};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum ApprovalId {
    Cc(String),
    Acp {
        thread: String,
        owner: String,
        call: String,
    },
}

impl ApprovalId {
    fn event(&self) -> &'static str {
        match self {
            Self::Cc(_) => "agent-cc-permission",
            Self::Acp { .. } => "agent-acp-permission",
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct PendingApprovals(Mutex<BTreeMap<ApprovalId, Value>>);

impl PendingApprovals {
    pub(crate) fn publish(
        &self,
        bus: &impl EventBus,
        windows: &ThreadWindows,
        id: ApprovalId,
        thread: &str,
        mut payload: Value,
    ) {
        let mut pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if pending.contains_key(&id) {
            return;
        }
        let delivery = emit_thread_event(bus, windows, thread, id.event(), payload.clone());
        if let Some(label) = delivery.label() {
            payload["windowLabel"] = json!(label);
        }
        pending.insert(id, payload);
    }

    pub(crate) fn replay(&self, window: &str, event: &str) -> Vec<Value> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(id, value)| {
                id.event() == event && value["windowLabel"].as_str() == Some(window)
            })
            .map(|(_, value)| value.clone())
            .collect()
    }

    pub(crate) fn window_closed(
        &self,
        bus: &impl EventBus,
        windows: &ThreadWindows,
        old: &str,
        title: &str,
    ) {
        let mut pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        windows.forget_label(old);
        if old == "main" || !bus.has_webview("main") {
            return;
        }
        for (id, value) in pending.iter_mut() {
            if value["windowLabel"].as_str() != Some(old) {
                continue;
            }
            value["windowLabel"] = json!("main");
            value["sourceWindow"] = json!(old);
            value["sourceWindowTitle"] = json!(title);
            // Even if the main WebView is reloading, its next replay sees this item.
            bus.emit_to_label("main", id.event(), value.clone());
        }
    }

    pub(crate) fn take_cc(&self, call: &str, window: &str) -> Result<(), String> {
        let id = ApprovalId::Cc(call.to_owned());
        let mut pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let prompt = pending.get(&id).ok_or("This approval has ended")?;
        check_window(prompt, window)?;
        pending.remove(&id);
        Ok(())
    }

    pub(crate) fn take_acp(
        &self,
        thread_id: &str,
        owner_id: Option<&str>,
        call_id: &str,
        window: &str,
        option: Option<&str>,
    ) -> Result<String, String> {
        let mut pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // Older renderers omit the process ID. Accept an unambiguous live call.
        let mut matches = pending.iter().filter_map(|(id, value)| match id {
            ApprovalId::Acp {
                thread,
                owner,
                call,
            } if thread == thread_id && call == call_id && owner_id.is_none_or(|v| v == owner) => {
                Some((owner, value))
            }
            _ => None,
        });
        let (owner, prompt) = matches.next().ok_or("This approval has ended")?;
        if matches.next().is_some() {
            return Err("Ambiguous ACP approval owner".into());
        }
        check_window(prompt, window)?;
        if let Some(option) = option
            && !prompt["options"]
                .as_array()
                .is_some_and(|opts| opts.iter().any(|v| v["optionId"] == option))
        {
            return Err("ACP permission option is unavailable".into());
        }
        let owner = owner.clone();
        pending.remove(&ApprovalId::Acp {
            thread: thread_id.into(),
            owner: owner.clone(),
            call: call_id.into(),
        });
        Ok(owner)
    }

    pub(crate) fn dismiss_cc(&self, thread: Option<&str>, call: Option<&str>) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|id, prompt| match id {
                ApprovalId::Cc(id) => !call.map_or_else(
                    || thread.is_some_and(|t| prompt["threadId"] == t),
                    |c| id == c,
                ),
                _ => true,
            });
    }

    pub(crate) fn dismiss_acp(
        &self,
        thread_id: &str,
        owner_id: Option<&str>,
        call_id: Option<&str>,
    ) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|id, _| match id {
                ApprovalId::Acp {
                    thread,
                    owner,
                    call,
                } => {
                    !(thread == thread_id
                        && owner_id.is_none_or(|v| v == owner)
                        && call_id.is_none_or(|v| v == call))
                }
                _ => true,
            });
    }
}

fn check_window(prompt: &Value, window: &str) -> Result<(), String> {
    if prompt["windowLabel"]
        .as_str()
        .is_some_and(|label| label != window)
    {
        return Err("This approval belongs to another window".into());
    }
    Ok(())
}
