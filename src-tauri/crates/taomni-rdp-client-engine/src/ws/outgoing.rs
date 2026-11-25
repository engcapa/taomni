use super::wire::channel;
use futures::StreamExt;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use tokio::sync::Notify;

pub enum WsOutgoing {
    Frame(Vec<u8>),
    Text(String),
}

pub(super) const MAX_PENDING_WS_STATUS: usize = 256;
pub(super) const MAX_WS_FRAME_BATCH_BYTES: usize = 64 * 1024 * 1024;

pub(super) enum QueuedWsOutgoing {
    Control(WsOutgoing),
    FrameBatch(Vec<Vec<u8>>),
}

pub(super) struct WsOutgoingState {
    pub(super) control: VecDeque<WsOutgoing>,
    pub(super) building_frame: Vec<Vec<u8>>,
    pub(super) building_bytes: usize,
    pub(super) drop_building_frame: bool,
    pub(super) pending_frame: Vec<Vec<u8>>,
    pub(super) pending_frame_bytes: usize,
    pub(super) closed: bool,
}

pub(super) struct WsOutgoingQueue {
    pub(super) state: Mutex<WsOutgoingState>,
    pub(super) wake: Notify,
    pub(super) space: Condvar,
}

#[derive(Clone)]
pub(super) struct WsOutgoingSender(pub(super) Arc<WsOutgoingQueue>);

pub(super) struct WsOutgoingReceiver {
    pub(super) queue: Arc<WsOutgoingQueue>,
    pub(super) active_frame: VecDeque<WsOutgoing>,
}

impl WsOutgoingQueue {
    pub(super) fn new() -> (WsOutgoingSender, WsOutgoingReceiver) {
        let queue = Arc::new(Self {
            state: Mutex::new(WsOutgoingState {
                control: VecDeque::new(),
                building_frame: Vec::new(),
                building_bytes: 0,
                drop_building_frame: false,
                pending_frame: Vec::new(),
                pending_frame_bytes: 0,
                closed: false,
            }),
            wake: Notify::new(),
            space: Condvar::new(),
        });
        (
            WsOutgoingSender(queue.clone()),
            WsOutgoingReceiver {
                queue,
                active_frame: VecDeque::new(),
            },
        )
    }

    pub(super) fn send(&self, output: WsOutgoing) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "RDP WebSocket output queue poisoned".to_string())?;
        match output {
            WsOutgoing::Frame(bytes) if bytes.first() == Some(&channel::FRAME) => {
                if !state.drop_building_frame {
                    let next_bytes = state.building_bytes.saturating_add(bytes.len());
                    if next_bytes <= MAX_WS_FRAME_BATCH_BYTES {
                        state.building_bytes = next_bytes;
                        state.building_frame.push(bytes);
                    } else {
                        state.drop_building_frame = true;
                        state.building_frame.clear();
                    }
                }
                Ok(())
            }
            WsOutgoing::Frame(bytes) if bytes.first() == Some(&channel::FRAME_END) => {
                if !state.drop_building_frame && !state.building_frame.is_empty() {
                    while state
                        .pending_frame_bytes
                        .saturating_add(state.building_bytes)
                        > MAX_WS_FRAME_BATCH_BYTES
                        && !state.closed
                    {
                        state = self
                            .space
                            .wait(state)
                            .map_err(|_| "RDP WebSocket output queue poisoned".to_string())?;
                    }
                    if state.closed {
                        return Err("RDP WebSocket output queue closed".to_string());
                    }
                    let combined_bytes = state.pending_frame_bytes + state.building_bytes;
                    let batch = std::mem::take(&mut state.building_frame);
                    state.pending_frame.extend(batch);
                    state.pending_frame_bytes = combined_bytes;
                } else {
                    state.building_frame.clear();
                }
                state.building_bytes = 0;
                state.drop_building_frame = false;
                self.wake.notify_one();
                Ok(())
            }
            other => {
                while state.control.len() >= MAX_PENDING_WS_STATUS && !state.closed {
                    state = self
                        .space
                        .wait(state)
                        .map_err(|_| "RDP WebSocket output queue poisoned".to_string())?;
                }
                if state.closed {
                    return Err("RDP WebSocket output queue closed".to_string());
                }
                state.control.push_back(other);
                self.wake.notify_one();
                Ok(())
            }
        }
    }

    pub(super) async fn recv(&self) -> Option<QueuedWsOutgoing> {
        loop {
            let notified = self.wake.notified();
            {
                let Ok(mut state) = self.state.lock() else {
                    return None;
                };
                if let Some(output) = state.control.pop_front() {
                    self.space.notify_one();
                    return Some(QueuedWsOutgoing::Control(output));
                }
                if !state.pending_frame.is_empty() {
                    let frame = std::mem::take(&mut state.pending_frame);
                    state.pending_frame_bytes = 0;
                    self.space.notify_one();
                    return Some(QueuedWsOutgoing::FrameBatch(frame));
                }
                if state.closed {
                    return None;
                }
            }
            notified.await;
        }
    }

    pub(super) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            state.control.clear();
            state.pending_frame.clear();
            state.pending_frame_bytes = 0;
            state.building_frame.clear();
        }
        self.space.notify_all();
        self.wake.notify_waiters();
    }
}

impl WsOutgoingSender {
    pub(super) fn send(&self, output: WsOutgoing) -> Result<(), String> {
        self.0.send(output)
    }
}

impl WsOutgoingReceiver {
    pub(super) async fn recv(&mut self) -> Option<WsOutgoing> {
        if let Some(output) = self.active_frame.pop_front() {
            return Some(output);
        }
        match self.queue.recv().await? {
            QueuedWsOutgoing::Control(output) => Some(output),
            QueuedWsOutgoing::FrameBatch(batch) => {
                self.active_frame = batch.into_iter().map(WsOutgoing::Frame).collect();
                self.active_frame
                    .push_back(WsOutgoing::Frame(vec![channel::FRAME_END]));
                self.active_frame.pop_front()
            }
        }
    }
}

impl Drop for WsOutgoingReceiver {
    fn drop(&mut self) {
        self.queue.close();
    }
}
