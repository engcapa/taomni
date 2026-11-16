//! Stdio runtime for trusted official plugin hosts. The reader remains active
//! while the business worker waits for a typed core service response. No Vault
//! path, generic key Value, Tauri dependency or cross-operation key cache.

mod client;
mod operation;
mod profile;
mod runtime;
mod sensitive;
mod snapshot;
mod snapshot_export;

pub use operation::{Operation, OperationKey};
pub use profile::{HostStorage, confirm_profile_handshake};
pub use runtime::{HostConfig, PluginHandler, serve, serve_stdio, serve_stdio_with};
pub use snapshot::SnapshotProvider;
pub use snapshot_export::SnapshotExport;

#[cfg(test)]
mod tests;
