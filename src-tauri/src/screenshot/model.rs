use serde::Serialize;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayInit {
    pub path: String,
    pub display_id: String,
    /// Physical pixels.
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub window_region: Option<PhysicalRegion>,
    pub document: bool,
    pub source_pin: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinInit {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub favorite_id: Option<String>,
    /// User caption shown on the pin (empty = none).
    #[serde(default)]
    pub note: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotProbe {
    /// `granted`, `denied`, or `notRequired` — OS screen-capture permission.
    pub permission: String,
    /// Accessibility / input-injection permission (macOS scroll capture).
    pub control_permission: String,
    /// MP4 uses the bundled H.264 encoder, so it is always available.
    pub mp4_available: bool,
    pub ocr_available: bool,
    /// `windows`, `vision` or `tesseract`; absent when none is usable.
    pub ocr_engine: Option<String>,
    /// How to enable OCR on this platform when no engine is usable.
    pub ocr_hint: Option<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStarted {
    pub recording_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFile {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    pub duration_ms: u64,
}
