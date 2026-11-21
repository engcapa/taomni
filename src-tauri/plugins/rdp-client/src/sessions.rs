use std::{
    collections::HashMap,
    future::Future,
    io,
    sync::{Arc, Mutex},
    time::Duration,
};

use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_rdp_client_api::{Connection, ConnectionTestResult, Started};
use taomni_rdp_client_engine::{
    session::{RdpSessionConfig, test_ironrdp_connection},
    transport::{RdpConnector, RdpTransport},
    ws::{RdpSession, RdpSpawnConfig, spawn_rdp_relay},
};
use tokio::{
    runtime::{Builder, Runtime},
    sync::{OwnedSemaphorePermit, Semaphore},
};
use uuid::Uuid;

const SESSION_LIMIT: usize = 32;
const AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(45);

struct ActiveSession {
    _session: RdpSession,
    _slot: OwnedSemaphorePermit,
}

pub(super) struct Sessions {
    active: Arc<Mutex<HashMap<Uuid, ActiveSession>>>,
    slots: Arc<Semaphore>,
    runtime: Runtime,
}

impl Sessions {
    pub(super) fn new() -> io::Result<Self> {
        Ok(Self {
            active: Arc::new(Mutex::new(HashMap::new())),
            slots: Arc::new(Semaphore::new(SESSION_LIMIT)),
            runtime: Builder::new_multi_thread()
                .worker_threads(4)
                .enable_all()
                .build()?,
        })
    }

    pub(super) fn start(
        &self,
        input: Connection,
        current: &dyn Fn() -> Result<(), RpcError>,
    ) -> Result<Result<Started, String>, RpcError> {
        super::validate_endpoint(&input)?;
        let config = spawn_config(input);
        let slot = self.slot()?;
        let session = match self.run(current, spawn_rdp_relay(config))? {
            Ok(session) => session,
            Err(error) => return Ok(Err(error)),
        };
        let id = Uuid::new_v4();
        let started = Started {
            session_id: id.to_string(),
            ws_port: session.ws_port,
            ws_token: session.ws_token.clone(),
        };
        let stopped = session.cancel.clone();
        self.active.lock().map_err(|_| lock_failed())?.insert(
            id,
            ActiveSession {
                _session: session,
                _slot: slot,
            },
        );
        let active = Arc::downgrade(&self.active);
        self.runtime.spawn(async move {
            stopped.cancelled().await;
            if let Some(active) = active.upgrade()
                && let Ok(mut sessions) = active.lock()
            {
                sessions.remove(&id);
            }
        });
        Ok(Ok(started))
    }

    pub(super) fn test(
        &self,
        input: Connection,
        current: &dyn Fn() -> Result<(), RpcError>,
    ) -> Result<Result<ConnectionTestResult, String>, RpcError> {
        super::validate_endpoint(&input)?;
        let config = spawn_config(input);
        let _slot = self.slot()?;
        self.run(current, async move {
            let transport = (config.connect)().await?;
            test_ironrdp_connection(
                RdpSessionConfig {
                    transport,
                    host: config.host,
                    port: config.port,
                    username: config.username,
                    password: config.password,
                    options: config.options,
                    reconnect: config.connect,
                },
                AUTHENTICATION_TIMEOUT,
            )
            .await
        })
    }

    pub(super) fn close(&self, id: &str) -> Result<bool, RpcError> {
        let id = Uuid::parse_str(id).map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
        let mut active = self.active.lock().map_err(|_| lock_failed())?;
        Ok(active.remove(&id).is_some())
    }

    fn slot(&self) -> Result<OwnedSemaphorePermit, RpcError> {
        self.slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| RpcError::new(ErrorCode::InvalidState, "RDP_SESSION_LIMIT"))
    }

    fn run<T>(
        &self,
        current: &dyn Fn() -> Result<(), RpcError>,
        task: impl Future<Output = Result<T, String>>,
    ) -> Result<Result<T, String>, RpcError> {
        current()?;
        let result = self.runtime.block_on(async {
            tokio::pin!(task);
            let mut tick = tokio::time::interval(Duration::from_millis(20));
            loop {
                tokio::select! {
                    result = &mut task => return Ok(result),
                    _ = tick.tick() => current()?,
                }
            }
        })?;
        current()?;
        Ok(result)
    }
}

fn spawn_config(input: Connection) -> RdpSpawnConfig {
    let connect: RdpConnector = Arc::new(move || {
        let route = input.route.clone();
        Box::pin(async move {
            let (stream, addr) = route.connect().await?;
            Ok(RdpTransport::new(stream, addr))
        })
    });
    RdpSpawnConfig {
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password.map(|password| password.to_string()),
        options: input.options,
        connect,
    }
}

fn lock_failed() -> RpcError {
    RpcError::new(ErrorCode::InternalError, "RDP_SESSION_TABLE_UNAVAILABLE")
}
