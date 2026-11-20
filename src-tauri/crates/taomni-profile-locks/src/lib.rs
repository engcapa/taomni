//! Shared OS leases, without Tauri, business state or an async runtime.
//!
//! Lock paths deliberately match the existing core profile lock. Hold a
//! ProfileUseLease until *all* owned data handles are closed; a host owns its
//! own lease so a core crash cannot expose a still-running writer to restore.
//! Locks coordinate cooperating processes; they are not a filesystem sandbox.

mod lease;
mod paths;
mod wait;

pub use lease::{
    LegacyDesktopLease, LegacyUpgradeLease, PluginDataLease, ProfileRestoreLease,
    ProfileStateLease, ProfileUseLease, VaultOperationLease,
};
pub use paths::{PluginSlug, ProfileRoot};
pub use wait::{LeaseError, LeaseKind, WaitControl};

#[cfg(test)]
mod tests;
