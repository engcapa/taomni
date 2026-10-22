use crate::hbase::native::rpc::conn::RpcError;
use crate::hbase::native::zk;
use std::time::Duration;

/// Connection / bootstrap configuration for the native client.
#[derive(Debug, Clone)]
pub struct NativeConfig {
    /// Comma-separated `host:port` ZooKeeper quorum.
    pub zk_quorum: String,
    /// ZK root znode (default `/hbase`).
    pub zk_root: String,
    /// Effective user for simple auth.
    pub effective_user: String,
    /// Default namespace prefixed to unqualified table names.
    pub namespace: Option<String>,
    /// Connect/operation timeout.
    pub timeout: Duration,
    /// Authentication method (simple or Kerberos).
    pub auth: super::super::auth::AuthMethod,
}

impl Default for NativeConfig {
    fn default() -> Self {
        Self {
            zk_quorum: "localhost:2181".into(),
            zk_root: zk::DEFAULT_ZK_ROOT.into(),
            effective_user: "root".into(),
            namespace: None,
            timeout: Duration::from_secs(15),
            auth: super::super::auth::AuthMethod::Simple,
        }
    }
}

#[derive(Debug)]
pub enum ClientError {
    Zk(String),
    Rpc(String),
    Region(String),
    Decode(String),
    Unsupported(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Zk(e) => write!(f, "{e}"),
            ClientError::Rpc(e) => write!(f, "{e}"),
            ClientError::Region(e) => write!(f, "{e}"),
            ClientError::Decode(e) => write!(f, "HBase decode error: {e}"),
            ClientError::Unsupported(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<RpcError> for ClientError {
    fn from(e: RpcError) -> Self {
        ClientError::Rpc(e.to_string())
    }
}

/// A get/scan cell row, flattened for the shell result table.
#[derive(Debug, Clone)]
pub struct ResultRow {
    pub row: Vec<u8>,
    pub column: Vec<u8>,
    pub timestamp: u64,
    pub value: Vec<u8>,
}

// ---- control plane (MasterService) -----------------------------------------

/// A column family descriptor for `describe`.
#[derive(Debug, Clone)]
pub struct FamilyDesc {
    pub name: String,
    pub attributes: std::collections::BTreeMap<String, String>,
}
