//! Multiple pinned screenshots: per-pin notes, listing, arrangement and
//! batch actions.
//!
//! Every pin is its own native window. Arrangement is computed here in
//! physical pixels against the monitor work area (so docks, taskbars and
//! panels are avoided on every platform), then applied with native
//! `set_position` / `set_size`. Actions that change a pin's own UI state
//! (collapse, opacity) are broadcast as [`PIN_ACTION_EVENT`] and applied by
//! each pin window, which keeps its renderer the single owner of that state.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use super::{PIN_LABEL_PREFIX, tool_state};

/// Pin windows listen for this to apply a batch action to themselves.
pub const PIN_ACTION_EVENT: &str = "screenshot://pin-action";
/// Emitted when a pin's note changes so other pins' menus can refresh.
pub const PINS_CHANGED_EVENT: &str = "screenshot://pins-changed";
/// Longest accepted note (characters); notes are labels, not documents.
pub const MAX_NOTE_CHARS: usize = 500;
/// Smallest pin arranged by tiling (logical px), so content stays legible.
const MIN_ARRANGED: f64 = 96.0;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PinArrangement {
    /// Grid filling the work area; pins scale down to fit, never up.
    Tile,
    /// Diagonal stack from the top-left, keeping sizes.
    Cascade,
    /// Column(s) along the right edge.
    StackRight,
    /// Row(s) along the bottom edge.
    StackBottom,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PinBatchAction {
    Collapse,
    Expand,
    ResetOpacity,
    CloseAll,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinSummary {
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub note: String,
    /// Opening order (1-based) for stable menus.
    pub order: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Normalize a note: trimmed, at most [`MAX_NOTE_CHARS`] characters,
/// control characters other than newlines removed.
pub fn normalize_note(note: &str) -> String {
    note.trim()
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .take(MAX_NOTE_CHARS)
        .collect()
}

fn fit(size: (f64, f64), max_w: f64, max_h: f64, min: f64) -> (f64, f64) {
    let (w, h) = (size.0.max(1.0), size.1.max(1.0));
    let k = (max_w / w).min(max_h / h).min(1.0);
    // Never shrink below `min` on the long side unless the area itself is smaller.
    let k = k.max((min / w.max(h)).min(1.0).min(max_w / w).min(max_h / h));
    ((w * k).round().max(1.0), (h * k).round().max(1.0))
}

fn clamp_into(area: Rect, x: f64, y: f64, w: f64, h: f64) -> Rect {
    let w = w.min(area.w);
    let h = h.min(area.h);
    Rect {
        x: x.clamp(area.x, area.x + area.w - w).round(),
        y: y.clamp(area.y, area.y + area.h - h).round(),
        w,
        h,
    }
}

/// Target rects for pins of `sizes` (current window sizes, same units as
/// `area`), in input order. `scale` converts logical spacing to `area` units.
pub fn arrange(sizes: &[(f64, f64)], area: Rect, mode: PinArrangement, scale: f64) -> Vec<Rect> {
    let n = sizes.len();
    if n == 0 || area.w <= 0.0 || area.h <= 0.0 {
        return Vec::new();
    }
    let s = scale.max(0.5);
    let gap = 12.0 * s;
    let min = MIN_ARRANGED * s;
    match mode {
        PinArrangement::Tile => {
            // Choose the column count that gives pins the largest area.
            let aspect = sizes.iter().map(|(w, h)| w / h.max(1.0)).sum::<f64>() / n as f64;
            let mut best = (1usize, f64::MIN);
            for cols in 1..=n {
                let rows = n.div_ceil(cols);
                let cw = (area.w - gap * (cols as f64 + 1.0)) / cols as f64;
                let ch = (area.h - gap * (rows as f64 + 1.0)) / rows as f64;
                if cw <= 0.0 || ch <= 0.0 {
                    continue;
                }
                let w = cw.min(ch * aspect);
                let score = w * (w / aspect);
                if score > best.1 {
                    best = (cols, score);
                }
            }
            let cols = best.0;
            let rows = n.div_ceil(cols);
            let cw = ((area.w - gap * (cols as f64 + 1.0)) / cols as f64).max(1.0);
            let ch = ((area.h - gap * (rows as f64 + 1.0)) / rows as f64).max(1.0);
            sizes
                .iter()
                .enumerate()
                .map(|(i, size)| {
                    let (w, h) = fit(*size, cw, ch, min.min(cw).min(ch));
                    let (col, row) = ((i % cols) as f64, (i / cols) as f64);
                    let x = area.x + gap + col * (cw + gap) + (cw - w) / 2.0;
                    let y = area.y + gap + row * (ch + gap) + (ch - h) / 2.0;
                    clamp_into(area, x, y, w, h)
                })
                .collect()
        }
        PinArrangement::Cascade => {
            let step = 32.0 * s;
            // Restart the diagonal every ten pins so all stay on screen.
            let depth = (n - 1).min(10) as f64;
            let (max_w, max_h) = (area.w - gap * 2.0 - step * depth, area.h - gap * 2.0 - step * depth);
            sizes
                .iter()
                .enumerate()
                .map(|(i, size)| {
                    let (w, h) = fit(*size, max_w.max(1.0), max_h.max(1.0), min);
                    let k = (i % 11) as f64;
                    clamp_into(area, area.x + gap + k * step, area.y + gap + k * step, w, h)
                })
                .collect()
        }
        PinArrangement::StackRight | PinArrangement::StackBottom => {
            let vertical = mode == PinArrangement::StackRight;
            // Each line is about a quarter of the screen: a sidebar, not a takeover.
            let line = ((if vertical { area.w } else { area.h }) / 4.0).max(min);
            let limit = if vertical { area.h } else { area.w };
            let mut out = Vec::with_capacity(n);
            let (mut index, mut cursor) = (0.0, gap);
            for size in sizes {
                let (w, h) = if vertical {
                    fit(*size, line, area.h - gap * 2.0, min.min(line))
                } else {
                    fit(*size, area.w - gap * 2.0, line, min.min(line))
                };
                let length = if vertical { h } else { w };
                if cursor + length + gap > limit && cursor > gap {
                    index += 1.0;
                    cursor = gap;
                }
                let across = gap + index * (line + gap);
                out.push(if vertical {
                    clamp_into(area, area.x + area.w - across - w, area.y + cursor, w, h)
                } else {
                    clamp_into(area, area.x + cursor, area.y + area.h - across - h, w, h)
                });
                cursor += length + gap;
            }
            out
        }
    }
}

fn pin_windows(app: &AppHandle) -> Vec<(u64, WebviewWindow)> {
    let mut pins: Vec<(u64, WebviewWindow)> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(PIN_LABEL_PREFIX) && label != BOARD_LABEL)
        .map(|(label, window)| (pin_order(&label), window))
        .collect();
    pins.sort_by_key(|(order, _)| *order);
    pins
}

fn pin_order(label: &str) -> u64 {
    label
        .strip_prefix(PIN_LABEL_PREFIX)
        .and_then(|n| n.parse().ok())
        .unwrap_or(u64::MAX)
}

/// All open pins in opening order.
#[tauri::command]
pub async fn screenshot_list_pins(app: AppHandle) -> Result<Vec<PinSummary>, String> {
    let open: Vec<String> = pin_windows(&app)
        .into_iter()
        .map(|(_, w)| w.label().to_string())
        .collect();
    let state = tool_state();
    Ok(open
        .into_iter()
        .filter_map(|label| {
            state.pins.get(&label).map(|pin| PinSummary {
                order: pin_order(&label),
                width: pin.width,
                height: pin.height,
                note: pin.note.clone(),
                label,
            })
        })
        .collect())
}

/// Set the calling pin's note (empty clears it). Returns the stored note.
#[tauri::command]
pub async fn screenshot_set_pin_note(
    app: AppHandle,
    window: WebviewWindow,
    note: String,
) -> Result<String, String> {
    let label = window.label().to_string();
    if !label.starts_with(PIN_LABEL_PREFIX) {
        return Err("not a pin window".into());
    }
    let note = normalize_note(&note);
    {
        let mut state = tool_state();
        let pin = state
            .pins
            .get_mut(&label)
            .ok_or("no pinned screenshot for this window")?;
        pin.note = note.clone();
    }
    let _ = app.emit(PINS_CHANGED_EVENT, ());
    Ok(note)
}

/// GDK monitor/work-area queries can issue Xlib requests. Always snapshot them
/// on the UI thread, including calls made by asynchronous commands and QA.
pub(super) async fn pin_monitor(
    app: &AppHandle,
    window: WebviewWindow,
) -> Result<tauri::Monitor, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let monitor = window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.primary_monitor().ok().flatten())
            .ok_or_else(|| "no monitor for pin arrangement".to_string());
        let _ = tx.send(monitor);
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(5), rx)
        .await
        .map_err(|_| "monitor query timed out".to_string())?
        .map_err(|e| e.to_string())?
}

/// Move and size every open pin according to `mode` on the monitor showing
/// `anchor` (the requesting pin), or the primary monitor.
#[tauri::command]
pub async fn screenshot_arrange_pins(
    app: AppHandle,
    mode: PinArrangement,
    anchor: Option<String>,
) -> Result<usize, String> {
    let pins = pin_windows(&app);
    if pins.is_empty() {
        return Ok(0);
    }
    if native_wayland() {
        open_board(&app, mode)?;
        return Ok(pins.len());
    }
    let anchor_window = anchor
        .and_then(|label| app.get_webview_window(&label))
        .unwrap_or_else(|| pins[0].1.clone());
    let monitor = pin_monitor(&app, anchor_window).await?;
    let work = monitor.work_area();
    let area = Rect {
        x: work.position.x as f64,
        y: work.position.y as f64,
        w: work.size.width as f64,
        h: work.size.height as f64,
    };
    let mut sizes = Vec::with_capacity(pins.len());
    for (_, window) in &pins {
        let size = window.inner_size().map_err(|e| e.to_string())?;
        sizes.push((size.width as f64, size.height as f64));
    }
    let targets = arrange(&sizes, area, mode, monitor.scale_factor());
    for ((_, window), rect) in pins.iter().zip(&targets) {
        // Collapsed (64px) pins keep their size; only their position moves.
        let collapsed = window
            .inner_size()
            .map(|s| s.width as f64 <= 70.0 * monitor.scale_factor())
            .unwrap_or(false);
        if !collapsed {
            window.set_size(PhysicalSize::new(rect.w as u32, rect.h as u32)).map_err(|e| e.to_string())?;
        }
        window.set_position(PhysicalPosition::new(rect.x as i32, rect.y as i32)).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(PIN_ACTION_EVENT, serde_json::json!({ "action": "arranged" }));
    Ok(targets.len())
}

/// Apply one action to every open pin. Closing happens here; view-state
/// actions are applied by each pin window through [`PIN_ACTION_EVENT`].
#[tauri::command]
pub async fn screenshot_pins_batch(app: AppHandle, action: PinBatchAction) -> Result<usize, String> {
    let pins = pin_windows(&app);
    let count = pins.len();
    if action == PinBatchAction::CloseAll {
        for (_, window) in pins {
            let _ = window.close();
        }
        return Ok(count);
    }
    app.emit(PIN_ACTION_EVENT, serde_json::json!({ "action": action }))
        .map_err(|e| e.to_string())?;
    Ok(count)
}

/// Raise one pin (from another pin's list) above the others.
#[tauri::command]
pub async fn screenshot_focus_pin(app: AppHandle, label: String) -> Result<(), String> {
    if !label.starts_with(PIN_LABEL_PREFIX) {
        return Err("not a pin window".into());
    }
    let window = app.get_webview_window(&label).ok_or("pin is closed")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

const BOARD_LABEL: &str = "screenshot-pin-board";

pub fn native_wayland() -> bool {
    super::NATIVE_WAYLAND.load(std::sync::atomic::Ordering::SeqCst)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardPin {
    label: String,
    #[serde(flatten)]
    pin: super::PinInit,
}

#[tauri::command]
pub fn screenshot_board_pins() -> Vec<BoardPin> {
    let mut pins: Vec<_> = super::tool_state().pins.iter().map(|(label, pin)| BoardPin { label: label.clone(), pin: pin.clone() }).collect();
    pins.sort_by_key(|pin| pin_order(&pin.label));
    pins
}

fn open_board(app: &AppHandle, mode: PinArrangement) -> Result<(), String> {
    let board = if let Some(board) = app.get_webview_window(BOARD_LABEL) { board } else {
        let board = super::window_builder(app, BOARD_LABEL, tauri::WebviewUrl::App("index.html#screenshot-pin-board".into()))
            .title("Pinned screenshots").inner_size(1000.0, 700.0).always_on_top(true).build().map_err(|e| e.to_string())?;
        let handle = app.clone();
        board.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                for (_, pin) in pin_windows(&handle) { let _ = pin.show(); }
            }
        });
        board
    };
    board.show().map_err(|e| e.to_string())?;
    board.set_focus().map_err(|e| e.to_string())?;
    for (_, pin) in pin_windows(app) { pin.hide().map_err(|e| e.to_string())?; }
    app.emit(PIN_ACTION_EVENT, serde_json::json!({"action":"arranged", "mode":mode})).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1040.0 };

    fn inside(r: &Rect, area: Rect) -> bool {
        r.x >= area.x && r.y >= area.y && r.x + r.w <= area.x + area.w + 0.5 && r.y + r.h <= area.y + area.h + 0.5
    }

    fn overlaps(a: &Rect, b: &Rect) -> bool {
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    }

    #[test]
    fn tile_never_overlaps_or_leaves_the_work_area() {
        for n in 1..=12 {
            let sizes: Vec<_> = (0..n).map(|i| (400.0 + i as f64 * 37.0, 300.0)).collect();
            let rects = arrange(&sizes, AREA, PinArrangement::Tile, 1.0);
            assert_eq!(rects.len(), n);
            for (i, r) in rects.iter().enumerate() {
                assert!(inside(r, AREA), "{n} pins: {r:?}");
                for other in &rects[i + 1..] {
                    assert!(!overlaps(r, other), "{n} pins overlap: {r:?} {other:?}");
                }
            }
        }
    }

    #[test]
    fn tile_keeps_aspect_and_never_upscales() {
        let rects = arrange(&[(200.0, 100.0)], AREA, PinArrangement::Tile, 1.0);
        assert_eq!((rects[0].w, rects[0].h), (200.0, 100.0));
        let big = arrange(&[(4000.0, 2000.0), (4000.0, 2000.0)], AREA, PinArrangement::Tile, 1.0);
        for r in &big {
            assert!((r.w / r.h - 2.0).abs() < 0.02, "{r:?}");
            assert!(r.w < 4000.0);
        }
    }

    #[test]
    fn work_area_offset_is_respected_on_secondary_or_panel_monitors() {
        let area = Rect { x: -1280.0, y: 40.0, w: 1280.0, h: 984.0 };
        for mode in [PinArrangement::Tile, PinArrangement::Cascade, PinArrangement::StackRight, PinArrangement::StackBottom] {
            for r in arrange(&[(500.0, 400.0); 7], area, mode, 1.0) {
                assert!(inside(&r, area), "{mode:?}: {r:?}");
            }
        }
    }

    #[test]
    fn cascade_steps_diagonally_and_wraps_after_ten() {
        let rects = arrange(&[(300.0, 200.0); 12], AREA, PinArrangement::Cascade, 2.0);
        assert_eq!(rects[1].x - rects[0].x, 64.0);
        assert_eq!(rects[1].y - rects[0].y, 64.0);
        assert_eq!(rects[11].x, rects[0].x);
    }

    #[test]
    fn stacks_hug_their_edge_and_wrap_without_overlap() {
        let sizes = vec![(600.0, 500.0); 6];
        let right = arrange(&sizes, AREA, PinArrangement::StackRight, 1.0);
        assert!((right[0].x + right[0].w - (AREA.w - 12.0)).abs() < 1.0);
        let bottom = arrange(&sizes, AREA, PinArrangement::StackBottom, 1.0);
        assert!((bottom[0].y + bottom[0].h - (AREA.h - 12.0)).abs() < 1.0);
        for rects in [right, bottom] {
            for (i, r) in rects.iter().enumerate() {
                assert!(inside(r, AREA));
                for other in &rects[i + 1..] {
                    assert!(!overlaps(r, other), "{r:?} {other:?}");
                }
            }
        }
    }

    #[test]
    fn empty_input_and_degenerate_area_are_noops() {
        assert!(arrange(&[], AREA, PinArrangement::Tile, 1.0).is_empty());
        assert!(arrange(&[(10.0, 10.0)], Rect { x: 0.0, y: 0.0, w: 0.0, h: 10.0 }, PinArrangement::Tile, 1.0).is_empty());
    }

    #[test]
    fn notes_are_trimmed_bounded_and_stripped_of_control_characters() {
        assert_eq!(normalize_note("  login page\u{7}  "), "login page");
        assert_eq!(normalize_note("line 1\nline 2"), "line 1\nline 2");
        assert_eq!(normalize_note(&"x".repeat(900)).chars().count(), MAX_NOTE_CHARS);
        assert_eq!(normalize_note(&"字".repeat(600)).chars().count(), MAX_NOTE_CHARS);
    }
}
