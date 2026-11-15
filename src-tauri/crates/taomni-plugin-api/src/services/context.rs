use serde::{Deserialize, Serialize};
use std::fmt;

use super::ContractError;

macro_rules! uuid_id {
    ($($name:ident),+ $(,)?) => {$ (
        #[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, ContractError> {
                let value = value.into();
                if !canonical_uuid(&value) {
                    return Err(ContractError::InvalidIdentifier);
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str { &self.0 }
        }

        impl TryFrom<String> for $name {
            type Error = ContractError;
            fn try_from(value: String) -> Result<Self, Self::Error> { Self::parse(value) }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self { value.0 }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
        }
    )+};
}

uuid_id!(
    HostInstanceId,
    OperationId,
    ProfileGeneration,
    SnapshotJobId,
    SnapshotBarrierToken,
    StagingToken,
);

macro_rules! private_grant {
    ($($name:ident),+ $(,)?) => {$ (
        #[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, ContractError> {
                let value = value.into();
                if !canonical_uuid(&value) { return Err(ContractError::InvalidIdentifier); }
                Ok(Self(value))
            }
        }
        impl TryFrom<String> for $name {
            type Error = ContractError;
            fn try_from(value: String) -> Result<Self, Self::Error> { Self::parse(value) }
        }
        impl From<$name> for String {
            fn from(value: $name) -> Self { value.0 }
        }
        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "([REDACTED])"))
            }
        }
    )+};
}

private_grant!(ResetGrantId, ExportGrantId);

fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
        && value.bytes().any(|byte| byte != b'0' && byte != b'-')
}

/// A local core generation. Authentication also binds it to HostInstanceId.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct VaultEpoch(u64);

impl VaultEpoch {
    pub fn new(value: u64) -> Result<Self, ContractError> {
        if value == 0 {
            return Err(ContractError::InvalidEpoch);
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u64 {
        self.0
    }

    pub fn next(self) -> Result<Self, ContractError> {
        self.0
            .checked_add(1)
            .map(Self)
            .ok_or(ContractError::InvalidEpoch)
    }
}

impl TryFrom<u64> for VaultEpoch {
    type Error = ContractError;
    fn try_from(value: u64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<VaultEpoch> for u64 {
    fn from(value: VaultEpoch) -> Self {
        value.0
    }
}

/// Correlation data only. The dispatcher must compare every field with its
/// authenticated transport and live admission table, never trust self-report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationContext {
    pub host_instance: HostInstanceId,
    pub operation: OperationId,
    pub profile_generation: ProfileGeneration,
    pub vault_epoch: VaultEpoch,
}
