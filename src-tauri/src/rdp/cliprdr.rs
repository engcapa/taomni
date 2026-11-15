//! Compatibility exports for the shared CLIPRDR protocol and file URI APIs.
//!
//! Implementations live in independent libraries so the server and core do
//! not depend on the RDP client implementation.

pub use taomni_file_uri::{paths_to_uri_list, uri_list_to_paths};
pub use taomni_rdp_common::cliprdr::*;
