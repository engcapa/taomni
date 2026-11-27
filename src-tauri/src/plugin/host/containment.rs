//! Process-tree ownership. Dropping the core's ownership handle terminates
//! every descendant, including when the core is killed without running Drop.

#[cfg(unix)]
#[path = "watchdog_unix.rs"]
mod watchdog_unix;

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

/// Sentinel argv[1] used by re-execed Unix plugin containment watchdogs.
pub const PLUGIN_WATCHDOG_ARG: &str = "--plugin-watchdog";

/// Opt into re-execing the current binary as a lightweight watchdog process
/// after `fork()` when running from a binary whose `main` dispatches
/// [`PLUGIN_WATCHDOG_ARG`].
pub fn enable_plugin_watchdog_exec() {
    #[cfg(unix)]
    watchdog_unix::enable_exec();
}

/// Entrypoint for re-execed Unix plugin containment watchdogs.
pub fn run_plugin_watchdog(args: impl Iterator<Item = std::ffi::OsString>) -> i32 {
    #[cfg(unix)]
    {
        platform::run_plugin_watchdog(args)
    }
    #[cfg(not(unix))]
    {
        let _ = args;
        1
    }
}
