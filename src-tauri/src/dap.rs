//! Language-agnostic Debug Adapter Protocol kernel (M8 D1).
//!
//! DAP frames messages exactly like LSP — `Content-Length: N\r\n\r\n` followed by
//! N bytes of JSON — so the codec here mirrors the LSP one. Everything in this
//! module is DAP-standard: sessions hold threads / stackFrames / scopes /
//! variables / breakpoints as raw JSON with no language-specific fields. A
//! `DebugAdapterRegistry` (empty until the Java adapter, D2) decides how to reach
//! an adapter for a given launch config; the kernel then runs the same request /
//! response / event pump regardless of language.

mod codec;

mod adapter;

mod session;

mod transport;

mod reader;

mod commands;

#[cfg(test)]
mod tests;

pub use codec::{
    DapDecoder, InboundMessage, classify_message, encode_message, extract_error_message,
};

pub use adapter::{DapLaunchPlan, DapTransport, DebugAdapter, DebugAdapterRegistry};

pub use session::{DapManager, DapSession};

pub use reader::reverse_response;

pub use commands::{DapStartResult, dap_send, dap_send_request, dap_start_session, dap_terminate};

pub(crate) use commands::{
    __cmd__dap_send, __cmd__dap_send_request, __cmd__dap_start_session, __cmd__dap_terminate,
    __tauri_command_name_dap_send, __tauri_command_name_dap_send_request,
    __tauri_command_name_dap_start_session, __tauri_command_name_dap_terminate,
};
