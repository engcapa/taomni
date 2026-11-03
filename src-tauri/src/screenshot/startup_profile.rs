//! Switches for the overlay startup pipeline.
//!
//! Every optimisation of the startup path can be turned off independently,
//! so a platform regression can be rolled back without a rebuild:
//! `TAOMNI_SCREENSHOT_STARTUP=legacy` restores the serial pipeline, and a
//! comma list such as `-exclusion,-handshake` disables single items.

use std::sync::Mutex;
use std::time::Duration;

static QA_PROFILE: Mutex<Option<StartupProfile>> = Mutex::new(None);

/// Scoped only by the isolated QA scenarios after ensure_qa. Never survives
/// their cancellation/error cleanup or modifies user settings.
pub(super) struct QaProfile(Option<StartupProfile>);

impl QaProfile {
    pub(super) fn install(profile: StartupProfile) -> Self {
        Self(
            QA_PROFILE
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .replace(profile),
        )
    }
}

impl Drop for QaProfile {
    fn drop(&mut self) {
        *QA_PROFILE.lock().unwrap_or_else(|p| p.into_inner()) = self.0.take();
    }
}

/// Fallback when the overlay renderer never reports its base image.
const DEFAULT_READY_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct StartupProfile {
    /// P1-2: build the hidden overlay window while hiding and capturing.
    pub(super) early_window: bool,
    /// P1-1: retain a successfully opened selection surface between sessions.
    /// Idle windows own no capture, lease, image URL or editable session state.
    pub(super) reuse_window: bool,
    /// P0-1: show the overlay only after its base image is committed.
    pub(super) ready_handshake: bool,
    pub(super) ready_timeout: Duration,
    /// P0-1b: transparent overlay surface until the base image is drawn.
    pub(super) transparent: bool,
    /// P1-3: open the Linux capturer while the app windows hide.
    pub(super) capture_overlap: bool,
    /// P1-6: exclude app windows from capture instead of hiding them first
    /// (Windows and macOS versions with a verified exclusion API only).
    pub(super) capture_exclusion: bool,
}

impl StartupProfile {
    /// Hidden execution/decoding: six hosted combinations, 40/40 ready before
    /// show each. Reuse now has an explicit lifecycle owner and native checks;
    /// exclusion is independently restricted to verified OS builds.
    pub(super) const DEFAULT: Self = Self {
        early_window: true,
        reuse_window: true,
        ready_handshake: true,
        ready_timeout: DEFAULT_READY_TIMEOUT,
        transparent: true,
        capture_overlap: true,
        capture_exclusion: true,
    };

    pub(super) const OPTIMIZED: Self = Self {
        early_window: true,
        reuse_window: false,
        ready_handshake: true,
        ready_timeout: DEFAULT_READY_TIMEOUT,
        transparent: true,
        capture_overlap: true,
        capture_exclusion: true,
    };

    pub(super) const LEGACY: Self = Self {
        early_window: false,
        reuse_window: false,
        ready_handshake: false,
        ready_timeout: DEFAULT_READY_TIMEOUT,
        transparent: false,
        capture_overlap: false,
        capture_exclusion: false,
    };

    /// Apply `TAOMNI_SCREENSHOT_STARTUP`: `legacy`, or `+item`/`-item` tokens.
    pub(super) fn with_overrides(mut self, spec: &str) -> Self {
        for token in spec.split(',').map(str::trim).filter(|t| !t.is_empty()) {
            if token.eq_ignore_ascii_case("legacy") || token.eq_ignore_ascii_case("optimized") {
                self = Self {
                    ready_timeout: self.ready_timeout,
                    ..if token.eq_ignore_ascii_case("legacy") {
                        Self::LEGACY
                    } else {
                        Self::OPTIMIZED
                    }
                };
                continue;
            }
            let (enabled, name) = match token.as_bytes()[0] {
                b'-' => (false, &token[1..]),
                b'+' => (true, &token[1..]),
                _ => (true, token),
            };
            match name {
                "early-window" => self.early_window = enabled,
                "reuse" => self.reuse_window = enabled,
                "handshake" => self.ready_handshake = enabled,
                "transparent" => self.transparent = enabled,
                "overlap" => self.capture_overlap = enabled,
                "exclusion" => self.capture_exclusion = enabled,
                _ => {
                    if let Some(ms) = name
                        .strip_prefix("ready-timeout=")
                        .and_then(|v| v.parse::<u64>().ok())
                    {
                        self.ready_timeout = Duration::from_millis(ms.clamp(100, 10_000));
                    } else {
                        log::warn!("ignored screenshot startup switch {token:?}");
                    }
                }
            }
        }
        // Reuse must never expose the previous bitmap: it is valid only with
        // an early hidden remount and the generation-matched ready barrier.
        if self.reuse_window && !(self.early_window && self.ready_handshake) {
            self.reuse_window = false;
        }
        self
    }
}

/// The profile for the next open.
pub(super) fn current() -> StartupProfile {
    if let Some(profile) = *QA_PROFILE.lock().unwrap_or_else(|p| p.into_inner()) {
        return profile;
    }
    match std::env::var("TAOMNI_SCREENSHOT_STARTUP") {
        Ok(spec) => StartupProfile::DEFAULT.with_overrides(&spec),
        Err(_) => StartupProfile::DEFAULT,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resident_reuse_requires_hidden_early_mount_and_ready_barrier() {
        assert!(
            StartupProfile::DEFAULT
                .with_overrides("+reuse")
                .reuse_window
        );
        assert!(
            StartupProfile::OPTIMIZED
                .with_overrides("+reuse")
                .reuse_window
        );
        assert!(
            !StartupProfile::OPTIMIZED
                .with_overrides("+reuse,-handshake")
                .reuse_window
        );
        assert!(
            !StartupProfile::OPTIMIZED
                .with_overrides("+reuse,-early-window")
                .reuse_window
        );
    }

    #[test]
    fn overrides_toggle_single_items_and_legacy_restores_serial_pipeline() {
        let profile = StartupProfile::OPTIMIZED.with_overrides("-exclusion, -handshake");
        assert!(!profile.capture_exclusion);
        assert!(!profile.ready_handshake);
        assert!(profile.early_window && profile.capture_overlap && profile.transparent);
        let legacy = StartupProfile::OPTIMIZED.with_overrides("legacy,+transparent");
        assert_eq!(
            legacy,
            StartupProfile {
                transparent: true,
                ..StartupProfile::LEGACY
            }
        );
        let timeout = StartupProfile::OPTIMIZED.with_overrides("ready-timeout=20,unknown");
        assert_eq!(timeout.ready_timeout, Duration::from_millis(100));
        assert_eq!(
            StartupProfile::OPTIMIZED.with_overrides(""),
            StartupProfile::OPTIMIZED
        );
    }
}
