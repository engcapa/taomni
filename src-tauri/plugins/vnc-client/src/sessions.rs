use std::{collections::HashMap, future::Future, io, sync::Mutex, time::Duration};

use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_vnc_engine::ws::{VncSession, native_pointer_sampler, probe_connection, spawn_relay};
use tokio::runtime::{Builder, Runtime};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::request::{Start, Started};

const SESSION_LIMIT: usize = 32;

pub(crate) struct Sessions {
    // Drop session handles before dropping the runtime. Their cancellation
    // closes the socket and releases the blocking RFB reader.
    active: Mutex<HashMap<Uuid, VncSession>>,
    runtime: Runtime,
    desktop_pid: u32,
}

impl Sessions {
    pub(crate) fn new() -> io::Result<Self> {
        Ok(Self {
            active: Mutex::new(HashMap::new()),
            runtime: Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
            desktop_pid: std::env::var("TAOMNI_VNC_DESKTOP_PID")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or_default(),
        })
    }

    pub(crate) fn start(
        &self,
        input: Start,
        check: &dyn Fn() -> Result<(), RpcError>,
    ) -> Result<Result<Started, String>, RpcError> {
        let (request, dial) = input.checked()?;
        check()?;
        let mut active = self.active.lock().map_err(|_| lock_failed())?;
        active.retain(|_, session| !session.cancel.is_cancelled());
        if active.len() >= SESSION_LIMIT {
            return Err(RpcError::new(ErrorCode::InvalidState, "VNC_SESSION_LIMIT"));
        }
        let pointer = native_pointer_sampler(self.desktop_pid);
        let session = match self.run(check, |attempt| {
            spawn_relay(request, dial.connect(), pointer, attempt)
        })? {
            Ok(session) => session,
            Err(error) => return Ok(Err(error)),
        };
        let id = Uuid::new_v4();
        let started = Started {
            session_id: id.to_string(),
            ws_port: session.ws_port,
            ws_token: session.ws_token.clone(),
        };
        active.insert(id, session);
        Ok(Ok(started))
    }

    pub(crate) fn close(&self, id: &str) -> Result<bool, RpcError> {
        let id = Uuid::parse_str(id).map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
        let mut active = self.active.lock().map_err(|_| lock_failed())?;
        Ok(active.remove(&id).is_some())
    }

    pub(crate) fn probe(
        &self,
        input: Start,
        check: &dyn Fn() -> Result<(), RpcError>,
    ) -> Result<Result<String, String>, RpcError> {
        let (request, dial) = input.checked()?;
        self.run(check, |attempt| {
            probe_connection(request.into(), dial.connect(), attempt)
        })
    }

    fn run<T, F>(
        &self,
        check: &dyn Fn() -> Result<(), RpcError>,
        operation: impl FnOnce(CancellationToken) -> F,
    ) -> Result<Result<T, String>, RpcError>
    where
        F: Future<Output = Result<T, String>>,
    {
        check()?;
        let attempt = CancellationToken::new();
        let result = self.runtime.block_on(async {
            let pending = operation(attempt.clone());
            tokio::pin!(pending);
            let mut tick = tokio::time::interval(Duration::from_millis(20));
            loop {
                tokio::select! {
                    result = &mut pending => break Ok(result),
                    _ = tick.tick() => {
                        if let Err(error) = check() {
                            attempt.cancel();
                            let _ = pending.await;
                            break Err(error);
                        }
                    }
                }
            }
        })?;
        check()?;
        Ok(result)
    }
}

fn lock_failed() -> RpcError {
    RpcError::new(ErrorCode::InternalError, "VNC_SESSION_TABLE_UNAVAILABLE")
}
