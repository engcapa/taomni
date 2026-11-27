#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::{
    io,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::de::DeserializeOwned;
use serde_json::Value;
use taomni_local_voice_api::{COMMANDS, Mode, ModelSelection, PREPARE, START, Start};
use taomni_local_voice_engine::AsrManager;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler};

mod audio;

fn main() -> io::Result<()> {
    let config = HostConfig {
        plugin_id: "taomni-plugin-ai-voice-local".into(),
        plugin_version: env!("CARGO_PKG_VERSION").into(),
        commands: COMMANDS.map(str::to_owned).into_iter().collect(),
        permissions: Default::default(),
        required_services: Default::default(),
        optional_services: Default::default(),
        operation_timeout: Duration::from_secs(28),
        snapshot_timeout: Duration::from_secs(10),
    };
    taomni_plugin_sdk::serve_stdio_with(config, |storage| {
        storage.ok_or_else(|| io::Error::other("Local Voice profile ownership required"))?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        Ok(Arc::new(Host {
            runtime,
            model: Mutex::new(None),
            active: Arc::new(tokio::sync::Mutex::new(())),
        }))
    })
}

struct Host {
    runtime: tokio::runtime::Runtime,
    model: Mutex<Option<(ModelSelection, Arc<AsrManager>)>>,
    active: Arc<tokio::sync::Mutex<()>>,
}

impl Host {
    fn manager(&self, selection: &ModelSelection) -> Result<Arc<AsrManager>, RpcError> {
        if !selection.models_root.is_absolute() || !valid_language(&selection.language) {
            return Err(RpcError::from_code(ErrorCode::InvalidParams));
        }
        taomni_asr_models::model(&selection.model_id).map_err(failed)?;
        let mut cache = self
            .model
            .lock()
            .map_err(|_| failed("Local Voice model lock failed"))?;
        if let Some((previous, manager)) = cache.as_ref()
            && previous == selection
        {
            return Ok(manager.clone());
        }
        let manager = Arc::new(AsrManager::configured(
            selection.models_root.clone(),
            &selection.model_id,
            &selection.language,
        ));
        *cache = Some((selection.clone(), manager.clone()));
        Ok(manager)
    }
}

impl PluginHandler for Host {
    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        operation.check_current()?;
        match method {
            PREPARE => self
                .runtime
                .block_on(self.manager(&decode(params)?)?.prepare())
                .map_err(failed)?,
            START => {
                let request: Start = decode(params)?;
                if let Mode::Zipformer {
                    directory,
                    language,
                } = &request.mode
                    && (!directory.is_absolute() || !valid_language(language))
                {
                    return Err(RpcError::from_code(ErrorCode::InvalidParams));
                }
                let lease = self
                    .active
                    .clone()
                    .try_lock_owned()
                    .map_err(|_| failed("Local Voice input is busy"))?;
                let manager = self.manager(&request.selection)?;
                let (stream, _) = self
                    .runtime
                    .block_on(request.channel.connect())
                    .map_err(|_| failed("Could not connect to the Local Voice audio channel"))?;
                operation.check_current()?;
                self.runtime.spawn(async move {
                    let _lease = lease;
                    audio::run(stream, manager, request.selection.models_root, request.mode).await;
                });
            }
            _ => return Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        }
        operation.check_current()?;
        Ok(Value::Null)
    }
}

fn valid_language(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn decode<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))
}

fn failed(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::InternalError, message)
}
