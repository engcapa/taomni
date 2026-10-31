use super::{events::Events, replay::Replay};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Mutex as AsyncMutex, broadcast};

pub struct Terminal {
    pub running: bool,
    pub holder: Option<(String, String)>, // device + connection, not just device
    pub desktop_size: Option<(u16, u16)>,
    pub size: Option<(u16, u16)>,
    pub seq: u64,
    replay: Replay,
    chunks: VecDeque<(u64, Vec<u8>)>,
    bytes: usize,
    pub tx: broadcast::Sender<Value>,
    pub gate: Arc<AsyncMutex<()>>,
}
impl Default for Terminal {
    fn default() -> Self {
        Self {
            running: true,
            holder: None,
            desktop_size: None,
            size: None,
            seq: 0,
            replay: Replay::default(),
            chunks: VecDeque::new(),
            bytes: 0,
            tx: broadcast::channel(512).0,
            gate: Arc::new(AsyncMutex::new(())),
        }
    }
}
pub struct Broker {
    pub enabled: AtomicBool,
    pub terminals: Mutex<HashMap<String, Terminal>>,
    events: Arc<Events>,
}
impl Broker {
    pub fn new(events: Arc<Events>) -> Self {
        Self {
            enabled: AtomicBool::new(false),
            terminals: Mutex::new(HashMap::new()),
            events,
        }
    }
    pub fn register(&self, id: &str) {
        self.terminals
            .lock()
            .unwrap()
            .insert(id.to_owned(), Terminal::default());
        self.changed(id, "opened");
    }
    fn changed(&self, id: &str, kind: &str) {
        if self.enabled.load(Ordering::Relaxed) {
            self.events.publish(json!({"type":"session_changed", "session_id":format!("term:{id}"), "change_kind":kind}));
        }
    }
    pub fn output(&self, id: &str, bytes: &[u8]) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let mut terms = self.terminals.lock().unwrap();
        let Some(t) = terms.get_mut(id).filter(|t| t.running) else {
            return;
        };
        t.seq += 1;
        t.replay.push(bytes);
        t.chunks.push_back((t.seq, bytes.to_vec()));
        t.bytes += bytes.len();
        while t.bytes > 512 * 1024 || t.chunks.len() > 1000 {
            if let Some((_, old)) = t.chunks.pop_front() {
                t.bytes -= old.len();
            }
        }
        let _ =
            t.tx.send(json!({"type":"output", "seq":t.seq, "data_b64":B64.encode(bytes)}));
    }
    pub fn exit(&self, id: &str) {
        if let Some(t) = self.terminals.lock().unwrap().get_mut(id) {
            t.running = false;
            t.holder = None;
            t.replay = Replay::default();
            t.chunks.clear();
            t.bytes = 0;
            let _ = t.tx.send(json!({"type":"exit", "code":null}));
        }
        self.changed(id, "exited");
    }
    pub fn remove(&self, id: &str) {
        self.exit(id);
        self.terminals.lock().unwrap().remove(id);
    }
    pub fn gate(&self, id: &str) -> Result<Arc<AsyncMutex<()>>, String> {
        self.terminals
            .lock()
            .unwrap()
            .get(id)
            .map(|t| t.gate.clone())
            .ok_or("terminal_not_found".into())
    }
    pub fn holder(t: &Terminal) -> String {
        t.holder
            .as_ref()
            .map(|(d, _)| format!("mobile:{d}"))
            .unwrap_or_else(|| "none".into())
    }
    pub fn desktop(&self, id: &str, size: Option<(u16, u16)>) -> Option<(u16, u16)> {
        let mut ts = self.terminals.lock().unwrap();
        let t = ts.get_mut(id)?;
        let held = t.holder.take().is_some();
        let restore = if held { t.desktop_size } else { None };
        if held {
            t.size = t.desktop_size;
            if t.desktop_size.is_none() {
                log::warn!("Mobile control released without a recorded desktop size");
            }
        }
        if let Some(size) = size {
            t.desktop_size = Some(size);
            t.size = Some(size);
        }
        if held {
            let _ = t.tx.send(json!({"type":"control-lost", "reason":if size.is_some() {"desktop_resize"} else {"desktop_input"}}));
            let _ = t.tx.send(json!({"type":"control","holder":"none"}));
        }
        restore
    }
    pub fn control(
        &self,
        id: &str,
        device: &str,
        connection: &str,
        take: bool,
    ) -> Result<Option<(u16, u16)>, String> {
        let mut ts = self.terminals.lock().unwrap();
        let t = ts
            .get_mut(id)
            .filter(|t| t.running)
            .ok_or("terminal_exited")?;
        if take {
            if t.holder.as_ref().is_some_and(|(_, c)| c != connection) {
                return Err("control_busy".into());
            }
            t.holder = Some((device.into(), connection.into()));
        } else if t.holder.as_ref().is_some_and(|(_, c)| c == connection) {
            t.holder = None;
            let _ = t.tx.send(json!({"type":"control", "holder":"none"}));
            t.size = t.desktop_size;
            return Ok(t.desktop_size);
        }
        let _ = t.tx.send(json!({"type":"control", "holder":Self::holder(t), "connection_id":t.holder.as_ref().map(|(_, c)| c)}));
        Ok(None)
    }
    pub fn ensure_holder(&self, id: &str, connection: &str) -> Result<(), String> {
        let ts = self.terminals.lock().unwrap();
        let t = ts.get(id).filter(|t| t.running).ok_or("terminal_exited")?;
        if t.holder.as_ref().is_some_and(|(_, c)| c == connection) {
            Ok(())
        } else {
            Err("not_holder".into())
        }
    }
    pub fn resize(
        &self,
        id: &str,
        connection: &str,
        cols: u16,
        rows: u16,
    ) -> Result<Option<(u16, u16)>, String> {
        self.ensure_holder(id, connection)?;
        let mut ts = self.terminals.lock().unwrap();
        let t = ts.get_mut(id).ok_or("terminal_not_found")?;
        let size = (cols.clamp(20, 300), rows.clamp(10, 100));
        if t.size == Some(size) {
            return Ok(None);
        }
        t.size = Some(size);
        Ok(Some(size))
    }
    pub fn subscribe(&self, id: &str) -> Result<(broadcast::Receiver<Value>, Vec<Value>), String> {
        let ts = self.terminals.lock().unwrap();
        let t = ts.get(id).ok_or("terminal_not_found")?;
        let rx = t.tx.subscribe();
        let mut frames = vec![
            json!({"type":"replay", "lines":t.replay.lines(), "last_seq":t.seq}),
            json!({"type":"control", "holder":Self::holder(t), "connection_id":t.holder.as_ref().map(|(_, c)| c)}),
        ];
        if !t.running {
            frames.push(json!({"type":"exit", "code":null}));
        }
        Ok((rx, frames))
    }
    pub fn resume(&self, id: &str, after: u64) -> Vec<Value> {
        let ts = self.terminals.lock().unwrap();
        let Some(t) = ts.get(id) else {
            return vec![];
        };
        if (t.chunks.is_empty() && after < t.seq)
            || after > t.seq
            || t.chunks
                .front()
                .is_some_and(|(seq, _)| after.saturating_add(1) < *seq)
        {
            return vec![
                json!({"type":"replay", "lines":t.replay.lines(), "last_seq":t.seq, "gap":true}),
            ];
        }
        t.chunks
            .iter()
            .filter(|(seq, _)| *seq > after)
            .map(|(seq, data)| json!({"type":"output", "seq":seq,"data_b64":B64.encode(data)}))
            .collect()
    }
    pub fn disable(&self) {
        self.enabled.store(false, Ordering::Relaxed);
        for t in self.terminals.lock().unwrap().values_mut() {
            t.replay = Replay::default();
            t.chunks.clear();
            t.bytes = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reclaim_restores_size_and_connection_ownership_without_spurious_loss() {
        let broker = Broker::new(Arc::new(Events::default()));
        broker.enabled.store(true, Ordering::Relaxed);
        broker.register("terminal");
        broker.desktop("terminal", Some((80, 24)));
        let (mut rx, _) = broker.subscribe("terminal").unwrap();
        assert_eq!(broker.desktop("terminal", None), None);
        assert!(rx.try_recv().is_err());
        broker
            .control("terminal", "same-device", "page-a", true)
            .unwrap();
        assert_eq!(
            broker
                .control("terminal", "same-device", "page-b", true)
                .unwrap_err(),
            "control_busy"
        );
        assert!(broker.ensure_holder("terminal", "page-b").is_err());
        assert_eq!(
            broker.resize("terminal", "page-a", 100, 30).unwrap(),
            Some((100, 30))
        );
        assert_eq!(broker.desktop("terminal", None), Some((80, 24)));
        broker
            .control("terminal", "same-device", "page-a", true)
            .unwrap();
        // The same mobile size must be applied again after desktop restoration.
        assert_eq!(
            broker.resize("terminal", "page-a", 100, 30).unwrap(),
            Some((100, 30))
        );
        for _ in 0..1100 {
            broker.output("terminal", b"line\n");
        }
        assert!(matches!(
            rx.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
        assert_eq!(broker.resume("terminal", 0)[0]["gap"], true);
    }
}
