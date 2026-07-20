//! Taomni-owned control plane around the pinned smoltcp state machine.
//!
//! This module does not make smoltcp itself a product capability. The packet
//! driver must still bind capture identity, enforce [`IpStackConfig`] budgets,
//! own every socket and task, and pass native/release gates before Linux
//! capture can be enabled.

pub mod device;

#[cfg(test)]
mod compatibility_spike;

use crate::sockscap::flow::ip_stack::IpStackProviderPin;

pub const PROVIDER_NAME: &str = "smoltcp";
pub const PROVIDER_VERSION: &str = "0.13.1";
/// SHA-256 of the exact crates.io `smoltcp-0.13.1.crate` archive. Cargo.lock
/// independently records the same registry checksum.
pub const PROVIDER_SOURCE_SHA256: &str =
    "5f73d40463bba65efc9adc6370b56df76d563cc46e2482bba58351b4afb7535e";

pub fn provider_pin() -> IpStackProviderPin {
    IpStackProviderPin {
        name: PROVIDER_NAME.into(),
        version: PROVIDER_VERSION.into(),
        source_sha256: PROVIDER_SOURCE_SHA256.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_provider_pin_is_valid_and_matches_the_locked_archive() {
        let pin = provider_pin();
        pin.validate().expect("fixed smoltcp provider pin");
        assert_eq!(pin.name, "smoltcp");
        assert_eq!(pin.version, "0.13.1");
        assert_eq!(pin.source_sha256, PROVIDER_SOURCE_SHA256);
    }
}
