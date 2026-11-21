use std::{
    collections::VecDeque,
    io,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use taomni_plugin_api::{
    ErrorCode, RpcError,
    services::{SNAPSHOT_METHOD, SNAPSHOT_PREPARE_METHOD, SNAPSHOT_RELEASE_METHOD},
};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler, SnapshotExport, SnapshotProvider};
use taomni_server_process::{Started, vnc};
use tokio_util::sync::CancellationToken;

mod daemon;

pub fn serve() -> io::Result<()> {
    let config = HostConfig {
        plugin_id: "taomni-plugin-vnc-server".into(),
        plugin_version: env!("CARGO_PKG_VERSION").into(),
        commands: vnc::COMMANDS
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
    };
    taomni_plugin_sdk::serve_stdio_with(config, |storage| {
        let storage =
            storage.ok_or_else(|| io::Error::other("VNC server profile ownership required"))?;
        Ok(Arc::new(Host {
            active: Mutex::new(None),
            settings: Arc::new(HostSettings(vnc::SettingsFile::new(storage.root().path()))),
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
        }))
    })
}

struct Host {
    active: Mutex<Option<Daemon>>,
    settings: Arc<HostSettings>,
    runtime: tokio::runtime::Runtime,
}

struct HostSettings(vnc::SettingsFile);

impl SnapshotProvider for HostSettings {
    fn freeze(&self, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()
    }

    fn export(
        &self,
        destination: &mut SnapshotExport,
        operation: &Operation,
    ) -> Result<(), RpcError> {
        operation.check_current()?;
        if let Some(settings) = self.0.open().map_err(storage_error)? {
            destination.file(vnc::CONFIG_FILENAME, settings)?;
        }
        Ok(())
    }

    fn resume(&self) {}
}

struct Daemon {
    id: String,
    cancel: CancellationToken,
    started: Started,
    logs: Arc<Mutex<VecDeque<String>>>,
}

impl PluginHandler for Host {
    fn snapshot_provider(&self) -> Option<Arc<dyn SnapshotProvider>> {
        Some(self.settings.clone())
    }

    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        operation.check_current()?;
        if method == vnc::SAVE_SETTINGS {
            let settings = decode(params)?;
            let legacy_source = self
                .settings
                .0
                .load()
                .map_err(storage_error)?
                .and_then(|record| record.legacy_source);
            operation.check_current()?;
            self.settings
                .0
                .save(&vnc::StoredSettings {
                    settings,
                    legacy_source,
                })
                .map_err(storage_error)?;
            return Ok(Value::Null);
        }
        let mut active = self
            .active
            .lock()
            .map_err(|_| failed("VNC server state unavailable"))?;
        match method {
            vnc::START => self
                .start(&mut active, operation, decode(params)?)
                .and_then(encode),
            vnc::STATUS | vnc::STOP => {
                let id: String = decode(params)?;
                let Some(daemon) = active.as_mut().filter(|daemon| daemon.id == id) else {
                    return encode(vnc::Status::default());
                };
                if method == vnc::STOP {
                    daemon.cancel.cancel();
                    if !daemon.started.task.is_finished() {
                        self.runtime
                            .block_on(async {
                                tokio::time::timeout(
                                    Duration::from_secs(8),
                                    &mut daemon.started.task,
                                )
                                .await
                            })
                            .map_err(|_| failed("VNC daemon did not stop"))?
                            .map_err(|error| failed(error.to_string()))?;
                    }
                }
                let running = !daemon.started.task.is_finished();
                let logs = daemon
                    .logs
                    .lock()
                    .map_err(|_| failed("VNC server logs unavailable"))?
                    .drain(..)
                    .collect();
                if !running {
                    *active = None;
                }
                encode(vnc::Status { running, logs })
            }
            _ => Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        }
    }
}

impl Host {
    fn start(
        &self,
        active: &mut Option<Daemon>,
        operation: &Operation,
        config: vnc::Config,
    ) -> Result<vnc::Session, RpcError> {
        if active
            .as_ref()
            .is_some_and(|daemon| !daemon.started.task.is_finished())
        {
            return Err(failed("VNC server is already running"));
        }
        let cancel = CancellationToken::new();
        let logs = Arc::new(Mutex::new(VecDeque::new()));
        let output = logs.clone();
        let started = self
            .runtime
            .block_on(daemon::start(
                config,
                cancel.clone(),
                Arc::new(move |line| {
                    if let Ok(mut messages) = output.lock() {
                        if messages.len() == 128 {
                            messages.pop_front();
                        }
                        messages.push_back(line.chars().take(2048).collect());
                    }
                }),
            ))
            .map_err(failed)?;
        if let Err(error) = operation.check_current() {
            cancel.cancel();
            started.task.abort();
            return Err(error);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let session = vnc::Session {
            id: id.clone(),
            pid: started.pid,
        };
        *active = Some(Daemon {
            id,
            cancel,
            started,
            logs,
        });
        Ok(session)
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        if let Some(daemon) = self.active.get_mut().ok().and_then(Option::take) {
            daemon.cancel.cancel();
            daemon.started.task.abort();
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

fn storage_error(error: io::Error) -> RpcError {
    failed(format!("VNC Server settings: {error}"))
}
