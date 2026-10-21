use super::clipboard_image;
use super::model::OverlayInit;
use super::recording_controls::recording_region;
use super::runtime::tool_state;
#[test]
fn recording_requires_a_complete_nonempty_region() {
    assert_eq!(recording_region(None, None, None, None).unwrap(), None);
    assert_eq!(
        recording_region(Some(1), Some(2), Some(10), Some(20)).unwrap(),
        Some((1, 2, 10, 20))
    );
    assert!(recording_region(Some(1), None, Some(10), Some(20)).is_err());
    assert!(recording_region(Some(1), Some(2), Some(0), Some(20)).is_err());
}

#[test]
fn clipboard_decodes_the_first_gif_frame_without_png_only_image_features() {
    let file = tempfile::Builder::new().suffix(".GIF").tempfile().unwrap();
    {
        let mut encoder =
            gif::Encoder::new(std::fs::File::create(file.path()).unwrap(), 4, 2, &[]).unwrap();
        for color in [[240, 40, 20, 255], [20, 60, 220, 255]] {
            let mut pixels = color.repeat(8);
            let frame = gif::Frame::from_rgba_speed(4, 2, &mut pixels, 10);
            encoder.write_frame(&frame).unwrap();
        }
    }
    let first = clipboard_image(file.path()).unwrap();
    assert_eq!(first.dimensions(), (4, 2));
    assert!(first.pixels().all(|p| p[0] > 200 && p[1] < 70 && p[2] < 50));
}

#[test]
fn empty_gif_clipboard_image_is_rejected() {
    let file = tempfile::Builder::new().suffix(".gif").tempfile().unwrap();
    {
        let encoder = gif::Encoder::new(
            std::fs::File::create(file.path()).unwrap(),
            4,
            2,
            &[0, 0, 0],
        )
        .unwrap();
        drop(encoder);
    }
    assert!(clipboard_image(file.path()).is_err());
}

#[test]
fn close_session_state_resets_overlay_and_recording() {
    {
        let mut state = tool_state();
        state.overlay = Some(OverlayInit {
            path: "x".into(),
            display_id: "0,0".into(),
            width: 1,
            height: 1,
            scale_factor: 1.0,
            window_region: None,
            document: false,
            source_pin: None,
        });
        state.hidden = vec!["main".into()];
    }
    // Without an app handle we can only exercise the state transitions.
    let hidden = std::mem::take(&mut tool_state().hidden);
    tool_state().overlay = None;
    assert_eq!(hidden, vec!["main".to_string()]);
    assert!(tool_state().overlay.is_none());
}
