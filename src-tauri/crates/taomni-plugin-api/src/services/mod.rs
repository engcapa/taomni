//! Additive shared-service contracts. Existing RPC payloads and versions are
//! unchanged; the production host adapter must explicitly opt into these DTOs.
//!
//! Authentication, authorization, admission and lease ownership belong to the
//! core dispatcher. Deserializing a context never authenticates a host.

mod capture;
mod context;
mod error;
mod fixed_key;
mod luma_frames;
mod secret;
mod snapshot;
mod value;

pub use capture::*;
pub use context::*;
pub use error::*;
pub use fixed_key::*;
pub use luma_frames::*;
pub use secret::*;
pub use snapshot::*;
pub use value::*;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::RequestId;

pub const FIXED_KEY_SERVICE: &str = "vault.fixed-key";
pub const SNAPSHOT_SERVICE: &str = "backup.snapshot";
pub const SERVICE_VERSION: u16 = 1;
pub const HOST_PROFILE_ENV: &str = "TAOMNI_PLUGIN_PROFILE";

/// Compiled owner plus persistent profile generation; no data path or grant.
/// The core supplies paths separately through its per-process environment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostProfileContext {
    pub owner: String,
    pub generation: ProfileGeneration,
}

/// Negotiated separately from API_VERSION; no service is implicitly granted.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ServiceCapabilities(pub BTreeMap<String, u16>);

impl ServiceCapabilities {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn supports(&self, service: &str, version: u16) -> bool {
        self.0.get(service).copied() == Some(version)
    }
}

/// A typed service request used internally by the bidirectional dispatcher.
/// The wire RpcRequest carries context at the top level, leaving params intact.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceRequest<T> {
    pub id: RequestId,
    pub context: OperationContext,
    pub params: T,
}

impl<T> ServiceRequest<T> {
    pub fn new(id: RequestId, context: OperationContext, params: T) -> Self {
        Self {
            id,
            context,
            params,
        }
    }
}

#[cfg(test)]
mod tests;
