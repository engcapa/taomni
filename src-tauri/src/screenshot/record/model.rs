use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordFormat {
    Gif,
    Mp4,
}

impl RecordFormat {
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "gif" => Ok(Self::Gif),
            "mp4" => Ok(Self::Mp4),
            other => anyhow::bail!("unsupported recording format '{other}' (gif or mp4)"),
        }
    }

    pub(super) fn extension(self) -> &'static str {
        match self {
            Self::Gif => "gif",
            Self::Mp4 => "mp4",
        }
    }

    /// Hard stop so a forgotten recording cannot fill the disk.
    pub(super) fn max_duration(self) -> Duration {
        match self {
            Self::Gif => Duration::from_secs(60),
            Self::Mp4 => Duration::from_secs(300),
        }
    }

    pub(super) fn default_fps(self) -> u32 {
        match self {
            Self::Gif => 10,
            Self::Mp4 => 15,
        }
    }

    /// Output width cap (GIFs balloon quickly; H.264 level limits).
    pub(super) fn max_width(self) -> u32 {
        match self {
            Self::Gif => 960,
            Self::Mp4 => 1920,
        }
    }
}

#[derive(Clone)]
pub struct RecordingInfo {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    pub duration_ms: u64,
}
