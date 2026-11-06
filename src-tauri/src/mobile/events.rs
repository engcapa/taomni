use serde_json::{Value, json};
use std::{collections::VecDeque, sync::Mutex};
use tokio::sync::broadcast;

pub struct Events {
    buffer: Mutex<(u64, VecDeque<Value>)>,
    pub tx: broadcast::Sender<Value>,
    pub tasks: broadcast::Sender<Value>,
}
impl Default for Events {
    fn default() -> Self {
        Self {
            buffer: Mutex::new((0, VecDeque::new())),
            tx: broadcast::channel(200).0,
            tasks: broadcast::channel(200).0,
        }
    }
}
impl Events {
    pub fn publish(&self, mut event: Value) {
        let mut b = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
        b.0 += 1;
        event["seq"] = json!(b.0);
        b.1.push_back(event.clone());
        if b.1.len() > 200 {
            b.1.pop_front();
        }
        if event["type"] == "task_status" {
            let _ = self.tasks.send(event.clone());
        }
        let _ = self.tx.send(event);
    }
    /// Capture the cursor and subscribe under the same publication lock.
    pub fn subscribe(&self) -> (u64, broadcast::Receiver<Value>) {
        let b = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
        (b.0, self.tx.subscribe())
    }
    pub fn seq(&self) -> u64 {
        self.buffer.lock().unwrap_or_else(|e| e.into_inner()).0
    }
    pub fn resume(&self, after: u64) -> Vec<Value> {
        let b = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
        if after > b.0
            || b.1
                .front()
                .is_some_and(|e| after + 1 < e["seq"].as_u64().unwrap())
        {
            return vec![json!({"type":"resync", "last_seq":b.0})];
        }
        b.1.iter()
            .filter(|e| e["seq"].as_u64().unwrap() > after)
            .cloned()
            .collect()
    }
}

/// Only events required by mobile paths use this boundary. Desktop-only
/// authentication/dialog/tool workflows retain their AppHandle and are never
/// entered by the headless runtime.
pub trait EventSink: Send + Sync {
    fn emit(&self, name: &str, payload: Value);
}
pub struct HeadlessSink;
impl EventSink for HeadlessSink {
    fn emit(&self, _name: &str, _payload: Value) {}
}
pub fn emit_optional(app: Option<&tauri::AppHandle>, name: &str, payload: Value) {
    match app {
        Some(app) => DesktopSink(app.clone()).emit(name, payload),
        None => HeadlessSink.emit(name, payload),
    }
}
pub struct DesktopSink(pub tauri::AppHandle);
impl EventSink for DesktopSink {
    fn emit(&self, name: &str, payload: Value) {
        use tauri::Emitter;
        let _ = self.0.emit(name, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_and_subscription_have_no_gap_and_task_subscribers_ignore_files() {
        let events = Events::default();
        let (seq, mut rx) = events.subscribe();
        let mut tasks = events.tasks.subscribe();
        assert_eq!(seq, 0);
        events.publish(json!({"type":"task_status"}));
        assert_eq!(rx.try_recv().unwrap()["seq"], 1);
        for _ in 0..300 {
            events.publish(json!({"type":"file_changed"}));
        }
        assert_eq!(tasks.try_recv().unwrap()["seq"], 1);
        assert!(tasks.try_recv().is_err());
    }
    #[test]
    fn event_resume_is_bounded_and_reports_gap() {
        let events = Events::default();
        for i in 0..205 {
            events.publish(json!({"type":"task_status","n":i}));
        }
        assert_eq!(events.resume(1)[0]["type"], "resync");
        assert_eq!(events.resume(203).len(), 2);
        assert_eq!(events.resume(205).len(), 0);
        assert_eq!(events.resume(206)[0]["type"], "resync");
    }
}
