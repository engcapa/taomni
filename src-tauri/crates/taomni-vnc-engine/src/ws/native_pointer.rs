use serde::Deserialize;
use tokio::sync::mpsc::Sender;

use super::VncControl;

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

/// A desktop window owner can supply native pointer samples to its relay.
pub trait NativePointer: Send + 'static {
    fn set(&mut self, target: Option<NativePointerTarget>, control: &Sender<VncControl>);

    fn set_buttons_held(&mut self, held: bool);
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
