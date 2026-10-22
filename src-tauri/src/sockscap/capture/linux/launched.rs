//! Unprivileged Linux capture for applications launched by SocksCap.
//!
//! A private launcher installs a seccomp filter and enters ptrace supervision
//! before it execs the requested desktop or TUI application. The filter is
//! inherited by the complete process tree and reports socket creation plus
//! TCP connection attempts.

mod limits;

mod model;

mod lifetime;

mod process_groups;

mod preparation;

mod ingress;

#[cfg(test)]
mod tests;

pub use model::{LaunchedAppInfo, LaunchedAppPhase};

pub use lifetime::LaunchedCaptureHandle;

pub use preparation::preflight;
