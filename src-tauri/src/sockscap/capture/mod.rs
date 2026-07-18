//! Native capture boundary shared by the three platform implementations.
//!
//! The product policy and egress credentials stay in the unprivileged Taomni
//! process. Platform adapters receive only the selectors, gateway address and
//! hard-bypass information required to install one capture plane. Privileged
//! mutations are expressed through the versioned protocol in
//! [`helper_protocol`]; adapters must never pass arbitrary shell commands.

mod adapter;
pub mod helper_protocol;

pub use adapter::*;
