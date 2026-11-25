use super::damage::DamageRect;
use super::damage::geometry_changed;
use super::lifetime::X11Capturer;
use super::limits::DAMAGE_WAIT_BUDGET;
use super::shared_memory::Backend;
use crate::engine::Capturer as _;
use std::time::Instant;
use x11rb::connection::Connection as _;
use x11rb::connection::RequestConnection as _;
use x11rb::protocol::damage;
use x11rb::protocol::shm;
use x11rb::protocol::shm::ConnectionExt as _;
use x11rb::protocol::xproto;
use x11rb::protocol::xproto::ImageFormat;

/// Opt-in hosted X11 check. A missing fixture is a failure, never a pass.
#[test]
#[ignore = "requires a hosted X11 display with MIT-SHM"]
fn x11_capture_produces_a_frame_when_display_present() {
    let (conn, screen_num) = x11rb::connect(None).expect("hosted X11 fixture");
    assert!(
        conn.extension_information(shm::X11_EXTENSION_NAME)
            .unwrap()
            .is_some(),
        "MIT-SHM fixture capability"
    );
    let screen = &conn.setup().roots[screen_num];
    let (w, h) = (screen.width_in_pixels, screen.height_in_pixels);
    assert!(w > 0 && h > 0, "screen size should be positive");

    let shm = X11Capturer::alloc_shm(&conn, w, h).expect("alloc shm");
    let _reply = shm::get_image(
        &conn,
        screen.root,
        0,
        0,
        w,
        h,
        !0,
        ImageFormat::Z_PIXMAP.into(),
        shm.seg,
        0,
    )
    .expect("shm_get_image request")
    .reply()
    .expect("shm_get_image reply");

    let data = shm.as_slice();
    assert_eq!(
        data.len(),
        usize::from(w) * usize::from(h) * 4,
        "BGRA buffer length matches geometry"
    );
    let _ = conn.shm_detach(shm.seg);
}

/// The plain GetImage fallback must also capture a TrueColor display.
#[test]
#[ignore = "requires a hosted X11 display"]
fn plain_get_image_fallback_produces_a_frame() {
    let (conn, screen_num) = x11rb::connect(None).expect("hosted X11 fixture");
    let screen = &conn.setup().roots[screen_num];
    let mut cap = X11Capturer {
        root: screen.root,
        width: screen.width_in_pixels,
        height: screen.height_in_pixels,
        depth: screen.root_depth,
        backend: Backend::Plain,
        damage: None,
        randr: false,
        conn,
    };
    let frame = cap.capture().expect("plain GetImage capture");
    assert_eq!(frame.width, cap.width);
    assert_eq!(frame.height, cap.height);
    assert_eq!(
        frame.data.len(),
        usize::from(frame.width) * usize::from(frame.height) * 4,
        "BGRA frame length matches geometry"
    );
    assert_eq!(frame.stride, usize::from(frame.width) * 4);
}

/// Exercise the actual constructor with an injectable logger; no AppHandle
/// or duplicated construction path is needed in the capture library.
#[test]
#[ignore = "requires a hosted X11 display with XDamage"]
fn damage_first_update_is_full_then_idle_is_bounded() {
    let mut cap = X11Capturer::new(&crate::CaptureLogger::silent()).expect("hosted X11 capturer");
    assert!(cap.is_event_driven(), "hosted XDamage fixture capability");
    let (w, h) = cap.desktop_size();

    // First update: exactly one full-screen frame at origin (0,0).
    let first = cap.next_updates(true).expect("first next_updates");
    assert_eq!(first.len(), 1, "first update should be a single full frame");
    let f = &first[0];
    assert_eq!((f.x, f.y, f.width, f.height), (0, 0, w, h));
    assert_eq!(f.data.len(), usize::from(w) * usize::from(h) * 4);
    assert_eq!(f.stride, usize::from(w) * 4);

    // A subsequent update returns within ~2x the wait budget. On an idle
    // desktop it's empty; if the desktop happens to change (clock, cursor
    // caret) it's a region that fits within the screen and is tightly
    // packed. Either way it must NOT block indefinitely or exceed bounds.
    let start = Instant::now();
    let next = cap.next_updates(false).expect("second next_updates");
    assert!(
        start.elapsed() < DAMAGE_WAIT_BUDGET * 3,
        "next_updates should return within the wait budget"
    );
    for f in &next {
        assert!(
            f.x + f.width <= w && f.y + f.height <= h,
            "region in bounds"
        );
        assert_eq!(f.stride, usize::from(f.width) * 4, "tightly packed");
        assert_eq!(
            f.data.len(),
            usize::from(f.width) * usize::from(f.height) * 4
        );
    }
}

#[test]
fn damage_rect_clamps_into_screen() {
    // A rect partly off the right/bottom edge is clipped to the screen.
    let r = xproto::Rectangle {
        x: 1900,
        y: 1060,
        width: 200,
        height: 200,
    };
    let d = DamageRect::from_x_rect(r, 1920, 1080).expect("in-bounds after clamp");
    assert_eq!((d.x, d.y, d.w, d.h), (1900, 1060, 20, 20));
}

#[test]
fn damage_rect_negative_origin_clamped() {
    // Negative origins (i16) clamp to 0 and the extent shrinks accordingly.
    let r = xproto::Rectangle {
        x: -10,
        y: -5,
        width: 50,
        height: 50,
    };
    let d = DamageRect::from_x_rect(r, 1920, 1080).expect("in-bounds");
    assert_eq!((d.x, d.y, d.w, d.h), (0, 0, 40, 45));
}

#[test]
fn damage_rect_fully_offscreen_is_none() {
    let r = xproto::Rectangle {
        x: 2000,
        y: 0,
        width: 10,
        height: 10,
    };
    assert!(DamageRect::from_x_rect(r, 1920, 1080).is_none());
}

#[test]
fn damage_rect_union_is_bounding_box() {
    let a = DamageRect {
        x: 10,
        y: 10,
        w: 20,
        h: 20,
    };
    let b = DamageRect {
        x: 100,
        y: 5,
        w: 10,
        h: 10,
    };
    // Union spans x:[10,110), y:[5,30) → (10,5,100,25).
    assert_eq!(
        a.union(b),
        DamageRect {
            x: 10,
            y: 5,
            w: 100,
            h: 25
        }
    );
    // Union is commutative.
    assert_eq!(a.union(b), b.union(a));
}

#[test]
fn geometry_change_detection_is_dimension_only() {
    assert!(!geometry_changed((1920, 1080), (1920, 1080)));
    assert!(geometry_changed((1920, 1080), (2560, 1440)));
    assert!(geometry_changed((2560, 1440), (1920, 1080)));
}
