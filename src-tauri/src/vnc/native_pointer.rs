//! Native pointer sampling over the VNC canvas (VNC-PERF-005, DEC-VNC-20).
//!
//! Windows delivers a cursor move to a window only when its thread next
//! retrieves messages, and those `WM_MOUSEMOVE` deliveries follow the display
//! cadence: a plain Win32 window and the WebView2 canvas both see one, often
//! two, vsync periods between the cursor moving and the move event (on a
//! 60 Hz desktop median ≈ 11 ms, p95 ≈ 31 ms, measured 2026-10-01; the
//! WebView, JS and relay add < 1 ms). The cursor position itself changes at
//! once, so while the pointer rests over a connected canvas with no button
//! pressed, a thread reads it every 1–4 ms and sends PointerEvents straight
//! into the relay. The WebView keeps buttons, the wheel and drags (pointer
//! capture), and stops sending plain moves while sampling is on.
//!
//! Only Windows samples; elsewhere the relay never offers it and the WebView
//! path is unchanged. `TAOMNI_VNC_NATIVE_POINTER=0` turns it off.

use serde::Deserialize;
use tokio::sync::mpsc::Sender;

use crate::vnc::ws::VncControl;

/// Canvas geometry the WebView reports when sampling starts or the canvas
/// moves: its box in CSS px relative to the viewport, the CSS → physical
/// pixel ratio, and the framebuffer size the box shows.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct NativePointerTarget {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub dpr: f64,
    pub fb_width: u16,
    pub fb_height: u16,
}

impl NativePointerTarget {
    pub fn valid(&self) -> bool {
        [self.left, self.top, self.width, self.height, self.dpr]
            .iter()
            .all(|value| value.is_finite())
            && self.width > 0.0
            && self.height > 0.0
            && self.dpr > 0.0
            && self.fb_width > 0
            && self.fb_height > 0
    }

    /// Framebuffer pixel under a point given in physical pixels of the
    /// viewport, or `None` outside the canvas. Same rounding and clamping as
    /// `mapClientToFramebuffer(..., "one")` in `src/lib/vnc.ts`.
    pub fn framebuffer_point(&self, client_x: f64, client_y: f64) -> Option<(u16, u16)> {
        let x = client_x / self.dpr;
        let y = client_y / self.dpr;
        if x < self.left
            || y < self.top
            || x >= self.left + self.width
            || y >= self.top + self.height
        {
            return None;
        }
        let fx = ((x - self.left) * f64::from(self.fb_width) / self.width).round();
        let fy = ((y - self.top) * f64::from(self.fb_height) / self.height).round();
        Some((
            fx.clamp(0.0, f64::from(self.fb_width - 1)) as u16,
            fy.clamp(0.0, f64::from(self.fb_height - 1)) as u16,
        ))
    }
}

/// Whether this platform build offers native sampling to the WebView.
pub fn supported() -> bool {
    cfg!(windows) && std::env::var_os("TAOMNI_VNC_NATIVE_POINTER").is_none_or(|value| value != "0")
}

#[cfg(windows)]
pub use windows_impl::NativePointerSampler;

#[cfg(not(windows))]
pub struct NativePointerSampler;

#[cfg(not(windows))]
impl NativePointerSampler {
    pub fn new() -> Self {
        Self
    }

    /// The relay never offers sampling here; the WebView sends every move.
    pub fn set(&mut self, _target: Option<NativePointerTarget>, _control: &Sender<VncControl>) {}

    pub fn set_buttons_held(&mut self, _held: bool) {}
}

#[cfg(windows)]
mod windows_impl {
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use winapi::shared::windef::{HWND, POINT};
    use winapi::um::processthreadsapi::GetCurrentProcessId;
    use winapi::um::winuser::{
        GA_ROOT, GetAncestor, GetCursorPos, GetWindowThreadProcessId, ScreenToClient,
        WindowFromPoint,
    };

    use super::{NativePointerTarget, Sender, VncControl};

    /// Poll interval right after the cursor moved, and once it has rested.
    const ACTIVE_INTERVAL: Duration = Duration::from_millis(1);
    const IDLE_INTERVAL: Duration = Duration::from_millis(4);
    const ACTIVE_FOR: Duration = Duration::from_millis(250);
    const OFF_INTERVAL: Duration = Duration::from_millis(20);

    #[derive(Default)]
    struct Shared {
        target: Option<NativePointerTarget>,
        /// Top-level window (ours) that hosts the canvas, as an address.
        root: usize,
        /// A WebView-reported button is down: the WebView owns the pointer.
        buttons_held: bool,
        stop: bool,
    }

    /// One sampler per relay; the thread starts on first use and stops when
    /// the sampler is dropped or the relay's control channel closes.
    pub struct NativePointerSampler {
        shared: Arc<Mutex<Shared>>,
        started: bool,
    }

    impl NativePointerSampler {
        pub fn new() -> Self {
            Self {
                shared: Arc::new(Mutex::new(Shared::default())),
                started: false,
            }
        }

        /// Pause sampling while a button is held (the relay drops samples
        /// then anyway; this keeps them out of the control queue).
        pub fn set_buttons_held(&mut self, held: bool) {
            if let Ok(mut shared) = self.shared.lock() {
                shared.buttons_held = held;
            }
        }

        /// Start (`Some`) or pause (`None`) sampling for `control`'s relay.
        pub fn set(&mut self, target: Option<NativePointerTarget>, control: &Sender<VncControl>) {
            let target = target.filter(NativePointerTarget::valid);
            {
                let Ok(mut shared) = self.shared.lock() else {
                    return;
                };
                if target.is_some() {
                    // The canvas reports itself while the cursor is over it,
                    // so the window under the cursor is the one hosting it.
                    if let Some(root) = root_under_cursor() {
                        shared.root = root;
                    }
                }
                shared.target = target;
            }
            if target.is_some() && !self.started {
                let shared = self.shared.clone();
                let control = control.clone();
                self.started = std::thread::Builder::new()
                    .name("vnc-native-pointer".into())
                    .spawn(move || run(shared, control))
                    .is_ok();
            }
        }
    }

    impl Drop for NativePointerSampler {
        fn drop(&mut self) {
            if let Ok(mut shared) = self.shared.lock() {
                shared.stop = true;
            }
        }
    }

    fn cursor() -> Option<POINT> {
        let mut point = POINT { x: 0, y: 0 };
        // SAFETY: GetCursorPos writes one POINT through a valid pointer.
        (unsafe { GetCursorPos(&mut point) } != 0).then_some(point)
    }

    /// Top-level window under `point` when this process owns it.
    fn root_at(point: POINT) -> Option<HWND> {
        // SAFETY: plain window queries; null handles are checked.
        unsafe {
            let hit = WindowFromPoint(point);
            if hit.is_null() {
                return None;
            }
            let root = GetAncestor(hit, GA_ROOT);
            if root.is_null() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(root, &mut pid);
            (pid == GetCurrentProcessId()).then_some(root)
        }
    }

    fn root_under_cursor() -> Option<usize> {
        cursor().and_then(root_at).map(|root| root as usize)
    }

    fn run(shared: Arc<Mutex<Shared>>, control: Sender<VncControl>) {
        let mut last_point: Option<(i32, i32)> = None;
        let mut last_sent: Option<(u16, u16)> = None;
        let mut moved_at = Instant::now()
            .checked_sub(ACTIVE_FOR)
            .unwrap_or_else(Instant::now);
        loop {
            let (target, root) = match shared.lock() {
                Ok(shared) if !shared.stop => {
                    (shared.target.filter(|_| !shared.buttons_held), shared.root)
                }
                _ => return,
            };
            if control.is_closed() {
                return;
            }
            let Some(target) = target else {
                last_point = None;
                last_sent = None;
                std::thread::sleep(OFF_INTERVAL);
                continue;
            };
            if let Some(point) = cursor()
                && last_point != Some((point.x, point.y))
            {
                last_point = Some((point.x, point.y));
                moved_at = Instant::now();
                if let Some(position) = framebuffer_position(point, root, &target)
                    && last_sent != Some(position)
                {
                    let (x, y) = position;
                    match control.try_send(VncControl::SampledPointer { x, y }) {
                        Ok(()) => last_sent = Some(position),
                        // A full queue drops this sample; the next one sends
                        // the then-current position.
                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {}
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => return,
                    }
                }
            }
            std::thread::sleep(if moved_at.elapsed() < ACTIVE_FOR {
                ACTIVE_INTERVAL
            } else {
                IDLE_INTERVAL
            });
        }
    }

    /// The framebuffer pixel for a screen point over our canvas window; `None`
    /// when another window is in front of it or the point is off the canvas.
    /// An unknown `root` (0: the cursor had left when sampling started)
    /// accepts any window of this process.
    fn framebuffer_position(
        point: POINT,
        root: usize,
        target: &NativePointerTarget,
    ) -> Option<(u16, u16)> {
        let window = root_at(point)?;
        if root != 0 && window as usize != root {
            return None;
        }
        let mut client = point;
        // SAFETY: converts one POINT for a live window handle.
        if unsafe { ScreenToClient(window, &mut client) } == 0 {
            return None;
        }
        target.framebuffer_point(f64::from(client.x), f64::from(client.y))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> NativePointerTarget {
        NativePointerTarget {
            left: 100.0,
            top: 50.0,
            width: 800.0,
            height: 450.0,
            dpr: 1.25,
            fb_width: 1600,
            fb_height: 900,
        }
    }

    #[test]
    fn maps_physical_viewport_pixels_like_the_webview() {
        let target = target();
        // CSS (100, 50) is the canvas origin: physical (125, 62.5).
        assert_eq!(target.framebuffer_point(125.0, 62.5), Some((0, 0)));
        // CSS (500, 275) is the middle; the framebuffer is twice the box.
        assert_eq!(target.framebuffer_point(625.0, 343.75), Some((800, 450)));
        // The last CSS pixel row/column clamps to the framebuffer edge.
        assert_eq!(target.framebuffer_point(1124.9, 624.9), Some((1599, 899)));
    }

    #[test]
    fn points_outside_the_canvas_are_not_sampled() {
        let target = target();
        assert_eq!(target.framebuffer_point(124.0, 100.0), None);
        assert_eq!(target.framebuffer_point(1125.0, 100.0), None);
        assert_eq!(target.framebuffer_point(300.0, 625.0), None);
    }

    #[test]
    fn rejects_degenerate_geometry() {
        assert!(target().valid());
        for broken in [
            NativePointerTarget {
                width: 0.0,
                ..target()
            },
            NativePointerTarget {
                dpr: f64::NAN,
                ..target()
            },
            NativePointerTarget {
                fb_height: 0,
                ..target()
            },
        ] {
            assert!(!broken.valid(), "{broken:?}");
        }
    }
}
