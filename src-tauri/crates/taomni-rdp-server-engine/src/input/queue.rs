use enigo::Axis;
use enigo::Button;
use enigo::Coordinate;
use enigo::Direction;
use enigo::Key;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::time::Instant;

/// A single input action to replay on the local desktop. Every field is plain
/// `Send` data (ints / `Copy` enums / `char`), so the command — and the
/// `Sender` that carries it — is `Send` on every platform.
pub(super) enum InputCmd {
    Raw { code: u16, dir: Direction },
    Key { key: Key, dir: Direction },
    Button { button: Button, dir: Direction },
    MoveMouse { x: i32, y: i32, coord: Coordinate },
    Scroll { length: i32, axis: Axis },
}

impl InputCmd {
    pub(super) fn is_mouse_move(&self) -> bool {
        matches!(self, Self::MoveMouse { .. })
    }
}

/// Timestamping is intentionally attached to the command rather than the
/// handler: it measures the full queueing delay before the thread-affine
/// Enigo actor applies the input event.
pub(super) struct QueuedInput {
    pub(super) received_at: Instant,
    pub(super) cmd: InputCmd,
}

/// High-frequency mouse movement is advisory: only the most recent position
/// before the next key/button/scroll boundary matters. This queue collapses
/// consecutive moves, and has a soft bound for move traffic so a busy Windows
/// client cannot make macOS replay stale coordinates for seconds. Semantic
/// events are never discarded, even when the soft move bound is reached.
#[derive(Clone)]
pub(super) struct InputQueue {
    pub(super) inner: Arc<(Mutex<InputQueueState>, Condvar)>,
}

pub(super) struct InputQueueState {
    pub(super) commands: VecDeque<QueuedInput>,
    pub(super) closed: bool,
}

pub(super) enum InputQueuePush {
    Enqueued,
    Coalesced,
    DroppedMove,
    Closed,
}

pub(super) const MAX_PENDING_INPUTS: usize = 128;

impl InputQueue {
    pub(super) fn new() -> Self {
        Self {
            inner: Arc::new((
                Mutex::new(InputQueueState {
                    commands: VecDeque::new(),
                    closed: false,
                }),
                Condvar::new(),
            )),
        }
    }

    pub(super) fn push(&self, queued: QueuedInput) -> InputQueuePush {
        let (lock, wake) = &*self.inner;
        let Ok(mut state) = lock.lock() else {
            return InputQueuePush::Closed;
        };
        if state.closed {
            return InputQueuePush::Closed;
        }

        if queued.cmd.is_mouse_move()
            && state
                .commands
                .back()
                .is_some_and(|last| last.cmd.is_mouse_move())
        {
            *state.commands.back_mut().expect("tail checked above") = queued;
            wake.notify_one();
            return InputQueuePush::Coalesced;
        }

        if queued.cmd.is_mouse_move() && state.commands.len() >= MAX_PENDING_INPUTS {
            return InputQueuePush::DroppedMove;
        }

        state.commands.push_back(queued);
        wake.notify_one();
        InputQueuePush::Enqueued
    }

    pub(super) fn recv(&self) -> Option<QueuedInput> {
        let (lock, wake) = &*self.inner;
        let mut state = lock.lock().ok()?;
        loop {
            if let Some(queued) = state.commands.pop_front() {
                return Some(queued);
            }
            if state.closed {
                return None;
            }
            state = wake.wait(state).ok()?;
        }
    }

    pub(super) fn close(&self) {
        let (lock, wake) = &*self.inner;
        if let Ok(mut state) = lock.lock() {
            state.closed = true;
            state.commands.clear();
        }
        wake.notify_all();
    }
}
