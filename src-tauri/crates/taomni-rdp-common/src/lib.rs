//! RDP utilities shared by independent client and server implementations.
//!
//! This crate owns deterministic wire/clipboard codecs and bounded file IO.
//! Session state, clipboard ownership, quotas and cancellation stay with each
//! endpoint. It has no dependency on the application or a WebView runtime.

pub mod clipboard_formats;
pub mod cliprdr;
pub mod file_transfer;

#[cfg(feature = "bitmap")]
pub mod bitmap;

/// Generic file-URI helpers also used directly by the protocol-free core.
pub use taomni_file_uri::{paths_to_uri_list, uri_list_to_paths};
