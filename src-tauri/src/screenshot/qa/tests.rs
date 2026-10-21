use super::*;

#[test]
fn native_x11_geometry_uses_absolute_coordinates_and_requires_complete_mapping() {
    let output = "  Absolute upper-left X: -400\n  Absolute upper-left Y: 562\n  Relative upper-left X: 0\n  Relative upper-left Y: 0\n  Width: 360\n  Height: 200\n  Map State: IsViewable\n";
    let (rect, visible) = x11_control_geometry(output).unwrap();
    assert_eq!((rect.x, rect.y, rect.w, rect.h), (-400, 562, 360, 200));
    assert!(visible);
    assert!(
        !x11_control_geometry(&output.replace("IsViewable", "IsUnMapped"))
            .unwrap()
            .1
    );
    for incomplete in [
        output.replace("Absolute upper-left X:", "Unknown X:"),
        output.replace("Width: 360", "Width: 0"),
        output.replace("Map State: IsViewable", "Map State: unknown"),
    ] {
        assert!(x11_control_geometry(&incomplete).is_none());
    }
}

fn row_color(i: u32) -> [u8; 4] {
    [30 + (i % 8) as u8 * 28, 30 + (i / 8) as u8 * 28, 210, 255]
}

fn evidence(kind: &str, css_width: f64, css_height: f64, scale: f64) -> SourceEvidence {
    SourceEvidence {
        kind: kind.into(),
        css_width,
        css_height,
        width: (css_width * scale).round() as u32,
        height: (css_height * scale).round() as u32,
        scale,
        nonce: 1,
        frames: Vec::new(),
        frame_interval_ms: None,
        data_url: None,
    }
}

#[test]
fn native_x11_topmost_requires_the_actual_above_atom_and_a_successful_probe() {
    let above = "_NET_WM_STATE(ATOM) = _NET_WM_STATE_SKIP_TASKBAR, _NET_WM_STATE_SKIP_PAGER, _NET_WM_STATE_ABOVE\n";
    assert!(x11_pin_is_above(&json!({"success":true,"stdout":above})));
    assert!(!x11_pin_is_above(&json!({"success":false,"stdout":above})));
    for output in [
        "_NET_WM_STATE(ATOM) = _NET_WM_STATE_SKIP_TASKBAR\n",
        "_NET_WM_STATE: not found.\n",
        "_NET_WM_STATE(ATOM) = _NET_WM_STATE_ABOVE_FAKE\n",
        "unrelated _NET_WM_STATE_ABOVE\n",
    ] {
        assert!(!x11_pin_is_above(&json!({"success":true,"stdout":output})));
    }
    assert!(!x11_pin_is_above(&json!({"error":"xprop unavailable"})));
}

#[test]
fn evidence_names_cannot_collide_after_app_restarts_between_cases() {
    let first = evidence_path("recording.gif");
    let second = evidence_path("recording.gif");
    assert_ne!(first, second);
    let name = first.file_name().unwrap().to_str().unwrap();
    assert!(name.starts_with(platform()));
    let process = &name[platform().len() + 1..platform().len() + 37];
    assert!(uuid::Uuid::parse_str(process).is_ok());
    assert!(name.ends_with("-recording.gif"));
}

#[test]
fn full_page_expected_width_cannot_follow_a_truncated_output() {
    let source = evidence("scroll", 520.0, 1536.0, 1.0);
    let original = RgbaImage::from_pixel(520, 1536, image::Rgba([80, 110, 210, 255]));
    let expected = source_crop(&source, &original).unwrap();
    assert_eq!(expected.dimensions(), (508, 1524));
    let truncated = capture::crop(&expected, 0, 0, 400, expected.height());
    assert!(!qa_oracle::compare(&truncated, &expected, false).passed);
    assert!(source_crop(&source, &truncated).is_err());
}

#[test]
fn recording_expected_dimensions_are_derived_from_original_scale_and_format() {
    let source = evidence("anim", 1012.0, 512.0, 1.0);
    assert_eq!(record_expected_size(&source, false).unwrap(), (960, 480));
    assert_eq!(record_expected_size(&source, true).unwrap(), (1000, 500));
    let source = evidence("anim", 1012.0, 512.0, 2.0);
    assert_eq!(record_expected_size(&source, false).unwrap(), (960, 480));
    assert_eq!(record_expected_size(&source, true).unwrap(), (1920, 960));
    let mut invalid = source;
    invalid.width = 400;
    assert!(record_expected_size(&invalid, true).is_err());
}

#[test]
fn rows_decode_with_color_tolerance() {
    for i in 0..64 {
        let mut c = row_color(i);
        assert_eq!(decode_row(c), Some(i));
        c[0] = c[0].saturating_add(6);
        c[1] = c[1].saturating_sub(5);
        assert_eq!(decode_row(c), Some(i));
    }
    assert_eq!(decode_row([255, 255, 255, 255]), None);
    assert_eq!(decode_row([44, 44, 210, 255]), None);
}

#[test]
fn row_runs_detect_order_and_heights() {
    let mut rows = Vec::new();
    for i in 3..9u32 {
        for _ in 0..44 {
            rows.push(row_color(i));
        }
        for _ in 0..4 {
            rows.push([255, 255, 255, 255]);
        }
    }
    let image = RgbaImage::from_fn(10, rows.len() as u32, |_, y| image::Rgba(rows[y as usize]));
    let runs = row_runs(&image, 5);
    assert_eq!(
        runs.iter().map(|r| r.0).collect::<Vec<_>>(),
        vec![3, 4, 5, 6, 7, 8]
    );
    assert!(runs.iter().all(|r| r.1 == 44));
}

#[test]
fn x11_active_window_and_bypass_property_parsing_require_exact_values() {
    assert_eq!(
        x11_parse_window_id("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3e00007"),
        Some(0x3e0_0007)
    );
    assert_eq!(x11_parse_window_id("_NET_ACTIVE_WINDOW:  not found."), None);
    assert_eq!(x11_parse_window_id(""), None);
    assert_eq!(
        x11_cardinal(
            "_NET_WM_BYPASS_COMPOSITOR(CARDINAL) = 2",
            "_NET_WM_BYPASS_COMPOSITOR"
        ),
        Some(2)
    );
    assert_eq!(
        x11_cardinal(
            "_NET_WM_BYPASS_COMPOSITOR(CARDINAL) = 1",
            "_NET_WM_BYPASS_COMPOSITOR"
        ),
        Some(1)
    );
    assert_eq!(
        x11_cardinal(
            "_NET_WM_BYPASS_COMPOSITOR:  not found.",
            "_NET_WM_BYPASS_COMPOSITOR"
        ),
        None
    );
    // A lookalike atom must not satisfy the real property, and a real atom
    // line with a non-numeric value is not a cardinal either.
    assert_eq!(
        x11_cardinal(
            "_NET_WM_BYPASS_COMPOSITOR_FAKE(CARDINAL) = 2",
            "_NET_WM_BYPASS_COMPOSITOR"
        ),
        None
    );
    assert_eq!(
        x11_cardinal(
            "_NET_WM_BYPASS_COMPOSITOR(CARDINAL) = 2",
            "_NET_WM_BYPASS_COMPOSITOR_FAKE"
        ),
        None
    );
    assert_eq!(
        x11_cardinal(
            "_NET_WM_BYPASS_COMPOSITOR(CARDINAL) = not-a-number",
            "_NET_WM_BYPASS_COMPOSITOR"
        ),
        None
    );
    assert_eq!(
        x11_cardinal(
            "_NET_WM_STATE(ATOM) = _NET_WM_STATE_ABOVE",
            "_NET_WM_BYPASS_COMPOSITOR"
        ),
        None
    );
}

#[test]
fn focus_requires_the_wm_active_window_on_x11() {
    let focused_only = json!({"windowFocused": true, "x11": {"isActiveWindow": false}});
    let wm_only = json!({"windowFocused": false, "x11": {"isActiveWindow": true}});
    let both = json!({"windowFocused": true, "x11": {"isActiveWindow": true}});
    let other_platform = json!({"windowFocused": true});
    assert!(!focus_is_established(&focused_only));
    assert!(!focus_is_established(&wm_only));
    assert!(focus_is_established(&both));
    assert!(focus_is_established(&other_platform));
    assert!(!focus_is_established(
        &json!({"windowFocused": false, "x11": null})
    ));
}

#[test]
fn display_state_signature_covers_screen_size_and_each_display_scale() {
    let sample = json!({
        "screenSize": [5216, 2660],
        "displays": [{"id": "0,0", "scaleFactor": 1.0, "width": 3296}],
        "randr": "changed between samples",
    });
    let same = json!({
        "screenSize": [5216, 2660],
        "displays": [{"id": "0,0", "scaleFactor": 1.0, "width": 3296}],
        "randr": "unrelated text",
    });
    let rescaled = json!({
        "screenSize": [5216, 2660],
        "displays": [{"id": "0,0", "scaleFactor": 2.0, "width": 3296}],
        "randr": "changed between samples",
    });
    let resized = json!({
        "screenSize": [7677, 4198],
        "displays": [{"id": "0,0", "scaleFactor": 1.0, "width": 3296}],
        "randr": "changed between samples",
    });
    assert_eq!(
        display_state_signature(&sample),
        display_state_signature(&same)
    );
    assert_ne!(
        display_state_signature(&sample),
        display_state_signature(&rescaled)
    );
    assert_ne!(
        display_state_signature(&sample),
        display_state_signature(&resized)
    );
}

#[test]
fn fractional_scaling_is_derived_from_real_scales_only() {
    let config_fractional = json!({"scales": ["1", "1.75"]});
    let config_integer = json!({"scales": ["1", "2"]});
    let sample_fractional = json!({"displays": [{"scaleFactor": 1.5}]});
    let sample_integer = json!({"displays": [{"scaleFactor": 2.0}]});
    assert!(has_fractional_scale(&config_fractional, &[]));
    assert!(has_fractional_scale(
        &config_integer,
        &[sample_fractional.clone()]
    ));
    assert!(!has_fractional_scale(
        &config_integer,
        &[sample_integer.clone()]
    ));
    assert!(!has_fractional_scale(&json!({}), &[]));
    // Unparseable scales, missing display lists and non-numeric values are
    // never fractional evidence.
    assert!(!has_fractional_scale(
        &json!({"scales": ["n/a", ""]}),
        &[json!({}), json!({"displays": "not-a-list"})]
    ));
    assert!(!has_fractional_scale(
        &config_integer,
        &[json!({"displays": [{"scaleFactor": "1.75"}]})]
    ));
}

#[test]
fn capture_window_labels_cover_every_screenshot_owned_surface() {
    assert!(capture_window_label("screenshot-overlay"));
    assert!(capture_window_label("screenshot-recorder"));
    assert!(capture_window_label("screenshot-scroll"));
    assert!(capture_window_label("screenshot-boundary-0"));
    assert!(capture_window_label("screenshot-pin-1"));
    assert!(!capture_window_label("main"));
    assert!(!capture_window_label("screenshot-qa-fixture"));
}
