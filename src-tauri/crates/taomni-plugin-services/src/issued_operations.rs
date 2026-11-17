//! Core-only operation allocation. No caller can select or re-admit an issued ID.
use taomni_plugin_api::services::{CoreServiceError, OperationId};

// Reserved UUID-shaped namespace; old explicit-ID entry points reject it.
const PREFIX: &str = "74616f6d-";
const MAX_SEQUENCE: u128 = (1_u128 << 88) - 1;

#[derive(Default)]
pub(crate) struct IssuedOperations(u128);

impl IssuedOperations {
    pub fn next(&mut self) -> Result<OperationId, CoreServiceError> {
        if self.0 >= MAX_SEQUENCE {
            return Err(CoreServiceError::CoreServiceBusy);
        }
        self.0 += 1;
        // Version 8 + variant 8 distinguish this namespace from core-local
        // random v4 IDs, even if their random prefix happens to match ours.
        let hex = format!("{:022x}", self.0);
        OperationId::parse(format!(
            "74616f6d-{}-8{}-8{}-{}",
            &hex[..4],
            &hex[4..7],
            &hex[7..10],
            &hex[10..]
        ))
        .map_err(|_| CoreServiceError::StalePluginContext)
    }
}

pub(crate) fn is_core_issued(operation: &OperationId) -> bool {
    let value = operation.as_str();
    value.starts_with(PREFIX) && value.as_bytes()[14] == b'8' && value.as_bytes()[19] == b'8'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocation_crosses_the_old_limit_without_a_history_or_id_reuse() {
        let mut issued = IssuedOperations::default();
        let first = issued.next().unwrap();
        let mut previous = first.clone();
        for _ in 1..70_000 {
            let next = issued.next().unwrap();
            assert!(is_core_issued(&next));
            assert!(next.as_str() > previous.as_str());
            previous = next;
        }
        assert_ne!(first, previous);
        assert_eq!(std::mem::size_of::<IssuedOperations>(), 16);
        assert!(!is_core_issued(
            &OperationId::parse("74616f6d-0000-4000-8000-000000000001").unwrap()
        ));
        let mut exhausted = IssuedOperations(MAX_SEQUENCE - 1);
        assert!(exhausted.next().is_ok());
        assert_eq!(exhausted.next(), Err(CoreServiceError::CoreServiceBusy));
        assert_eq!(exhausted.next(), Err(CoreServiceError::CoreServiceBusy));
    }
}
