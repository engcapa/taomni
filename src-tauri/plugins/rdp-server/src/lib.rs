use std::{
    collections::VecDeque,
    io,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use taomni_capture::CaptureLogger;
use taomni_plugin_api::{
    ErrorCode, RpcError,
    services::{SNAPSHOT_METHOD, SNAPSHOT_PREPARE_METHOD, SNAPSHOT_RELEASE_METHOD},
};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler, SnapshotProvider};
use taomni_rdp_server_engine::ApprovalBroker;
use taomni_server_process::{ServerConfig, rdp};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

mod storage;

pub fn serve() -> io::Result<()> {
    taomni_plugin_sdk::serve_stdio_with(
        HostConfig {
            plugin_id: "taomni-plugin-rdp-server".into(),
            plugin_version: env!("CARGO_PKG_VERSION").into(),
            commands: rdp::COMMANDS
                .into_iter()
                .chain([
                    SNAPSHOT_PREPARE_METHOD,
                    SNAPSHOT_METHOD,
                    SNAPSHOT_RELEASE_METHOD,
                ])
                .map(str::to_owned)
                .collect(),
            permissions: ["fs.dataDir".to_owned()].into(),
            required_services: Default::default(),
            optional_services: Default::default(),
            operation_timeout: Duration::from_secs(15),
            snapshot_timeout: Duration::from_secs(15),
        },
        |storage| {
            let storage = storage
                .ok_or_else(|| io::Error::other("RDP Server profile ownership is required"))?;
            Ok(Arc::new(Host {
                active: Mutex::new(None),
                storage: Arc::new(storage::Identity::new(storage.root().path())),
                runtime: tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()?,
            }))
        },
    )
}

struct Host {
    active: Mutex<Option<Session>>,
    storage: Arc<storage::Identity>,
    runtime: tokio::runtime::Runtime,
}

struct Session {
    id: String,
    cancel: CancellationToken,
    task: JoinHandle<()>,
    approvals: Arc<ApprovalBroker>,
    messages: Arc<Mutex<Messages>>,
}

#[derive(Default)]
struct Messages {
    logs: VecDeque<String>,
    events: Vec<rdp::DesktopEvent>,
}

impl PluginHandler for Host {
    fn snapshot_provider(&self) -> Option<Arc<dyn SnapshotProvider>> {
        Some(self.storage.clone())
    }

    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        operation.check_current()?;
        let mut active = self
            .active
            .lock()
            .map_err(|_| failed("RDP Server session is unavailable"))?;
        match method {
            rdp::START => {
                if active
                    .as_ref()
                    .is_some_and(|session| !session.task.is_finished())
                {
                    return Err(failed("RDP Server is already running"));
                }
                let session = self.start(operation, decode(params)?)?;
                let reply = rdp::Session {
                    id: session.id.clone(),
                    pid: std::process::id(),
                };
                *active = Some(session);
                encode(reply)
            }
            rdp::STATUS | rdp::STOP => {
                let id: String = decode(params)?;
                let Some(session) = active.as_mut().filter(|session| session.id == id) else {
                    return encode(rdp::Status::default());
                };
                if method == rdp::STOP && !session.task.is_finished() {
                    session.cancel.cancel();
                    self.runtime
                        .block_on(async {
                            tokio::time::timeout(Duration::from_secs(8), &mut session.task).await
                        })
                        .map_err(|_| failed("RDP Server did not release its listener"))?
                        .map_err(|error| failed(error.to_string()))?;
                }
                let running = !session.task.is_finished();
                let messages = std::mem::take(
                    &mut *session
                        .messages
                        .lock()
                        .map_err(|_| failed("RDP Server messages are unavailable"))?,
                );
                if !running {
                    *active = None;
                }
                encode(rdp::Status {
                    running,
                    logs: messages.logs.into(),
                    events: messages.events,
                })
            }
            rdp::APPROVE => {
                let reply: rdp::Approval = decode(params)?;
                encode(active.as_ref().is_some_and(|session| {
                    session.approvals.resolve(&reply.request_id, reply.approved)
                }))
            }
            _ => Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        }
    }
}

impl Host {
    fn start(&self, operation: &Operation, config: ServerConfig) -> Result<Session, RpcError> {
        let directory = self.storage.prepare().map_err(storage::error)?;
        let cancel = CancellationToken::new();
        let messages = Arc::new(Mutex::new(Messages::default()));
        let logs = messages.clone();
        let log = CaptureLogger::new(move |line: String| {
            if let Ok(mut messages) = logs.lock() {
                if messages.logs.len() == 128 {
                    messages.logs.pop_front();
                }
                messages.logs.push_back(line.chars().take(2048).collect());
            }
        });
        let events = messages.clone();
        let approvals = Arc::new(ApprovalBroker::default());
        let task = self
            .runtime
            .block_on(taomni_rdp_server_engine::start(
                config,
                &directory,
                cancel.clone(),
                log,
                approvals.clone(),
                Arc::new(move |event| {
                    let Ok(mut messages) = events.lock() else {
                        return false;
                    };
                    if messages.events.len() == 128 {
                        return false;
                    }
                    messages.events.push(event);
                    true
                }),
            ))
            .map_err(failed)?;
        if let Err(error) = operation.check_current() {
            cancel.cancel();
            return Err(error);
        }
        Ok(Session {
            id: uuid::Uuid::new_v4().to_string(),
            cancel,
            task,
            approvals,
            messages,
        })
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        if let Some(session) = self.active.get_mut().ok().and_then(Option::take) {
            session.cancel.cancel();
        }
    }
}

fn decode<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or_default())
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))
}

fn encode(value: impl Serialize) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(|_| RpcError::from_code(ErrorCode::InternalError))
}

fn failed(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::InternalError, message.into())
}
