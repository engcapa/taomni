use std::{
    collections::{HashMap, VecDeque},
    io,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use taomni_local_servers_engine as engine;
use taomni_plugin_api::{
    ErrorCode, RpcError,
    services::{SNAPSHOT_METHOD, SNAPSHOT_PREPARE_METHOD, SNAPSHOT_RELEASE_METHOD},
};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler, SnapshotProvider};
use taomni_server_process::local::{self, Kind};
use tokio_util::sync::CancellationToken;

mod identity;

type Logs = Arc<Mutex<VecDeque<String>>>;

pub fn serve() -> io::Result<()> {
    taomni_plugin_sdk::serve_stdio_with(
        HostConfig {
            plugin_id: "taomni-plugin-servers".into(),
            plugin_version: env!("CARGO_PKG_VERSION").into(),
            commands: local::COMMANDS
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
                .ok_or_else(|| io::Error::other("Local servers requires profile ownership"))?;
            Ok(Arc::new(Host {
                running: Mutex::new(HashMap::new()),
                identity: Arc::new(identity::Identity::new(storage.root().path())),
                runtime: tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()?,
            }))
        },
    )
}

struct Host {
    running: Mutex<HashMap<Kind, Running>>,
    identity: Arc<identity::Identity>,
    runtime: tokio::runtime::Runtime,
}

struct Running {
    id: String,
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
    logs: Logs,
}

impl PluginHandler for Host {
    fn snapshot_provider(&self) -> Option<Arc<dyn SnapshotProvider>> {
        Some(self.identity.clone())
    }

    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        operation.check_current()?;
        let mut running = self
            .running
            .lock()
            .map_err(|_| failed("Local server status is unavailable"))?;
        match method {
            local::START => {
                let request: local::StartRequest = decode(params)?;
                if running
                    .get(&request.kind)
                    .is_some_and(|active| !active.task.is_finished())
                {
                    return Err(failed("This local server is already running"));
                }
                let logs = Logs::default();
                let outcome = self.start(operation, &mut running, request, &logs)?;
                encode(local::StartResponse {
                    outcome,
                    logs: take_logs(&logs)?,
                })
            }
            local::STATUS | local::STOP => {
                let session: local::Session = decode(params)?;
                let Some(active) = running
                    .get_mut(&session.kind)
                    .filter(|active| active.id == session.id)
                else {
                    return encode(local::Status::default());
                };
                if method == local::STOP && !active.task.is_finished() {
                    active.cancel.cancel();
                    self.runtime
                        .block_on(async {
                            tokio::time::timeout(Duration::from_secs(8), &mut active.task).await
                        })
                        .map_err(|_| failed("Local server did not stop"))?
                        .map_err(|error| failed(error.to_string()))?;
                }
                let status = local::Status {
                    running: !active.task.is_finished(),
                    logs: take_logs(&active.logs)?,
                };
                if !status.running {
                    running.remove(&session.kind);
                }
                encode(status)
            }
            _ => Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        }
    }
}

impl Host {
    fn start(
        &self,
        operation: &Operation,
        running: &mut HashMap<Kind, Running>,
        request: local::StartRequest,
        logs: &Logs,
    ) -> Result<Result<local::Session, String>, RpcError> {
        let cancel = CancellationToken::new();
        let output = logs.clone();
        let ctx = engine::ServerCtx::new(cancel.clone(), move |line| {
            if let Ok(mut queue) = output.lock() {
                if queue.len() == 128 {
                    queue.pop_front();
                }
                queue.push_back(line.chars().take(2048).collect());
            }
        });
        let config = request.config;
        let started = self.runtime.block_on(async {
            match request.kind {
                Kind::Ssh => {
                    let directory = self.identity.directory()?;
                    engine::ssh::start(ctx, config, &directory).await
                }
                Kind::Ftp => engine::ftp::start(ctx, config).await,
                Kind::Tftp => engine::tftp::start(ctx, config).await,
                Kind::Http => engine::http::start(ctx, config).await,
                Kind::Telnet => engine::telnet::start(ctx, config).await,
                Kind::Nfs => engine::nfs::start(ctx, config).await,
                Kind::Cron => engine::cron::start(ctx, config).await,
                Kind::Iperf => engine::iperf::start(ctx, config).await,
            }
        });
        let started = match started {
            Ok(started) => started,
            Err(error) => return Ok(Err(error)),
        };
        if let Err(error) = operation.check_current() {
            cancel.cancel();
            return Err(error);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let pid = started.pid.unwrap_or_else(std::process::id);
        let session = local::Session {
            kind: request.kind,
            id: id.clone(),
            pid,
        };
        running.insert(
            request.kind,
            Running {
                id,
                cancel,
                task: started.task,
                logs: logs.clone(),
            },
        );
        Ok(Ok(session))
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        if let Ok(running) = self.running.get_mut() {
            for active in running.values() {
                active.cancel.cancel();
            }
        }
    }
}

fn take_logs(logs: &Logs) -> Result<Vec<String>, RpcError> {
    Ok(logs
        .lock()
        .map_err(|_| failed("Local server logs are unavailable"))?
        .drain(..)
        .collect())
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
