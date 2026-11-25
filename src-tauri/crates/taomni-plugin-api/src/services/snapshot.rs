use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::{
    HostInstanceId, ProfileGeneration, SafeRelativePath, Sha256Digest, SnapshotBarrierToken,
    SnapshotJobId, StagingToken, VaultEpoch,
};

pub const SNAPSHOT_PREPARE_METHOD: &str = "backup/prepare";
pub const SNAPSHOT_METHOD: &str = "backup/snapshot";
pub const SNAPSHOT_RELEASE_METHOD: &str = "backup/release";
pub const VAULT_REVOKE_METHOD: &str = "vault/revoke";

/// The core creates this grant. A host must not accept a renderer-selected root.
/// Typed paths alone do not replace handle/containment checks at the boundary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotDestinationGrant {
    pub token: StagingToken,
    pub absolute_job_root: PathBuf,
    pub allowed_files: Vec<SafeRelativePath>,
    /// A subset whose contents are opaque to the module, such as attachments
    /// that happen to contain a SQLite database.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub opaque_files: Vec<SafeRelativePath>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareSnapshot {
    pub job: SnapshotJobId,
    pub profile_generation: ProfileGeneration,
    pub destination: SnapshotDestinationGrant,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedSnapshot {
    pub job: SnapshotJobId,
    pub host_instance: HostInstanceId,
    pub profile_generation: ProfileGeneration,
    pub barrier: SnapshotBarrierToken,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotRequest {
    pub job: SnapshotJobId,
    pub barrier: SnapshotBarrierToken,
    pub staging: StagingToken,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotFile {
    pub relative_path: SafeRelativePath,
    pub size_bytes: u64,
    pub sha256: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotResult {
    pub job: SnapshotJobId,
    pub host_instance: HostInstanceId,
    pub profile_generation: ProfileGeneration,
    pub files: Vec<SnapshotFile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseSnapshot {
    pub job: SnapshotJobId,
    pub barrier: SnapshotBarrierToken,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokeKeys {
    pub host_instance: HostInstanceId,
    pub profile_generation: ProfileGeneration,
    pub vault_epoch: VaultEpoch,
}

/// The core must also drain its admission table; an unresponsive host is
/// terminated before the core can report successful revocation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokedKeys {
    pub host_instance: HostInstanceId,
    pub profile_generation: ProfileGeneration,
    pub vault_epoch: VaultEpoch,
}
