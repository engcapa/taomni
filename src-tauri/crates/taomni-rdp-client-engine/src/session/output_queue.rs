use super::*;

impl fmt::Debug for SessionOutputSender {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SessionOutputSender(..)")
    }
}

impl SessionOutputQueue {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(SessionOutputState {
                control: std::collections::VecDeque::new(),
                building_frame: Vec::new(),
                building_bytes: 0,
                drop_building_frame: false,
                pending_frame: Vec::new(),
                pending_frame_bytes: 0,
                closed: false,
            }),
            wake: Notify::new(),
            space: Condvar::new(),
        })
    }

    pub(super) fn send(&self, output: SessionOutput) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "rdp output queue poisoned".to_string())?;
        match output {
            SessionOutput::Channel { tag, payload } if tag == channel::FRAME => {
                if !state.drop_building_frame {
                    let next_bytes = state.building_bytes.saturating_add(payload.len());
                    if next_bytes <= MAX_FRAME_BATCH_BYTES {
                        state.building_bytes = next_bytes;
                        state.building_frame.push(payload);
                    } else {
                        state.drop_building_frame = true;
                        state.building_frame.clear();
                    }
                }
                return Ok(());
            }
            SessionOutput::Channel { tag, .. } if tag == channel::FRAME_END => {
                if !state.drop_building_frame && !state.building_frame.is_empty() {
                    while state
                        .pending_frame_bytes
                        .saturating_add(state.building_bytes)
                        > MAX_FRAME_BATCH_BYTES
                        && !state.closed
                    {
                        state = self
                            .space
                            .wait(state)
                            .map_err(|_| "rdp output queue poisoned".to_string())?;
                    }
                    if state.closed {
                        return Err("rdp output queue closed".to_string());
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
                return Ok(());
            }
            other => {
                while state.control.len() >= MAX_PENDING_SESSION_STATUS && !state.closed {
                    state = self
                        .space
                        .wait(state)
                        .map_err(|_| "rdp output queue poisoned".to_string())?;
                }
                if state.closed {
                    return Err("rdp output queue closed".to_string());
                }
                state.control.push_back(other);
                self.wake.notify_one();
            }
        }
        Ok(())
    }

    pub(super) async fn recv(&self) -> Option<QueuedSessionOutput> {
        loop {
            let notified = self.wake.notified();
            {
                let Ok(mut state) = self.state.lock() else {
                    return None;
                };
                if let Some(output) = state.control.pop_front() {
                    self.space.notify_one();
                    return Some(QueuedSessionOutput::Control(output));
                }
                if !state.pending_frame.is_empty() {
                    let frame = std::mem::take(&mut state.pending_frame);
                    state.pending_frame_bytes = 0;
                    self.space.notify_one();
                    return Some(QueuedSessionOutput::FrameBatch(frame));
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

impl SessionOutputSender {
    pub fn send(&self, output: SessionOutput) -> Result<(), String> {
        self.0.send(output)
    }
}
