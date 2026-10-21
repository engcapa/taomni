//! ptrace/seccomp supervisor for unprivileged Linux application capture.
//!
//! The launcher installs a seccomp filter that reports `socket(2)` and
//! `connect(2)`. This supervisor follows the complete process tree, tracks
//! socket types, temporarily rewrites TCP destinations to the rootless
//! loopback ingress, and restores application memory after the syscall returns.

mod limits;

mod flows;

mod supervisor;

mod event_loop;

mod network;

mod registers;

mod sockets;

mod process;

mod preflight;

#[cfg(test)]
mod tests;

pub use flows::{FlowQueue, ProcessIdentity, TracedFlow};

pub use supervisor::{LaunchCommand, LaunchStatus, SpawnedTerminal, TracerSupervisor};

pub use preflight::preflight;
