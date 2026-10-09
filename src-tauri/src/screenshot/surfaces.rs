//! Capture controls and range outlines stay outside the captured pixels.
//! Content protection alone is insufficient on Linux and newer macOS versions.

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WindowBuilder, window::Color};

use super::capture::DisplayInfo;

pub const SCROLL_LABEL: &str = "screenshot-scroll";
pub const BORDER_PREFIX: &str = "screenshot-boundary-";
pub const CONTROL_WIDTH: f64 = 360.0;
// GTK can give even compact WebViews a 200px minimum height. Reserve that
// space on every platform so controls positioned above a crop stay outside it.
pub const CONTROL_HEIGHT: f64 = 200.0;

// macOS NSWindowSharingNone participates in WindowServer selective sharing,
// implicated in the macOS 14 display-stream crash. Our controls and borders
// are already placed outside the crop (or hidden for full-display capture).
pub const PROTECT_CAPTURE_SURFACES: bool = cfg!(target_os = "windows");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn intersects(self, other: Self) -> bool {
        self.x < other.x + other.w
            && other.x < self.x + self.w
            && self.y < other.y + other.h
            && other.y < self.y + self.h
    }
    fn contains(self, other: Self) -> bool {
        other.x >= self.x
            && other.y >= self.y
            && other.x + other.w <= self.x + self.w
            && other.y + other.h <= self.y + self.h
    }
}

pub fn region_rect(display: &DisplayInfo, region: (u32, u32, u32, u32)) -> Rect {
    Rect {
        x: display.x + region.0 as i32,
        y: display.y + region.1 as i32,
        w: region.2 as i32,
        h: region.3 as i32,
    }
}

/// Reserve the largest active control size, including status/error rows.
pub fn control_position(displays: &[DisplayInfo], region: Rect) -> Option<Rect> {
    for d in displays {
        let scale = d.scale_factor.max(0.5);
        let w = (CONTROL_WIDTH * scale).ceil() as i32;
        let h = (CONTROL_HEIGHT * scale).ceil() as i32;
        let gap = (8.0 * scale).ceil() as i32;
        let screen = Rect {
            x: d.x,
            y: d.y,
            w: d.width as i32,
            h: d.height as i32,
        };
        let cx = (region.x + (region.w - w) / 2)
            .clamp(screen.x, (screen.x + screen.w - w).max(screen.x));
        let cy = region
            .y
            .clamp(screen.y, (screen.y + screen.h - h).max(screen.y));
        let candidates = [
            Rect {
                x: cx,
                y: region.y + region.h + gap,
                w,
                h,
            },
            Rect {
                x: cx,
                y: region.y - h - gap,
                w,
                h,
            },
            Rect {
                x: region.x + region.w + gap,
                y: cy,
                w,
                h,
            },
            Rect {
                x: region.x - w - gap,
                y: cy,
                w,
                h,
            },
            Rect {
                x: screen.x + gap,
                y: screen.y + gap,
                w,
                h,
            },
        ];
        if let Some(rect) = candidates
            .into_iter()
            .find(|r| screen.contains(*r) && !region.intersects(*r))
        {
            return Some(rect);
        }
    }
    None
}

/// Fallback when [`control_position`] finds no room (a full-display or very
/// large selection): reserve a control strip inside the bottom of `region` and
/// shrink the captured region above it, so the controls stay visible and are
/// never part of the capture. Returns `(captured region, controls)` in
/// virtual-desktop physical pixels, or `None` when too little would remain.
pub fn inside_control_strip(
    display: &DisplayInfo,
    region: Rect,
    min_height: i32,
) -> Option<(Rect, Rect)> {
    let scale = display.scale_factor.max(0.5);
    let w = ((CONTROL_WIDTH * scale).ceil() as i32).min(display.width as i32);
    let h = (CONTROL_HEIGHT * scale).ceil() as i32;
    let gap = (8.0 * scale).ceil() as i32;
    // Clip to the display first: the strip must be on the same screen.
    let screen = Rect {
        x: display.x,
        y: display.y,
        w: display.width as i32,
        h: display.height as i32,
    };
    let left = region.x.max(screen.x);
    let top = region.y.max(screen.y);
    let right = (region.x + region.w).min(screen.x + screen.w);
    let bottom = (region.y + region.h).min(screen.y + screen.h);
    let remaining = bottom - top - h - gap;
    if right - left <= 0 || remaining < min_height {
        return None;
    }
    let captured = Rect {
        x: left,
        y: top,
        w: right - left,
        h: remaining,
    };
    let x = (left + (right - left - w) / 2).clamp(screen.x, screen.x + screen.w - w);
    let controls = Rect {
        x,
        y: bottom - h,
        w,
        h,
    };
    Some((captured, controls))
}

pub fn borders(region: Rect, thickness: i32) -> [Rect; 4] {
    [
        Rect {
            x: region.x - thickness,
            y: region.y - thickness,
            w: region.w + thickness * 2,
            h: thickness,
        },
        Rect {
            x: region.x - thickness,
            y: region.y + region.h,
            w: region.w + thickness * 2,
            h: thickness,
        },
        Rect {
            x: region.x - thickness,
            y: region.y,
            w: thickness,
            h: region.h,
        },
        Rect {
            x: region.x + region.w,
            y: region.y,
            w: thickness,
            h: region.h,
        },
    ]
}

pub fn close_borders(app: &AppHandle) {
    for (label, window) in app.windows() {
        if label.starts_with(BORDER_PREFIX) {
            let _ = window.close();
        }
    }
}

#[cfg(target_os = "linux")]
fn request_gtk_border_size(window: &tauri::Window, width: f64, height: f64) -> Result<(), String> {
    let border = window.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            use webkit2gtk::glib::prelude::ObjectExt;
            let result = border.gtk_window().map(|gtk| {
                let width = width.round().max(1.0) as i32;
                let height = height.round().max(1.0) as i32;
                // GTK's empty-window natural size is 200x200. A widget size
                // request disables that fallback; geometry hints alone are
                // raised to the natural size for a non-resizable window.
                gtk.set_property("width-request", width);
                gtk.set_property("height-request", height);
                gtk.set_property("default-width", width);
                gtk.set_property("default-height", height);
            });
            let _ = tx.send(result.map_err(|e| e.to_string()));
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("configure GTK capture range: {e}"))?
}

pub fn open_borders(app: &AppHandle, display: &DisplayInfo, region: Rect) -> Result<(), String> {
    close_borders(app);
    let result = (|| {
        for (i, rect) in borders(region, (2.0 * display.scale_factor.max(1.0)).ceil() as i32)
            .into_iter()
            .enumerate()
        {
            // Off-screen windows may be clamped back on-screen by a window
            // manager. Create only the visible border pixels outside the crop.
            let right = (rect.x + rect.w).min(display.x + display.width as i32);
            let bottom = (rect.y + rect.h).min(display.y + display.height as i32);
            let rect = Rect {
                x: rect.x.max(display.x),
                y: rect.y.max(display.y),
                w: right - rect.x.max(display.x),
                h: bottom - rect.y.max(display.y),
            };
            if rect.w <= 0 || rect.h <= 0 {
                continue;
            }
            let scale = display.scale_factor.max(0.5);
            let (width, height) = (rect.w as f64 / scale, rect.h as f64 / scale);
            let window = WindowBuilder::new(app, format!("{BORDER_PREFIX}{i}"))
                .background_color(Color(255, 77, 79, 255))
                .title(format!("Capture range {i}"))
                // Empty GTK windows otherwise use a 200px size when first
                // shown. Establish the thin dimensions before realization
                // and constrain both axes for this fixed, native surface.
                .inner_size(width, height)
                .min_inner_size(width, height)
                .max_inner_size(width, height)
                .visible(false)
                .decorations(false)
                .resizable(false)
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .content_protected(PROTECT_CAPTURE_SURFACES)
                .focused(false)
                .build()
                .map_err(|e| format!("open capture range: {e}"))?;
            #[cfg(target_os = "linux")]
            super::surface_backend::border(&window)?;
            window
                .set_position(PhysicalPosition::new(rect.x, rect.y))
                .map_err(|e| e.to_string())?;
            window
                .set_size(PhysicalSize::new(rect.w as u32, rect.h as u32))
                .map_err(|e| e.to_string())?;
            #[cfg(target_os = "linux")]
            request_gtk_border_size(&window, width, height)?;
            // GTK creates its GDK surface on show. Applying an input shape
            // before that makes Tao unwrap a missing native window.
            window.show().map_err(|e| e.to_string())?;
            window
                .set_ignore_cursor_events(true)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        close_borders(app);
    }
    result
}

/// Restrict native input to the bottom control strip on a fullscreen
/// Wayland surface. Apply on every GTK allocation (the compositor chooses
/// the fullscreen size asynchronously) and to the embedded WebView window.
#[cfg(target_os = "linux")]
pub fn configure_wayland_scroll(window: &tauri::WebviewWindow) -> Result<(), String> {
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            use gtk::prelude::*;
            if let Ok(gtk) = target.gtk_window() {
                let allocation = gtk.allocation();
                let region = gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(
                    0,
                    (allocation.height() - CONTROL_HEIGHT as i32).max(0),
                    allocation.width(),
                    CONTROL_HEIGHT as i32,
                ));
                if let Some(gdk_window) = gtk.window() {
                    gdk_window.input_shape_combine_region(&region, 0, 0);
                    gdk_window.display().flush();
                }
                gtk.connect_size_allocate(move |widget, allocation| {
                    if let Some(gdk_window) = widget.window() {
                        let region =
                            gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(
                                0,
                                (allocation.height() - CONTROL_HEIGHT as i32).max(0),
                                allocation.width(),
                                CONTROL_HEIGHT as i32,
                            ));
                        gdk_window.input_shape_combine_region(&region, 0, 0);
                        gdk_window.display().flush();
                    }
                });
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn display(x: i32, y: i32, scale: f64) -> DisplayInfo {
        DisplayInfo {
            id: format!("{x},{y}"),
            name: "test".into(),
            x,
            y,
            width: 1920,
            height: 1080,
            scale_factor: scale,
            primary: x == 0,
        }
    }
    #[test]
    fn controls_and_borders_never_overlap_capture_on_offset_and_hidpi_displays() {
        for (x, y, scale) in [(0, 0, 1.0), (-1920, -200, 1.0), (100, 200, 2.0)] {
            let d = display(x, y, scale);
            let region = region_rect(&d, (400, 150, 800, 500));
            let bar = control_position(&[d], region).unwrap();
            assert!(!region.intersects(bar));
            assert!(borders(region, 4).iter().all(|b| !region.intersects(*b)));
        }
    }
    #[test]
    fn full_display_selection_reserves_an_inside_strip_outside_the_capture() {
        for (x, y, scale) in [(0, 0, 1.0), (-1920, -200, 1.0), (100, 200, 2.0)] {
            let d = display(x, y, scale);
            let region = region_rect(&d, (0, 0, d.width, d.height));
            assert_eq!(control_position(&[d.clone()], region), None);
            let (captured, controls) = inside_control_strip(&d, region, 48).unwrap();
            assert!(!captured.intersects(controls), "{captured:?} {controls:?}");
            // Borders drawn around the shrunk region stay off the controls too.
            let thickness = (2.0 * scale).ceil() as i32;
            assert!(
                borders(captured, thickness)
                    .iter()
                    .all(|b| !b.intersects(controls))
            );
            let screen = Rect {
                x: d.x,
                y: d.y,
                w: d.width as i32,
                h: d.height as i32,
            };
            assert!(screen.contains(controls) && screen.contains(captured));
            assert_eq!(captured.w, d.width as i32);
            assert!(captured.h >= d.height as i32 - ((CONTROL_HEIGHT + 8.0) * scale).ceil() as i32);
        }
    }

    #[test]
    fn inside_strip_rejects_regions_too_short_to_keep_content() {
        let d = display(0, 0, 1.0);
        let region = region_rect(&d, (0, 0, d.width, 240));
        assert!(inside_control_strip(&d, region, 48).is_none());
        let region = region_rect(&d, (0, 0, d.width, 300));
        assert_eq!(inside_control_strip(&d, region, 48).unwrap().0.h, 92);
    }

    #[test]
    fn full_display_controls_use_another_monitor_or_remain_hidden() {
        let d = display(0, 0, 1.0);
        let region = region_rect(&d, (0, 0, d.width, d.height));
        assert_eq!(control_position(&[d.clone()], region), None);
        let bar = control_position(&[d, display(-1920, 0, 1.0)], region).unwrap();
        assert!(!region.intersects(bar));
        assert!(bar.x < 0);
    }
}
