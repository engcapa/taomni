use std::{
    collections::HashMap,
    future::Future,
    io,
    sync::{Arc, Mutex},
    time::Duration,
};

use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_vnc_engine::ws::{
    NativeInput, VncSession, native_pointer_sampler, probe_connection, spawn_relay,
};
use tokio::runtime::{Builder, Runtime};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::request::{Start, Started};

const SESSION_LIMIT: usize = 32;

struct ActiveSession {
    _relay: VncSession,
    _slot: OwnedSemaphorePermit,
}

pub(crate) struct Sessions {
    // Drop session handles before dropping the runtime. Their cancellation
    // closes the socket and releases the blocking RFB reader.
    active: Arc<Mutex<HashMap<Uuid, ActiveSession>>>,
    slots: Arc<Semaphore>,
    runtime: Runtime,
    desktop_pid: u32,
    #[cfg(windows)]
    keyboard: Option<crate::keyboard::Keyboard>,
}

impl Sessions {
    pub(crate) fn new() -> io::Result<Self> {
        let desktop_pid = std::env::var("TAOMNI_VNC_DESKTOP_PID")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or_default();
        Ok(Self {
            active: Arc::new(Mutex::new(HashMap::new())),
            slots: Arc::new(Semaphore::new(SESSION_LIMIT)),
            runtime: Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
            desktop_pid,
            #[cfg(windows)]
            keyboard: crate::keyboard::Keyboard::new(desktop_pid)?,
        })
    }

    pub(crate) fn start(
        &self,
        input: Start,
        check: &dyn Fn() -> Result<(), RpcError>,
    ) -> Result<Result<Started, String>, RpcError> {
        let (request, dial) = crate::request::checked(input)?;
        check()?;
        let slot = Arc::clone(&self.slots)
            .try_acquire_owned()
            .map_err(|_| RpcError::new(ErrorCode::InvalidState, "VNC_SESSION_LIMIT"))?;
        let native = NativeInput {
            pointer: native_pointer_sampler(self.desktop_pid),
            #[cfg(windows)]
            special_keys: self.keyboard.as_ref().map(|keyboard| keyboard.claim()),
            #[cfg(not(windows))]
            special_keys: None,
        };
        let session = match self.run(check, |attempt| {
            spawn_relay(request, dial.connect(), native, attempt)
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
        let closed = session.cancel.clone();
        self.active.lock().map_err(|_| lock_failed())?.insert(
            id,
            ActiveSession {
                _relay: session,
                _slot: slot,
            },
        );
        let sessions = Arc::downgrade(&self.active);
        self.runtime.spawn(async move {
            closed.cancelled().await;
            if let Some(sessions) = sessions.upgrade()
                && let Ok(mut active) = sessions.lock()
            {
                active.remove(&id);
            }
        });
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
        let (request, dial) = crate::request::checked(input)?;
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
