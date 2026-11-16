//! Stdio runtime for trusted official plugin hosts. The reader remains active
//! while the business worker waits for a typed core service response. No Vault
//! path, generic key Value, Tauri dependency or cross-operation key cache.

mod client;
mod operation;
mod runtime;
mod sensitive;

pub use operation::{Operation, OperationKey};
pub use runtime::{HostConfig, PluginHandler, serve, serve_stdio};

#[cfg(test)]
mod tests;
