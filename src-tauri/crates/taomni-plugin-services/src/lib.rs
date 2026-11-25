//! Core-owned service policy and admission, independent of Tauri or AppState.
//!
//! These types never verify a package signature themselves. The production
//! registry must construct VerifiedHostGrants only from its authenticated,
//! verified installed package, never from renderer JSON or a host's self-report.
//! The host never receives this crate's admission permits or OS lease handles.

mod admission;
mod binary_transfer;
mod capture_still;
mod core_operation;
mod dispatcher;
mod grants;
mod issued_operations;
mod operation;
mod policy;
mod revoke;
mod sensitive_frame;
mod service_request;
mod session;
mod snapshot_pause;

pub use admission::{OperationAdmission, OperationPermit};
pub use binary_transfer::offer_binary_for_request;
pub use capture_still::StillCaptureService;
pub use core_operation::CoreOperationPermit;
pub use dispatcher::{CoreServiceBackend, CoreServiceDispatcher, DispatcherConfig};
pub use operation::{BorrowedOperation, OperationKind};
pub use policy::{AuthorizedHost, FixedKeyOwner, MFA_FIXED_KEY_OWNER, VerifiedHostGrants};
pub use revoke::{AdmissionState, Revocation};
pub use sensitive_frame::SensitiveServiceFrame;
pub use service_request::ReverseRequestPermit;
pub use session::{ServiceCompletion, ServiceSession};
pub use snapshot_pause::AdmissionPause;

#[cfg(test)]
mod dispatcher_tests;
#[cfg(test)]
mod tests;
