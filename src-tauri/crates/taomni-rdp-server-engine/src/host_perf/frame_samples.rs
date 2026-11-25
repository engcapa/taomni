use serde::Serialize;
use std::{
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use taomni_capture::engine::Frame;

pub(crate) struct FrameSamples {
    x: u16,
    y: u16,
    samples: Mutex<Vec<Sample>>,
}

#[derive(Serialize)]
struct Sample {
    sequence: u64,
    light: bool,
    capture_unix_us: u128,
    handed_off_unix_us: u128,
}

impl FrameSamples {
    pub(super) fn from_env() -> anyhow::Result<Option<Self>> {
        let Some(point) = std::env::var_os("QA_RDP_FRAME_SAMPLE_POINT") else {
            return Ok(None);
        };
        let point = point
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid frame sample point"))?;
        let (x, y) = point
            .split_once(',')
            .ok_or_else(|| anyhow::anyhow!("Expected x,y for the frame sample point"))?;
        Ok(Some(Self {
            x: x.parse()?,
            y: y.parse()?,
            samples: Mutex::new(Vec::new()),
        }))
    }

    pub(crate) fn handoff(&self, frame: &Frame) {
        let Some(light) = marker(frame, self.x, self.y) else {
            return;
        };
        let mut samples = self.samples.lock().expect("frame samples poisoned");
        if samples.len() == 256 || samples.last().is_some_and(|sample| sample.light == light) {
            return;
        }
        let handoff = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before Unix epoch");
        samples.push(Sample {
            sequence: frame.sequence,
            light,
            capture_unix_us: handoff
                .saturating_sub(frame.captured_at.elapsed())
                .as_micros(),
            handed_off_unix_us: handoff.as_micros(),
        });
    }

    pub(super) fn save(&self, report: &Path) -> anyhow::Result<()> {
        let observations = self.samples.lock().expect("frame samples poisoned");
        super::publish(report, "frame-samples.json", &*observations)
    }
}

fn marker(frame: &Frame, x: u16, y: u16) -> Option<bool> {
    let column = x.checked_sub(frame.x)?;
    let row = y.checked_sub(frame.y)?;
    if column >= frame.width || row >= frame.height {
        return None;
    }
    let offset = usize::from(row)
        .checked_mul(frame.stride)?
        .checked_add(usize::from(column) * 4)?;
    let pixel = frame.data.get(offset..offset.checked_add(3)?)?;
    let brightness = u16::from(pixel[0]) + u16::from(pixel[1]) + u16::from(pixel[2]);
    Some(brightness >= 384)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_samples_use_desktop_coordinates_and_record_only_marker_changes() {
        let trace = FrameSamples {
            x: 11,
            y: 20,
            samples: Mutex::new(Vec::new()),
        };
        trace.handoff(&Frame::bgra(vec![0; 8], 12, 20, 2, 1, 8));
        for light in [false, false, true] {
            let mut frame = Frame::bgra(vec![0; 8], 10, 20, 2, 1, 8);
            if light {
                frame.data = bytes::Bytes::from_static(&[0, 0, 0, 0, 255, 255, 255, 255]);
            }
            trace.handoff(&frame);
        }
        let samples = trace.samples.lock().unwrap();
        assert_eq!(samples.len(), 2);
        assert!(!samples[0].light && samples[1].light);
        assert!(
            samples
                .iter()
                .all(|sample| sample.capture_unix_us <= sample.handed_off_unix_us)
        );
    }
}
