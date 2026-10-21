use super::capture::output_dims;
use super::encoding::encode_loop;
use super::frames::FrameQueue;
use super::frames::TimedFrame;
use super::inspection::inspect_clip;
use super::inspection::inspect_clip_frames;
use super::lifetime::Recording;
use super::lifetime::RecordingLease;
use super::lifetime::Session;
use super::lifetime::cancel_all;
use super::lifetime::cancel_recording;
use super::lifetime::nano_id;
use super::lifetime::sessions;
use super::lifetime::stop_recording;
use super::lifetime::take_for_recovery;
use super::model::RecordFormat;
use super::model::RecordingInfo;
use super::mp4::annex_b_nals;
use crate::screenshot::capture::temp_artifact_path;
use image::RgbaImage;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::sync_channel;
use std::thread;

static RECORDING_TEST_LOCK: Mutex<()> = Mutex::new(());

fn frame(w: u32, h: u32, shift: u32) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, y| {
        let v = ((x + shift * 7) / 8 + y / 8) % 2;
        if v == 0 {
            image::Rgba([230, 40, 40, 255])
        } else {
            image::Rgba([30, 60, 220, 255])
        }
    })
}

fn encode(format: RecordFormat, frames: &[(RgbaImage, u64)], end_ms: u64) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "taomni-rec-test-{}.{}",
        nano_id(),
        format.extension()
    ));
    let (tx, rx) = sync_channel(frames.len() + 1);
    for (image, at_ms) in frames {
        tx.send(TimedFrame {
            image: image.clone(),
            at_ms: *at_ms,
        })
        .unwrap();
    }
    tx.send(TimedFrame {
        image: RgbaImage::new(0, 0),
        at_ms: end_ms,
    })
    .unwrap();
    let info = encode_loop(rx, format, 10, &path).unwrap();
    assert_eq!(info.frames as usize, frames.len());
    assert_eq!(info.duration_ms, end_ms);
    path
}

#[test]
fn queue_retries_static_changes_without_losing_original_timestamp() {
    let (tx, rx) = sync_channel(1);
    let mut queue = FrameQueue::default();
    queue.update(frame(16, 16, 0), 0);
    queue.try_flush(&tx).unwrap();
    queue.update(frame(16, 16, 1), 120);
    queue.try_flush(&tx).unwrap(); // Queue full: changed frame must survive.
    queue.update(frame(16, 16, 1), 220); // Same capture must not reset its timestamp.
    assert_eq!(rx.recv().unwrap().at_ms, 0);
    queue.try_flush(&tx).unwrap(); // Source may idle between these retries.
    let changed = rx.recv().unwrap();
    assert_eq!(changed.at_ms, 120);
    assert_eq!(changed.image, frame(16, 16, 1));
    assert!(queue.pending.is_none());
    queue.update(frame(16, 16, 1), 300);
    queue.try_flush(&tx).unwrap();
    assert!(rx.try_recv().is_err());
}

#[test]
fn queue_finishes_with_latest_change_and_discards_obsolete_change() {
    let (tx, rx) = sync_channel(4);
    let mut queue = FrameQueue::default();
    queue.update(frame(16, 16, 0), 0);
    queue.try_flush(&tx).unwrap();
    queue.update(frame(16, 16, 1), 100);
    queue.update(frame(16, 16, 0), 200); // Reverted before it was sent.
    assert!(queue.pending.is_none());
    queue.update(frame(16, 16, 2), 300);
    queue.finish(&tx, 500).unwrap();
    assert_eq!(rx.recv().unwrap().at_ms, 0);
    let last = rx.recv().unwrap();
    assert_eq!(last.image, frame(16, 16, 2));
    assert_eq!(last.at_ms, 300);
    let end = rx.recv().unwrap();
    assert_eq!(end.image.width(), 0);
    assert_eq!(end.at_ms, 500);
}

#[test]
fn capture_failure_is_not_a_successful_partial_recording_and_releases_lease() {
    let _guard = RECORDING_TEST_LOCK.lock().unwrap();
    let lease = RecordingLease::acquire().unwrap();
    assert!(RecordingLease::acquire().is_err());
    let path = std::env::temp_dir().join(format!("taomni-failed-recording-{}.gif", nano_id()));
    std::fs::write(&path, b"partial").unwrap();
    let encoded_path = path.clone();
    let id = format!("qa-failed-{}", nano_id());
    sessions().lock().unwrap().insert(
        id.clone(),
        Arc::new(Recording::from(Session {
            stop: Arc::new(AtomicBool::new(false)),
            capture: Some(thread::spawn(|| {
                anyhow::bail!("capture device disconnected")
            })),
            encoder: Some(thread::spawn(move || {
                Ok(RecordingInfo {
                    path: encoded_path,
                    width: 16,
                    height: 16,
                    frames: 1,
                    duration_ms: 100,
                })
            })),
            output_path: path.clone(),
            _lease: lease,
        })),
    );
    let error = stop_recording(&id).err().unwrap().to_string();
    assert!(error.contains("capture device disconnected"));
    assert!(!path.exists());
    assert!(RecordingLease::acquire().is_ok());
}

#[test]
fn recovery_owns_active_inflight_and_preview_files_through_close_and_exit() {
    let _guard = RECORDING_TEST_LOCK.lock().unwrap();
    for preview in [false, true] {
        let path = temp_artifact_path("recovery-unit", "gif").unwrap();
        std::fs::write(&path, b"completed recording bytes").unwrap();
        let encoded_path = path.clone();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let recording = Arc::new(Recording::from(Session {
            stop: Arc::new(AtomicBool::new(false)),
            capture: Some(thread::spawn(|| Ok(()))),
            encoder: Some(thread::spawn(move || {
                finish_rx.recv().unwrap();
                Ok(RecordingInfo {
                    path: encoded_path,
                    width: 16,
                    height: 16,
                    frames: 2,
                    duration_ms: 100,
                })
            })),
            output_path: path.clone(),
            _lease: RecordingLease::acquire().unwrap(),
        }));
        let id = format!("recovery-unit-{}", nano_id());
        sessions()
            .lock()
            .unwrap()
            .insert(id.clone(), recording.clone());
        let normal = recording.clone();
        let normal_stop = thread::spawn(move || normal.finish());
        if preview {
            finish_tx.send(()).unwrap();
            // The completed preview remains claimable after normal Stop.
            recording.finish().unwrap();
        }
        let recovered = take_for_recovery(&id).unwrap();
        assert!(take_for_recovery(&id).is_none());
        assert!(cancel_recording(&id).is_err());
        cancel_all();
        super::super::capture::purge_tracked();
        assert!(path.exists());
        if !preview {
            finish_tx.send(()).unwrap();
        }
        assert_eq!(recovered.finish().unwrap().frames, 2);
        assert_eq!(normal_stop.join().unwrap().unwrap().frames, 2);
        assert_eq!(std::fs::read(&path).unwrap(), b"completed recording bytes");
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn gif_durations_follow_timestamps() {
    // Irregular capture times (slow encoder / dropped frames).
    let frames = vec![
        (frame(64, 48, 0), 0),
        (frame(64, 48, 1), 130),
        (frame(64, 48, 2), 170),
        (frame(64, 48, 3), 900),
    ];
    let path = encode(RecordFormat::Gif, &frames, 2000);
    let bytes = std::fs::read(&path).unwrap();
    assert!(bytes.starts_with(b"GIF89a"));
    let info = inspect_clip(&path).unwrap();
    assert_eq!((info.width, info.height, info.frames), (64, 48, 4));
    assert!(
        (1990..=2030).contains(&info.duration_ms),
        "{}",
        info.duration_ms
    );
    assert_eq!(info.distinct_frames, 4);
    std::fs::remove_file(path).ok();
}

#[test]
fn changing_gif_or_mp4_frames_do_not_prove_they_recorded_the_original() {
    for format in [RecordFormat::Gif, RecordFormat::Mp4] {
        let original: Vec<_> = (0..12).map(|i| frame(160, 96, i)).collect();
        let unrelated: Vec<_> = original
            .iter()
            .enumerate()
            .map(|(i, image)| {
                let swapped = RgbaImage::from_fn(160, 96, |x, y| {
                    let p = image.get_pixel(x, y);
                    image::Rgba([p[2], p[1], p[0], 255])
                });
                (swapped, i as u64 * 100)
            })
            .collect();
        let path = encode(format, &unrelated, 1500);
        let mut matched = 0;
        let mut decoded = 0usize;
        let clip = inspect_clip_frames(&path, &mut |image, _| {
            if super::super::qa_oracle::compare(image, &original[decoded], true).passed {
                matched += 1;
            }
            decoded += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(clip.frames, 12);
        assert!(clip.distinct_frames >= 4);
        assert_eq!(
            matched, 0,
            "changing {:?} pixels must still match the source",
            format
        );
        std::fs::remove_file(path).ok();
    }
}

#[test]
fn mp4_roundtrip_decodes_with_real_duration() {
    let frames: Vec<_> = (0..12)
        .map(|i| (frame(160, 96, i), i as u64 * 100))
        .collect();
    let path = encode(RecordFormat::Mp4, &frames, 1500);
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(&bytes[4..8], b"ftyp");
    let info = inspect_clip(&path).unwrap();
    assert_eq!((info.width, info.height, info.frames), (160, 96, 12));
    assert!(
        (1450..=1550).contains(&info.duration_ms),
        "{}",
        info.duration_ms
    );
    assert!(info.distinct_frames >= 6, "{}", info.distinct_frames);
    std::fs::remove_file(path).ok();
}

#[test]
fn annex_b_splitting_handles_3_and_4_byte_start_codes() {
    let data = [
        0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 9,
    ];
    let nals = annex_b_nals(&data);
    assert_eq!(
        nals,
        vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 9][..]]
    );
}

#[test]
fn output_dims_are_even_and_capped() {
    assert_eq!(output_dims(1921, 1081, 1920), (1920, 1080));
    assert_eq!(output_dims(3840, 2160, 960), (960, 540));
    assert_eq!(output_dims(301, 201, 960), (300, 200));
}

#[test]
fn record_format_parsing() {
    assert_eq!(RecordFormat::parse("gif").unwrap(), RecordFormat::Gif);
    assert_eq!(RecordFormat::parse("MP4").unwrap(), RecordFormat::Mp4);
    assert!(RecordFormat::parse("avi").is_err());
}
