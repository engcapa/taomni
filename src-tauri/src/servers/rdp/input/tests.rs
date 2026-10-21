use super::actor::RdpInput;
#[cfg(target_os = "macos")]
use super::macos::MacInputMapping;
#[cfg(any(target_os = "macos", test))]
use super::macos::map_surface_coordinate;
use super::queue::InputCmd;
use super::queue::InputQueue;
use super::queue::InputQueuePush;
use super::queue::QueuedInput;
#[cfg(any(target_os = "linux", test))]
use super::scancodes::linux_scancode_to_keycode;
#[cfg(any(target_os = "windows", test))]
use super::windows::windows_scancode_parts;
use enigo::Button;
use enigo::Coordinate;
use enigo::Direction::Press;
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU32;
#[cfg(target_os = "macos")]
use std::sync::atomic::Ordering;
use std::time::Instant;

fn absolute_move(x: i32) -> QueuedInput {
    QueuedInput {
        received_at: Instant::now(),
        cmd: InputCmd::MoveMouse {
            x,
            y: 0,
            coord: Coordinate::Abs,
        },
    }
}

/// `RdpServerInputHandler: Send` and `ironrdp-server` moves the handler onto
/// `spawn_blocking` threads, so `RdpInput` MUST be `Send` on every platform —
/// including macOS, where `Enigo` is `!Send`. This static assertion fails to
/// compile if someone reintroduces a non-`Send` field (e.g. holding `Enigo`
/// directly again), catching the macOS-only build break on every platform.
const _: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<RdpInput>();
};

#[test]
fn input_queue_coalesces_only_consecutive_mouse_moves() {
    let queue = InputQueue::new();
    assert!(matches!(
        queue.push(absolute_move(1)),
        InputQueuePush::Enqueued
    ));
    assert!(matches!(
        queue.push(absolute_move(2)),
        InputQueuePush::Coalesced
    ));
    assert!(matches!(
        queue.push(QueuedInput {
            received_at: Instant::now(),
            cmd: InputCmd::Button {
                button: Button::Left,
                dir: Press,
            },
        }),
        InputQueuePush::Enqueued
    ));
    assert!(matches!(
        queue.push(absolute_move(3)),
        InputQueuePush::Enqueued
    ));

    let first = queue.recv().unwrap();
    assert!(matches!(first.cmd, InputCmd::MoveMouse { x: 2, .. }));
    assert!(matches!(queue.recv().unwrap().cmd, InputCmd::Button { .. }));
    assert!(matches!(
        queue.recv().unwrap().cmd,
        InputCmd::MoveMouse { x: 3, .. }
    ));
}

#[test]
fn retina_surface_coordinates_map_to_logical_display_points() {
    assert_eq!(map_surface_coordinate(0, 3840, 0.0, 1920.0), 0.0);
    assert_eq!(map_surface_coordinate(1920, 3840, 0.0, 1920.0), 960.0);
    assert_eq!(map_surface_coordinate(3839, 3840, 0.0, 1920.0), 1919.5);
}

#[test]
fn secondary_display_mapping_preserves_negative_global_origins() {
    assert_eq!(map_surface_coordinate(0, 2560, -1280.0, 1280.0), -1280.0);
    assert_eq!(map_surface_coordinate(1280, 2560, -1280.0, 1280.0), -640.0);
}

#[cfg(target_os = "macos")]
#[test]
fn input_mapping_uses_the_latest_negotiated_surface_size() {
    fn packed(width: u16, height: u16) -> u32 {
        (u32::from(width) << 16) | u32::from(height)
    }

    let surface_size = Arc::new(AtomicU32::new(packed(3840, 2160)));
    let mapping = MacInputMapping::new(
        super::super::capture::mac::DisplayBounds {
            x: -1920,
            y: 120,
            width: 1920,
            height: 1080,
        },
        surface_size.clone(),
    )
    .unwrap();

    let retina_center = mapping.absolute_point(1920, 1080);
    assert_eq!(retina_center.x, -960.0);
    assert_eq!(retina_center.y, 660.0);

    surface_size.store(packed(1920, 1080), Ordering::Relaxed);
    let negotiated_center = mapping.absolute_point(960, 540);
    assert_eq!(negotiated_center.x, retina_center.x);
    assert_eq!(negotiated_center.y, retina_center.y);
}

#[test]
fn main_block_is_scancode_plus_eight() {
    // 'A' is RDP Set-1 0x1E; evdev KEY_A is 30; X11 keycode 38.
    assert_eq!(linux_scancode_to_keycode(0x1E, false), 0x1E + 8);
    // Enter (main) 0x1C -> evdev 28 -> X11 36.
    assert_eq!(linux_scancode_to_keycode(0x1C, false), 28 + 8);
}

#[test]
fn extended_keys_use_explicit_evdev_codes() {
    // Right Ctrl: extended 0x1D -> evdev 97 -> X11 105.
    assert_eq!(linux_scancode_to_keycode(0x1D, true), 97 + 8);
    // Up arrow: extended 0x48 -> evdev 103 -> X11 111.
    assert_eq!(linux_scancode_to_keycode(0x48, true), 103 + 8);
    // KP Enter: extended 0x1C -> evdev 96 (distinct from main Enter).
    assert_eq!(linux_scancode_to_keycode(0x1C, true), 96 + 8);
    assert_ne!(
        linux_scancode_to_keycode(0x1C, true),
        linux_scancode_to_keycode(0x1C, false)
    );
}

#[test]
fn unknown_extended_falls_back_to_base() {
    // An unmapped extended code degrades to scancode+8 rather than panicking.
    assert_eq!(linux_scancode_to_keycode(0x7A, true), 0x7A + 8);
}

#[test]
fn windows_extended_scancode_keeps_prefix_out_of_hardware_code() {
    assert_eq!(windows_scancode_parts(0xE048), (0x48, true));
    assert_eq!(windows_scancode_parts(0x001E), (0x1E, false));
}
