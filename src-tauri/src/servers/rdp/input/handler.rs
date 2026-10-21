use super::actor::RdpInput;
use super::queue::InputCmd;
use super::queue::InputQueuePush;
use super::queue::QueuedInput;
use super::scancodes::rdp_scancode_to_raw;
use enigo::Axis;
use enigo::Button;
use enigo::Coordinate;
use enigo::Direction::Press;
use enigo::Direction::Release;
use enigo::Key;
use ironrdp::server::KeyboardEvent;
use ironrdp::server::MouseEvent;
use ironrdp::server::RdpServerInputHandler;
use std::time::Instant;

impl RdpInput {
    /// Send one command to the actor thread. Drops the sender (and warns once)
    /// if the actor has exited so a dead thread doesn't silently swallow input.
    pub(super) fn send(&mut self, cmd: InputCmd) {
        if self.view_only {
            return;
        }
        self.warn_if_missing();
        if self.tx.is_none() {
            return;
        }
        if self
            .control_gate
            .as_ref()
            .is_some_and(|gate| !gate.ensure_approved())
        {
            return;
        }
        if let Some(tx) = &self.tx {
            match tx.push(QueuedInput {
                received_at: Instant::now(),
                cmd,
            }) {
                InputQueuePush::Enqueued => {}
                InputQueuePush::Coalesced => self.metrics.record_input_coalesced(),
                InputQueuePush::DroppedMove => self.metrics.record_input_dropped(),
                InputQueuePush::Closed => {
                    // Actor thread is gone; stop trying and warn once.
                    self.tx = None;
                    self.warned = false;
                    self.warn_if_missing();
                }
            }
        }
    }

    pub(super) fn sync_lock_keys(
        &mut self,
        flags: ironrdp::pdu::input::fast_path::SynchronizeFlags,
    ) {
        use ironrdp::pdu::input::fast_path::SynchronizeFlags;
        // RDP Set-1 scancodes for lock keys.
        const SC_CAPS: u8 = 0x3A;
        const SC_NUM: u8 = 0x45;
        const SC_SCROLL: u8 = 0x46;
        for (flag, sc) in [
            (SynchronizeFlags::CAPS_LOCK, SC_CAPS),
            (SynchronizeFlags::NUM_LOCK, SC_NUM),
            (SynchronizeFlags::SCROLL_LOCK, SC_SCROLL),
        ] {
            if flags.contains(flag) {
                if let Some(raw) = rdp_scancode_to_raw(sc, false) {
                    self.send(InputCmd::Raw {
                        code: raw,
                        dir: Press,
                    });
                    self.send(InputCmd::Raw {
                        code: raw,
                        dir: Release,
                    });
                }
            }
        }
    }
}

impl RdpServerInputHandler for RdpInput {
    fn keyboard(&mut self, event: KeyboardEvent) {
        match event {
            KeyboardEvent::Pressed { code, extended } => {
                if let Some(raw) = rdp_scancode_to_raw(code, extended) {
                    self.send(InputCmd::Raw {
                        code: raw,
                        dir: Press,
                    });
                }
            }
            KeyboardEvent::Released { code, extended } => {
                if let Some(raw) = rdp_scancode_to_raw(code, extended) {
                    self.send(InputCmd::Raw {
                        code: raw,
                        dir: Release,
                    });
                }
            }
            KeyboardEvent::UnicodePressed(c) => {
                if let Some(ch) = char::from_u32(u32::from(c)) {
                    self.send(InputCmd::Key {
                        key: Key::Unicode(ch),
                        dir: Press,
                    });
                }
            }
            KeyboardEvent::UnicodeReleased(c) => {
                if let Some(ch) = char::from_u32(u32::from(c)) {
                    self.send(InputCmd::Key {
                        key: Key::Unicode(ch),
                        dir: Release,
                    });
                }
            }
            KeyboardEvent::Synchronize(flags) => {
                // Best-effort lock-key pulse: inject Caps/Num/Scroll press+release
                // so remote and local LED state tend to converge. Full host-state
                // reconciliation would need reading current lock state (platform API).
                self.sync_lock_keys(flags);
            }
        }
    }

    fn mouse(&mut self, event: MouseEvent) {
        match event {
            MouseEvent::Move { x, y } => {
                self.send(InputCmd::MoveMouse {
                    x: i32::from(x),
                    y: i32::from(y),
                    coord: Coordinate::Abs,
                });
            }
            MouseEvent::LeftPressed => {
                self.send(InputCmd::Button {
                    button: Button::Left,
                    dir: Press,
                });
            }
            MouseEvent::LeftReleased => {
                self.send(InputCmd::Button {
                    button: Button::Left,
                    dir: Release,
                });
            }
            MouseEvent::RightPressed => {
                self.send(InputCmd::Button {
                    button: Button::Right,
                    dir: Press,
                });
            }
            MouseEvent::RightReleased => {
                self.send(InputCmd::Button {
                    button: Button::Right,
                    dir: Release,
                });
            }
            MouseEvent::MiddlePressed => {
                self.send(InputCmd::Button {
                    button: Button::Middle,
                    dir: Press,
                });
            }
            MouseEvent::MiddleReleased => {
                self.send(InputCmd::Button {
                    button: Button::Middle,
                    dir: Release,
                });
            }
            MouseEvent::Button4Pressed => {
                // `Button::Back`/`Forward` don't exist on macOS in enigo 0.3.
                #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
                self.send(InputCmd::Button {
                    button: Button::Back,
                    dir: Press,
                });
            }
            MouseEvent::Button4Released => {
                #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
                self.send(InputCmd::Button {
                    button: Button::Back,
                    dir: Release,
                });
            }
            MouseEvent::Button5Pressed => {
                #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
                self.send(InputCmd::Button {
                    button: Button::Forward,
                    dir: Press,
                });
            }
            MouseEvent::Button5Released => {
                #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
                self.send(InputCmd::Button {
                    button: Button::Forward,
                    dir: Release,
                });
            }
            MouseEvent::VerticalScroll { value } => {
                // RDP wheel units are 120 per notch; positive = up. enigo's
                // `scroll` uses positive = down, so invert and normalize.
                let notches = -(i32::from(value) / 120);
                let notches = if notches == 0 {
                    if value > 0 {
                        -1
                    } else if value < 0 {
                        1
                    } else {
                        0
                    }
                } else {
                    notches
                };
                if notches != 0 {
                    self.send(InputCmd::Scroll {
                        length: notches,
                        axis: Axis::Vertical,
                    });
                }
            }
            MouseEvent::Scroll { x, y } => {
                if x != 0 {
                    self.send(InputCmd::Scroll {
                        length: x,
                        axis: Axis::Horizontal,
                    });
                }
                if y != 0 {
                    self.send(InputCmd::Scroll {
                        length: y,
                        axis: Axis::Vertical,
                    });
                }
            }
            MouseEvent::RelMove { x, y } => {
                self.send(InputCmd::MoveMouse {
                    x,
                    y,
                    coord: Coordinate::Rel,
                });
            }
        }
    }
}
