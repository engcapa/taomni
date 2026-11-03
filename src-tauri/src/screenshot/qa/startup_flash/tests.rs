use super::*;

fn sample(index: usize, at: f64, share: f64) -> Sample {
    Sample {
        index,
        capture_started_ms: at,
        capture_ended_ms: at + 2.0,
        capture_started_mono_ms: at + 10_000.0,
        capture_ended_mono_ms: at + 10_002.0,
        modal_share: share,
        modal_color: [90, 80, 70],
        width: 1920,
        height: 1080,
        transport: "fresh test pixels".to_string(),
    }
}

fn samples() -> Vec<Sample> {
    (0..24)
        .map(|index| sample(index, 50.0 * index as f64, 0.4))
        .collect()
}

#[test]
fn fresh_varied_frames_with_bounded_gaps_pass() {
    let evidence = sampling_evidence(&samples(), 100.0, 200.0, 1150.0);
    assert_eq!(evidence["passed"], true);
    assert_eq!(evidence["samplingCoverage"], true);
    assert_eq!(evidence["maxGapMs"], 52.0);
    assert_eq!(evidence["samplesBeforeOpen"], 2);
    assert_eq!(evidence["flashFrames"], json!([]));
}

#[test]
fn flash_whose_capture_straddles_show_is_not_discarded() {
    let mut frames = samples();
    frames[4] = sample(4, 199.0, 1.0);
    let evidence = sampling_evidence(&frames, 100.0, 200.0, 1150.0);
    assert_eq!(evidence["passed"], false);
    assert_eq!(evidence["flashFrames"][0]["index"], 4);
}

#[test]
fn sparse_samples_or_long_native_capture_fail_even_without_flash() {
    let mut frames = samples();
    frames.drain(8..12);
    let sparse = sampling_evidence(&frames, 100.0, 200.0, 1150.0);
    assert_eq!(sparse["passed"], false);
    assert_eq!(sparse["samplingCoverage"], false);
    assert_eq!(sparse["flashFrames"], json!([]));
    let mut frames = samples();
    frames[8].capture_ended_ms += 130.0;
    frames[8].capture_ended_mono_ms += 130.0;
    let slow = sampling_evidence(&frames, 100.0, 200.0, 1150.0);
    assert_eq!(slow["passed"], false);
    assert!(slow["maxGapMs"].as_f64().unwrap() > MAX_GAP_MS);
}

#[test]
fn sampling_must_cover_both_edges_not_just_five_frames() {
    let frames = samples();
    let late = sampling_evidence(&frames[8..], 450.0, 200.0, 1150.0);
    assert_eq!(late["passed"], false);
    let truncated = sampling_evidence(&frames[..15], 100.0, 200.0, 1150.0);
    assert_eq!(truncated["passed"], false);
    assert!(truncated["samplesAfterShow"].as_u64().unwrap() >= 5);
}

#[test]
fn clock_jump_or_stale_repeated_capture_timestamps_cannot_pass() {
    let mut frames = samples();
    frames[8].capture_started_ms += 20.0;
    frames[8].capture_ended_ms += 20.0;
    let jump = sampling_evidence(&frames, 100.0, 200.0, 1150.0);
    assert_eq!(jump["clockStable"], false);
    assert_eq!(jump["passed"], false);
    let mut frames = samples();
    frames[8] = frames[7].clone();
    let stale = sampling_evidence(&frames, 100.0, 200.0, 1150.0);
    assert_eq!(stale["monotonic"], false);
    assert_eq!(stale["passed"], false);
}

#[test]
fn missing_control_and_invalid_pixel_evidence_are_failures() {
    let mut frames = samples();
    frames[0].modal_share = 1.0;
    let evidence = sampling_evidence(&frames, 100.0, 200.0, 1150.0);
    assert_eq!(evidence["desktopVaried"], false);
    assert_eq!(evidence["passed"], false);
    let mut frame = sample(0, 1.0, 0.4);
    assert!(frame.valid());
    frame.capture_ended_mono_ms = f64::NAN;
    assert!(!frame.valid());
}
