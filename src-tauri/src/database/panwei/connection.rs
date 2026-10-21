use super::tls::PanWeiNativeTls;
use crate::database::DbConfig;
use crate::database::DbHandle;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio_opengauss::Client as OgClient;
use tokio_opengauss::Config as OgConfig;
use tokio_opengauss::Error as OgError;
use tokio_opengauss::NoTls;
use tokio_opengauss::config::SslMode;

pub(super) const DEFAULT_TIMEOUT_SECS: u64 = 15;

#[derive(Clone)]
pub struct PanWeiClient {
    pub(super) inner: Arc<PanWeiInner>,
}

pub(super) struct PanWeiInner {
    pub(super) client: AsyncMutex<OgClient>,
    pub(super) connection_task: JoinHandle<()>,
}

impl Drop for PanWeiInner {
    fn drop(&mut self) {
        self.connection_task.abort();
    }
}

impl PanWeiClient {
    pub(super) fn new(client: OgClient, connection_task: JoinHandle<()>) -> Self {
        Self {
            inner: Arc::new(PanWeiInner {
                client: AsyncMutex::new(client),
                connection_task,
            }),
        }
    }
}

pub(super) fn timeout(config: &DbConfig) -> Duration {
    Duration::from_secs(match config.timeout_secs {
        Some(s) if s > 0 => s,
        _ => DEFAULT_TIMEOUT_SECS,
    })
}

pub(super) fn build_connect_config(config: &DbConfig, password: Option<&str>) -> OgConfig {
    let mut opts = OgConfig::new();
    opts.host(&config.host)
        .port(config.port)
        .ssl_mode(if config.ssl {
            SslMode::Require
        } else {
            SslMode::Disable
        })
        .connect_timeout(timeout(config))
        .application_name("Taomni");
    if let Some(user) = config.username.as_deref().filter(|u| !u.is_empty()) {
        opts.user(user);
    }
    if let Some(pw) = password {
        opts.password(pw);
    }
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts.dbname(db);
    }
    opts
}

pub(super) fn spawn_connection_task<C>(connection: C) -> JoinHandle<()>
where
    C: Future<Output = Result<(), OgError>> + Send + 'static,
{
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            log::debug!("PanWeiDB connection task ended: {e}");
        }
    })
}

pub async fn connect(config: &DbConfig, password: Option<&str>) -> Result<DbHandle, String> {
    let opts = build_connect_config(config, password);

    if config.ssl {
        let tls = PanWeiNativeTls::new()
            .map_err(|e| format!("PanWeiDB TLS configuration failed: {e}"))?;
        let (client, connection) = tokio::time::timeout(timeout(config), opts.connect(tls))
            .await
            .map_err(|_| "PanWeiDB connect timed out".to_string())?
            .map_err(|e| format!("PanWeiDB TLS connect failed: {e}"))?;
        return Ok(DbHandle::PanWeiDB(PanWeiClient::new(
            client,
            spawn_connection_task(connection),
        )));
    }

    let (client, connection) = tokio::time::timeout(timeout(config), opts.connect(NoTls))
        .await
        .map_err(|_| "PanWeiDB connect timed out".to_string())?
        .map_err(|e| format!("PanWeiDB connect failed: {e}"))?;

    Ok(DbHandle::PanWeiDB(PanWeiClient::new(
        client,
        spawn_connection_task(connection),
    )))
}

pub async fn ping(client: &PanWeiClient) -> Result<String, String> {
    let guard = client.inner.client.lock().await;
    guard
        .execute("SELECT 1", &[])
        .await
        .map_err(|e| format!("PanWeiDB ping failed: {e}"))?;
    Ok("PanWeiDB connection OK".into())
}
