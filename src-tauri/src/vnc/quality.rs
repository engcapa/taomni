//! Picture quality presets (VNC-PERF-004, DEC-VNC-11/15), modelled on
//! RealVNC Viewer's Automatic / High / Medium / Low.
//!
//! RealVNC lowers the colour depth. Taomni prefers Tight with JPEG when the
//! server offers it (far fewer bytes at the same tier) and falls back to the
//! RealVNC colour levels otherwise. Automatic starts at High and follows the
//! Session Information line-speed estimate.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::vnc::clipboard::{ENCODING_EXTENDED_CLIPBOARD, ENCODING_EXTENDED_CLIPBOARD_LEGACY};
use crate::vnc::encodings::{
    ENCODING_DESKTOP_SIZE, ENCODING_POINTER_POS, ENCODING_RICH_CURSOR, ENCODING_X_CURSOR,
};
use crate::vnc::pixel::PixelFormat;
use crate::vnc::rfb::encoding_name;
use crate::vnc::tight::{ENCODING_COMPRESS_LEVEL_0, ENCODING_JPEG_QUALITY_0, ENCODING_TIGHT};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VncPictureQuality {
    #[default]
    Automatic,
    High,
    Medium,
    Low,
}

impl VncPictureQuality {
    pub fn from_wire(value: u8) -> Option<Self> {
        Some(match value {
            0 => Self::Automatic,
            1 => Self::High,
            2 => Self::Medium,
            3 => Self::Low,
            _ => return None,
        })
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
        }
    }

    fn fixed_level(self) -> Option<QualityLevel> {
        match self {
            Self::Automatic => None,
            Self::High => Some(QualityLevel::High),
            Self::Medium => Some(QualityLevel::Medium),
            Self::Low => Some(QualityLevel::Low),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QualityLevel {
    High,
    Medium,
    Low,
}

impl QualityLevel {
    pub fn label(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
        }
    }
}

/// What the client asks the server for: SetEncodings list and pixel format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodingProfile {
    pub encodings: Vec<i32>,
    pub pixel_format: PixelFormat,
    /// Tight is listed first, so the next pixel update tells whether the
    /// server supports it.
    pub tight_first: bool,
}

impl EncodingProfile {
    /// Name of the preferred pixel encoding, for Session Information.
    pub fn requested_label(&self) -> &'static str {
        self.encodings
            .iter()
            .copied()
            .find(|encoding| *encoding >= 0)
            .map(encoding_name)
            .unwrap_or("-")
    }
}

const PSEUDO_ENCODINGS: [i32; 6] = [
    ENCODING_DESKTOP_SIZE,
    ENCODING_POINTER_POS,
    ENCODING_X_CURSOR,
    ENCODING_RICH_CURSOR,
    ENCODING_EXTENDED_CLIPBOARD,
    ENCODING_EXTENDED_CLIPBOARD_LEGACY,
];

/// Tight JPEG quality / zlib level per tier.
const TIGHT_MEDIUM: (i32, i32) = (6, 6);
const TIGHT_LOW: (i32, i32) = (2, 9);
/// Colour levels used when the server has no Tight (RealVNC's approach).
pub const MEDIUM_COLOUR: PixelFormat = PixelFormat::RGB222;
pub const LOW_COLOUR: PixelFormat = PixelFormat::RGB111;

/// Encoding profile for a tier. `tight` is `Some(false)` once the server has
/// shown it does not implement Tight.
pub fn profile_for(level: QualityLevel, tight: Option<bool>) -> EncodingProfile {
    let with_pseudo = |mut encodings: Vec<i32>| {
        encodings.extend_from_slice(&PSEUDO_ENCODINGS);
        encodings
    };
    match (level, tight) {
        (QualityLevel::High, _) => EncodingProfile {
            // ZRLE (bandwidth) > Hextile > Tight (lossless) > CopyRect > Raw.
            encodings: with_pseudo(vec![16, 5, ENCODING_TIGHT, 1, 0]),
            pixel_format: PixelFormat::RGB888,
            tight_first: false,
        },
        (level, Some(false)) => EncodingProfile {
            encodings: with_pseudo(vec![16, 5, 1, 0]),
            pixel_format: if level == QualityLevel::Medium {
                MEDIUM_COLOUR
            } else {
                LOW_COLOUR
            },
            tight_first: false,
        },
        (level, _) => {
            let (quality, compress) = if level == QualityLevel::Medium {
                TIGHT_MEDIUM
            } else {
                TIGHT_LOW
            };
            EncodingProfile {
                encodings: with_pseudo(vec![
                    ENCODING_TIGHT,
                    16,
                    5,
                    1,
                    0,
                    ENCODING_JPEG_QUALITY_0 + quality,
                    ENCODING_COMPRESS_LEVEL_0 + compress,
                ]),
                pixel_format: PixelFormat::RGB888,
                tight_first: true,
            }
        }
    }
}

/// Line-speed thresholds for Automatic (kbit/s).
const AUTO_MEDIUM_BELOW_KBPS: u64 = 10_000;
const AUTO_LOW_BELOW_KBPS: u64 = 2_000;
const AUTO_DOWN_WINDOWS: u8 = 2;
const AUTO_UP_WINDOWS: u8 = 5;
/// Pixel-format switches wait for the outstanding update; after this much
/// silence the server has nothing in flight (it merged our requests).
pub const FORMAT_SWITCH_IDLE: Duration = Duration::from_secs(1);

#[derive(Debug)]
pub struct QualityController {
    preset: VncPictureQuality,
    level: QualityLevel,
    tight: Option<bool>,
    applied: EncodingProfile,
    pending: Option<EncodingProfile>,
    pending_since: Option<Instant>,
    down_votes: u8,
    up_votes: u8,
}

impl QualityController {
    pub fn new(preset: VncPictureQuality) -> Self {
        let level = preset.fixed_level().unwrap_or(QualityLevel::High);
        Self {
            preset,
            level,
            tight: None,
            applied: profile_for(level, None),
            pending: None,
            pending_since: None,
            down_votes: 0,
            up_votes: 0,
        }
    }

    pub fn preset(&self) -> VncPictureQuality {
        self.preset
    }

    pub fn level(&self) -> QualityLevel {
        self.level
    }

    /// Profile to request during the handshake.
    pub fn applied(&self) -> &EncodingProfile {
        &self.applied
    }

    pub fn set_preset(&mut self, preset: VncPictureQuality) {
        self.preset = preset;
        self.down_votes = 0;
        self.up_votes = 0;
        if let Some(level) = preset.fixed_level() {
            self.set_level(level);
        }
    }

    fn set_level(&mut self, level: QualityLevel) {
        self.level = level;
        self.retarget();
    }

    fn retarget(&mut self) {
        let target = profile_for(self.level, self.tight);
        if target == self.applied {
            self.pending = None;
            self.pending_since = None;
        } else if self.pending.as_ref() != Some(&target) {
            self.pending = Some(target);
            self.pending_since = Some(Instant::now());
        }
    }

    /// Learn Tight support from the first pixel update after asking for it.
    pub fn observe_update(&mut self, pixel_rects: bool, tight_rects: bool) {
        if !pixel_rects || !self.applied.tight_first || self.tight.is_some() {
            return;
        }
        self.tight = Some(tight_rects);
        if !tight_rects {
            self.retarget();
        }
    }

    /// Feed one Session Information window (Automatic only).
    pub fn observe_line_speed(&mut self, line_kbps: Option<u64>) {
        if self.preset != VncPictureQuality::Automatic {
            return;
        }
        let Some(kbps) = line_kbps else {
            return;
        };
        let wanted = if kbps < AUTO_LOW_BELOW_KBPS {
            QualityLevel::Low
        } else if kbps < AUTO_MEDIUM_BELOW_KBPS {
            QualityLevel::Medium
        } else {
            QualityLevel::High
        };
        let rank = |level: QualityLevel| match level {
            QualityLevel::Low => 0,
            QualityLevel::Medium => 1,
            QualityLevel::High => 2,
        };
        if rank(wanted) < rank(self.level) {
            self.up_votes = 0;
            self.down_votes = self.down_votes.saturating_add(1);
            if self.down_votes >= AUTO_DOWN_WINDOWS {
                self.down_votes = 0;
                self.set_level(wanted);
            }
        } else if rank(wanted) > rank(self.level) {
            self.down_votes = 0;
            // Upgrading needs a clear margin above the next tier's threshold.
            let margin = match self.level {
                QualityLevel::Low => AUTO_LOW_BELOW_KBPS,
                _ => AUTO_MEDIUM_BELOW_KBPS,
            } * 3
                / 2;
            if kbps >= margin {
                self.up_votes = self.up_votes.saturating_add(1);
                if self.up_votes >= AUTO_UP_WINDOWS {
                    self.up_votes = 0;
                    let next = if self.level == QualityLevel::Low {
                        QualityLevel::Medium
                    } else {
                        QualityLevel::High
                    };
                    self.set_level(next);
                }
            } else {
                self.up_votes = 0;
            }
        } else {
            self.down_votes = 0;
            self.up_votes = 0;
        }
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// A pending pixel-format change must wait until no update is in flight.
    pub fn pending_needs_sync(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|profile| profile.pixel_format != self.applied.pixel_format)
    }

    /// Whether a sync-requiring switch has waited long enough to force it.
    pub fn pending_overdue(&self, last_update: Instant) -> bool {
        self.pending_needs_sync()
            && last_update.elapsed() >= FORMAT_SWITCH_IDLE
            && self
                .pending_since
                .is_some_and(|since| since.elapsed() >= FORMAT_SWITCH_IDLE)
    }

    /// Take the pending profile; it becomes the applied one.
    pub fn take_pending(&mut self) -> Option<(EncodingProfile, bool)> {
        let profile = self.pending.take()?;
        self.pending_since = None;
        let format_changed = profile.pixel_format != self.applied.pixel_format;
        self.applied = profile.clone();
        Some((profile, format_changed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_map_to_realvnc_tiers() {
        let high = profile_for(QualityLevel::High, None);
        assert_eq!(high.encodings[..2], [16, 5]);
        assert_eq!(high.pixel_format, PixelFormat::RGB888);
        let medium = profile_for(QualityLevel::Medium, None);
        assert_eq!(medium.encodings[0], ENCODING_TIGHT);
        assert!(medium.encodings.contains(&(ENCODING_JPEG_QUALITY_0 + 6)));
        let low_plain = profile_for(QualityLevel::Low, Some(false));
        assert_eq!(low_plain.pixel_format, LOW_COLOUR);
        assert!(!low_plain.encodings.contains(&ENCODING_TIGHT));
        assert_eq!(low_plain.requested_label(), "ZRLE");
        assert_eq!(medium.requested_label(), "Tight");
    }

    #[test]
    fn falling_back_from_tight_needs_a_synchronised_format_switch() {
        let mut quality = QualityController::new(VncPictureQuality::Medium);
        assert!(quality.applied().tight_first);
        // A pixel update without Tight rectangles: the server lacks Tight.
        quality.observe_update(true, false);
        assert!(quality.has_pending());
        assert!(quality.pending_needs_sync());
        let (profile, changed) = quality.take_pending().unwrap();
        assert!(changed);
        assert_eq!(profile.pixel_format, MEDIUM_COLOUR);
        // Learned once; later updates do not flip it back.
        quality.observe_update(true, true);
        assert!(!quality.has_pending());
    }

    #[test]
    fn switching_between_tight_tiers_keeps_the_pixel_format() {
        let mut quality = QualityController::new(VncPictureQuality::Medium);
        quality.observe_update(true, true);
        quality.set_preset(VncPictureQuality::Low);
        assert!(quality.has_pending());
        assert!(!quality.pending_needs_sync());
        quality.take_pending();
        quality.set_preset(VncPictureQuality::Low);
        assert!(!quality.has_pending());
    }

    #[test]
    fn automatic_follows_line_speed_with_hysteresis() {
        let mut quality = QualityController::new(VncPictureQuality::Automatic);
        assert_eq!(quality.level(), QualityLevel::High);
        quality.observe_line_speed(Some(8_000));
        assert_eq!(quality.level(), QualityLevel::High);
        quality.observe_line_speed(Some(8_000));
        assert_eq!(quality.level(), QualityLevel::Medium);
        quality.take_pending();
        // 12 Mbit/s is above the threshold but inside the 1.5x margin.
        for _ in 0..10 {
            quality.observe_line_speed(Some(12_000));
        }
        assert_eq!(quality.level(), QualityLevel::Medium);
        for _ in 0..5 {
            quality.observe_line_speed(Some(40_000));
        }
        assert_eq!(quality.level(), QualityLevel::High);
        // Fixed presets ignore the estimate.
        quality.set_preset(VncPictureQuality::High);
        quality.observe_line_speed(Some(100));
        quality.observe_line_speed(Some(100));
        assert_eq!(quality.level(), QualityLevel::High);
    }
}
