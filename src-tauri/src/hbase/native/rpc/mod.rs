//! HBase RPC transport: connection preamble, ConnectionHeader, request/response
//! framing, and call-id multiplexing over a single TCP connection.

pub mod codec;
pub mod conn;
