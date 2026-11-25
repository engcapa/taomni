//! Plugin data snapshots and restore dependencies, independent of package code.
pub mod contracts;
mod live;
mod offline;
mod open_snapshot;
mod plan;
pub(crate) mod restore;
pub(crate) mod snapshot;

pub(crate) use plan::discover_owners;
pub(crate) use restore::{check_restore_dependencies, restore_targets};

#[cfg(test)]
mod contracts_tests;
#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod offline_tests;
#[cfg(test)]
mod restore_tests;
#[cfg(test)]
mod snapshot_tests;
#[cfg(test)]
mod test_support;
