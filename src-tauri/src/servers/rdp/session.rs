//! Linux virtual / headless session support for the RDP server (dev plan §7–§9,
//! phase 7) — the "xrdp model".
//!
//! ## What this is
//! The base server mirrors the **current** desktop (the console `:0`). The
//! advanced Linux capability is to instead give each connection its own
//! independent, optionally headless display server — the xrdp architecture:
//! authenticate (PAM), fork a per-session display server (`Xvfb` /
//! `Xorg -config dummy` / a headless Wayland compositor), point capture + input
//! at that server's `DISPLAY`, and tear it down on disconnect. One mechanism
//! covers §7 (independent sessions), §8 (no hidden lock screen to fight — you
//! own the session) and §9 (headless / no monitor).
//!
//! ## Status on this build
//! This module ships the **capability detection and the spawn plan**, not a live
//! PAM gateway. Spawning per-user sessions needs `Xvfb`/`Xorg-dummy` installed
//! and (for real multi-user auth) PAM integration + privilege to switch users —
//! none of which are guaranteed in a dev environment, and which the dev plan
//! explicitly scopes as advanced, environment-specific work. [`probe`] reports
//! what the host can actually do so the leaf can surface an honest message
//! instead of pretending. The `:0` console-mirror path (phases 0–6) is the
//! default and needs none of this.
//!
//! ## Enabling the live sesman (future work)
//! 1. Locate a backend: `Xvfb :N -screen 0 1920x1080x24` (simplest) or
//!    `Xorg :N -config xorg-dummy.conf` (GPU), or `Weston --backend=headless`.
//! 2. Authenticate the RDP user against PAM (`pam` crate) — this is what makes it
//!    multi-user; without it, restrict to the invoking user.
//! 3. Spawn the backend on a free display number, start a session
//!    (`startx`/session bus), export `DISPLAY=:N`, and build the X11 capturer +
//!    enigo input against that display (both already accept an explicit display
//!    via env / connection string).
//! 4. Supervise + reap the backend when the RDP connection ends.

/// What headless/virtual-session backends are available on this host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Capabilities {
    pub xvfb: bool,
    pub xorg_dummy: bool,
    pub weston_headless: bool,
}

impl Capabilities {
    /// Any backend at all available for a headless/virtual session?
    pub(crate) fn any(&self) -> bool {
        self.xvfb || self.xorg_dummy || self.weston_headless
    }

    /// Human-readable summary for logs / UI.
    pub(crate) fn summary(&self) -> String {
        if !self.any() {
            return "no headless display backend found (install Xvfb or xorg dummy driver)"
                .to_string();
        }
        let mut parts = Vec::new();
        if self.xvfb {
            parts.push("Xvfb");
        }
        if self.xorg_dummy {
            parts.push("Xorg");
        }
        if self.weston_headless {
            parts.push("Weston(headless)");
        }
        format!("available headless backends: {}", parts.join(", "))
    }
}

/// Detect which virtual-session backends this host can run. Pure PATH probing —
/// no processes are spawned.
#[cfg(target_os = "linux")]
pub(crate) fn probe() -> Capabilities {
    let has = |bin: &str| which::which(bin).is_ok();
    Capabilities {
        xvfb: has("Xvfb"),
        // The dummy driver is an Xorg module; presence of Xorg is the prerequisite.
        xorg_dummy: has("Xorg"),
        weston_headless: has("weston"),
    }
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn probe() -> Capabilities {
    // Independent virtual sessions are a Linux-only capability per the dev plan
    // (Windows client SKUs forbid it; macOS has a single GUI session).
    Capabilities {
        xvfb: false,
        xorg_dummy: false,
        weston_headless: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_reports_absence_clearly() {
        let none = Capabilities {
            xvfb: false,
            xorg_dummy: false,
            weston_headless: false,
        };
        assert!(!none.any());
        assert!(none.summary().contains("no headless display backend"));
    }

    #[test]
    fn summary_lists_present_backends() {
        let caps = Capabilities {
            xvfb: true,
            xorg_dummy: false,
            weston_headless: true,
        };
        assert!(caps.any());
        let s = caps.summary();
        assert!(s.contains("Xvfb"));
        assert!(s.contains("Weston"));
        assert!(!s.contains("Xorg"));
    }
}
