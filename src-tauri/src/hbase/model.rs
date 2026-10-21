use super::native;
use super::rest_session::RestSession;
use super::thrift;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub ssl: bool,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Optional path prefix before the HBase REST routes, e.g. a gateway path.
    #[serde(default)]
    pub rest_path: Option<String>,
    /// Optional namespace automatically prefixed to unqualified table names.
    #[serde(default)]
    pub namespace: Option<String>,
    /// Transport to use: `"native"` (RegionServer/Master RPC via ZooKeeper) or
    /// `"rest"` (HBase REST/Stargate gateway). Defaults to native.
    #[serde(default)]
    pub connection_mode: Option<String>,
    /// Comma-separated ZooKeeper quorum (`host:port,...`) for native mode. When
    /// omitted, falls back to `host:port` (treating `port` as the ZK port).
    #[serde(default)]
    pub zk_quorum: Option<String>,
    /// ZooKeeper root znode for native mode (default `/hbase`).
    #[serde(default)]
    pub zk_root: Option<String>,
    /// Effective user for native simple auth (default `root`).
    #[serde(default)]
    pub effective_user: Option<String>,
    /// Authentication method for native mode: "simple" (default) or "kerberos".
    #[serde(default)]
    pub auth_method: Option<String>,
    /// Service principal for Kerberos auth, e.g. "hbase/host@REALM".
    #[serde(default)]
    pub service_principal: Option<String>,
    /// Client principal for keytab-based Kerberos auth, e.g. "user@REALM".
    #[serde(default)]
    pub principal: Option<String>,
    /// Absolute path to a keytab file. When set together with `principal`,
    /// Taomni runs `kinit -kt <keytab> <principal>` before connecting to
    /// refresh the system ticket cache automatically.
    #[serde(default)]
    pub keytab_path: Option<String>,
    /// Absolute path to a custom krb5.conf file.
    #[serde(default)]
    pub krb5_conf_path: Option<String>,
    #[serde(default)]
    pub hbase_site_path: Option<String>,
}

/// Selected HBase transport backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HBaseMode {
    /// RegionServer/Master RPC via ZooKeeper (default).
    Native,
    /// HBase REST/Stargate gateway.
    Rest,
    /// Thrift2-over-HTTP (Aliyun Lindorm / HBase 增强版, port 9190).
    Thrift,
}

impl HBaseConfig {
    /// Classify the configured transport. Native is the default; only an
    /// explicit `"rest"` or `"thrift"` selects another backend.
    pub(super) fn mode(&self) -> HBaseMode {
        match self.connection_mode.as_deref().map(str::trim) {
            Some("rest") | Some("REST") => HBaseMode::Rest,
            Some("thrift") | Some("Thrift") | Some("THRIFT") => HBaseMode::Thrift,
            _ => HBaseMode::Native,
        }
    }
}

pub struct HBaseSession {
    pub inner: HBaseSessionInner,
    pub cancel: tokio::sync::Mutex<tokio_util::sync::CancellationToken>,
}

pub enum HBaseSessionInner {
    Native(native::client::NativeClient),
    Rest(RestSession),
    Thrift(thrift::ThriftSession),
}

#[derive(Debug, Serialize)]
pub struct HBaseConnectResult {
    pub ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseTableInfo {
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseColumnFamily {
    pub name: String,
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseTableSchema {
    pub name: String,
    pub column_families: Vec<HBaseColumnFamily>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseShellResult {
    pub command: String,
    pub message: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub warnings: Vec<String>,
    pub duration_ms: u64,
}
