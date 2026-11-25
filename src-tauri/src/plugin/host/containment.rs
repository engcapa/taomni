//! Process-tree ownership. Dropping the core's ownership handle terminates
//! every descendant, including when the core is killed without running Drop.

#[cfg(target_os = "linux")]
#[path = "containment_linux.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "containment_macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "containment_windows.rs"]
mod platform;

pub(super) use platform::ProcessContainment;
