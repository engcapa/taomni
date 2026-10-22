use super::model::ClientError;
use super::model::NativeConfig;
use crate::hbase::native::proto::pb;
use crate::hbase::native::region::RegionLocation;
use crate::hbase::native::rpc::codec::CLIENT_SERVICE;
use crate::hbase::native::rpc::codec::MASTER_SERVICE;
use crate::hbase::native::rpc::conn::RpcConnection;
use crate::hbase::native::zk;
use crate::hbase::native::zk::ServerEndpoint;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// The native HBase client. Cheap to clone (shared connection pool + caches).
#[derive(Clone)]
pub struct NativeClient {
    pub(super) cfg: Arc<NativeConfig>,
    /// addr -> connection to a RegionServer (ClientService).
    pub(super) region_conns: Arc<RwLock<HashMap<String, RpcConnection>>>,
    /// Active master connection (MasterService), lazily established.
    pub(super) master_conn: Arc<RwLock<Option<RpcConnection>>>,
    /// Cached meta RegionServer connection.
    pub(super) meta_conn: Arc<RwLock<Option<RpcConnection>>>,
    /// table+row -> located region (simple cache, invalidated on NSRE).
    pub(super) region_cache: Arc<RwLock<HashMap<String, RegionLocation>>>,
}

impl NativeClient {
    pub fn new(cfg: NativeConfig) -> Self {
        Self {
            cfg: Arc::new(cfg),
            region_conns: Arc::new(RwLock::new(HashMap::new())),
            master_conn: Arc::new(RwLock::new(None)),
            meta_conn: Arc::new(RwLock::new(None)),
            region_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Ping the cluster: resolve the master via ZK and call GetClusterStatus.
    pub async fn ping(&self) -> Result<String, ClientError> {
        let master = self.master().await?;
        let req = pb::GetClusterStatusRequest::default();
        let (resp, _) = master
            .call_pb::<_, pb::GetClusterStatusResponse>("GetClusterStatus", &req, None)
            .await?;
        let version = resp
            .cluster_status
            .hbase_version
            .map(|v| v.version)
            .unwrap_or_else(|| "unknown".into());
        Ok(format!("HBase native RPC connection OK ({version})"))
    }

    // ---- connection helpers ------------------------------------------------

    pub(super) async fn region_connection(
        &self,
        ep: &ServerEndpoint,
    ) -> Result<RpcConnection, ClientError> {
        let addr = ep.addr();
        if let Some(conn) = self.region_conns.read().await.get(&addr).cloned() {
            return Ok(conn);
        }
        let conn = RpcConnection::connect_with_auth(
            &addr,
            CLIENT_SERVICE,
            &self.cfg.effective_user,
            &self.cfg.auth,
            self.cfg.timeout,
        )
        .await?;
        self.region_conns.write().await.insert(addr, conn.clone());
        Ok(conn)
    }

    pub(super) async fn master(&self) -> Result<RpcConnection, ClientError> {
        if let Some(conn) = self.master_conn.read().await.clone() {
            return Ok(conn);
        }
        let ep = zk::locate_master(&self.cfg.zk_quorum, &self.cfg.zk_root, self.cfg.timeout)
            .await
            .map_err(|e| ClientError::Zk(e.to_string()))?;
        let conn = RpcConnection::connect_with_auth(
            &ep.addr(),
            MASTER_SERVICE,
            &self.cfg.effective_user,
            &self.cfg.auth,
            self.cfg.timeout,
        )
        .await?;
        *self.master_conn.write().await = Some(conn.clone());
        Ok(conn)
    }

    pub(super) async fn meta_connection(&self) -> Result<RpcConnection, ClientError> {
        if let Some(conn) = self.meta_conn.read().await.clone() {
            return Ok(conn);
        }
        let ep = zk::locate_meta(&self.cfg.zk_quorum, &self.cfg.zk_root, self.cfg.timeout)
            .await
            .map_err(|e| ClientError::Zk(e.to_string()))?;
        let conn = RpcConnection::connect_with_auth(
            &ep.addr(),
            CLIENT_SERVICE,
            &self.cfg.effective_user,
            &self.cfg.auth,
            self.cfg.timeout,
        )
        .await?;
        *self.meta_conn.write().await = Some(conn.clone());
        Ok(conn)
    }

    pub(super) async fn drop_region_connection(&self, ep: &ServerEndpoint) {
        self.region_conns.write().await.remove(&ep.addr());
    }
}
