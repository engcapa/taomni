use std::{collections::HashMap, io, sync::Mutex, time::Duration};

use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_vnc_engine::ws::{VncSession, spawn_relay};
use tokio::runtime::{Builder, Runtime};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::request::{Start, Started, connection_error};

const SESSION_LIMIT: usize = 32;

pub(crate) struct Sessions {
    // Drop session handles before dropping the runtime. Their cancellation
    // closes the socket and releases the blocking RFB reader.
    active: Mutex<HashMap<Uuid, VncSession>>,
    runtime: Runtime,
}

impl Sessions {
    pub(crate) fn new() -> io::Result<Self> {
        Ok(Self {
            active: Mutex::new(HashMap::new()),
            runtime: Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
        })
    }

    pub(crate) fn start(
        &self,
        input: Start,
        check: &dyn Fn() -> Result<(), RpcError>,
    ) -> Result<Started, RpcError> {
        let (request, dial) = input.checked()?;
        check()?;
        let mut active = self.active.lock().map_err(|_| lock_failed())?;
        active.retain(|_, session| !session.cancel.is_cancelled());
        if active.len() >= SESSION_LIMIT {
            return Err(RpcError::new(ErrorCode::InvalidState, "VNC_SESSION_LIMIT"));
        }
        let attempt = CancellationToken::new();
        let session = self.runtime.block_on(async {
            let connect = spawn_relay(request, dial.connect(), None, attempt.clone());
            tokio::pin!(connect);
            let mut tick = tokio::time::interval(Duration::from_millis(20));
            loop {
                tokio::select! {
                    result = &mut connect => break result.map_err(connection_error),
                    _ = tick.tick() => {
                        if let Err(error) = check() {
                            attempt.cancel();
                            let _ = connect.await;
                            break Err(error);
                        }
                    }
                }
            }
        })?;
        check()?;
        let id = Uuid::new_v4();
        let started = Started {
            session_id: id.to_string(),
            ws_port: session.ws_port,
            ws_token: session.ws_token.clone(),
        };
        active.insert(id, session);
        Ok(started)
    }

    pub(crate) fn close(&self, id: &str) -> Result<bool, RpcError> {
        let id = Uuid::parse_str(id).map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
        let mut active = self.active.lock().map_err(|_| lock_failed())?;
        Ok(active.remove(&id).is_some())
    }
}

fn lock_failed() -> RpcError {
    RpcError::new(ErrorCode::InternalError, "VNC_SESSION_TABLE_UNAVAILABLE")
}
