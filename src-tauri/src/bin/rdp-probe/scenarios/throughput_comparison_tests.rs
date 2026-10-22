use super::throughput::throughput_comparison;
use serde_json::json;

#[test]
fn comparison_reports_both_bandwidth_and_delivery_rate() {
    let compared = throughput_comparison(
        &json!({"kbps": 95.0, "fps": 100.0, "marker": {"observed_fps": 28.0}}),
        &json!({"kbps": 100.0, "fps": 50.0, "marker": {"observed_fps": 32.0}}),
    )
    .unwrap();
    assert_eq!(
        compared,
        json!({
            "kbps_ratio": 0.95,
            "kbps_per_frame_ratio": 0.95 / 0.875,
            "fps_ratio": 0.875,
        })
    );
    assert!(
        throughput_comparison(
            &json!({"kbps": 1, "marker": {"observed_fps": 1}}),
            &json!({"kbps": 0, "marker": {"observed_fps": 1}}),
        )
        .is_err()
    );
    assert!(
        throughput_comparison(
            &json!({"kbps": 1, "marker": {"observed_fps": 0}}),
            &json!({"kbps": 1, "marker": {"observed_fps": 1}}),
        )
        .is_err()
    );
    assert!(
        throughput_comparison(&json!({"kbps": 1, "fps": 1}), &json!({"kbps": 1, "fps": 1}))
            .is_err()
    );
}
