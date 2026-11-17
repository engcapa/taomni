//! Negotiated, transport-scoped replay protection for long-lived stdio peers.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{RequestId, services::HostInstanceId};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequestIdMode {
    #[default]
    Legacy,
    MonotonicV1,
}

impl RequestIdMode {
    pub fn is_legacy(&self) -> bool {
        *self == Self::Legacy
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplayError {
    Invalid,
    Duplicate,
    Full,
}

/// Only a successful handshake selects monotonic mode. Its constant-size
/// watermark remembers every older sequence, including rejected requests.
/// Legacy peers keep their existing bounded ledger and failure behavior.
#[derive(Debug)]
pub struct RequestReplay {
    mode: RequestIdMode,
    prefix: Option<String>,
    last: u64,
    seen: HashSet<RequestId>,
}

impl RequestReplay {
    pub fn new(
        mode: RequestIdMode,
        direction: &str,
        host: Option<&HostInstanceId>,
    ) -> Result<Self, ReplayError> {
        if !matches!(direction, "core" | "host")
            || (mode == RequestIdMode::MonotonicV1 && host.is_none())
        {
            return Err(ReplayError::Invalid);
        }
        Ok(Self {
            mode,
            prefix: host.map(|host| format!("{direction}/{host}/")),
            last: 0,
            seen: HashSet::new(),
        })
    }

    pub fn accept(&mut self, id: &RequestId) -> Result<(), ReplayError> {
        if self.mode.is_legacy() {
            if self.seen.contains(id) {
                return Err(ReplayError::Duplicate);
            }
            if self.seen.len() >= 65_536 {
                return Err(ReplayError::Full);
            }
            self.seen.insert(id.clone());
            return Ok(());
        }
        let RequestId::String(id) = id else {
            return Err(ReplayError::Invalid);
        };
        let suffix = id
            .strip_prefix(self.prefix.as_deref().expect("negotiated host"))
            .ok_or(ReplayError::Invalid)?;
        if suffix.is_empty()
            || suffix.len() > 20
            || suffix.starts_with('0')
            || !suffix.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(ReplayError::Invalid);
        }
        let sequence = suffix.parse::<u64>().map_err(|_| ReplayError::Invalid)?;
        if sequence <= self.last {
            return Err(ReplayError::Duplicate);
        }
        self.last = sequence;
        Ok(())
    }
}

#[cfg(test)]
#[path = "correlation_tests.rs"]
mod tests;
