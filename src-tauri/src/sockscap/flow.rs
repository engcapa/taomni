//! Per-connection flow context.

use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct FlowContext {
    pub pid: u32,
    pub process_path: Option<PathBuf>,
    pub src: SocketAddr,
    pub dst: SocketAddr,
    /// Best-effort hostname (SNI / DNS map / platform).
    pub hostname: Option<String>,
}
