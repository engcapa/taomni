//! The module accepts a single-use image stream and never receives its path.

use serde::{Deserialize, Serialize};
use taomni_plugin_stream::routed_tcp::Endpoint;

mod recording;
pub use recording::{FrameHeader, MAX_CLIP_BYTES, RecordStart};

pub const SLUG: &str = "screenshot";
pub const PROBE_OCR: &str = "screenshot/probe-ocr";
pub const RECOGNIZE: &str = "screenshot/recognize";
pub const REDACT: &str = "screenshot/redact";
pub const CLASSIFY_TSV: &str = "screenshot/classify-tsv";
pub const START_RECORDING: &str = "screenshot/start-recording";
pub const COMMANDS: [&str; 5] = [PROBE_OCR, RECOGNIZE, REDACT, CLASSIFY_TSV, START_RECORDING];
pub const MAX_IMAGE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrInput {
    pub source: Endpoint,
    pub length: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrAvailability {
    pub engine: Option<String>,
    pub hint: Option<String>,
}

/// A single OCR'd word with its bounding box in physical pixels.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrWord {
    pub text: String,
    /// Words sharing this key are on one text line.
    #[serde(skip)]
    pub line_key: String,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub conf: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub text: String,
    pub words: Vec<OcrWord>,
    pub langs: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactBox {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactResult {
    pub boxes: Vec<RedactBox>,
    pub count: usize,
}
