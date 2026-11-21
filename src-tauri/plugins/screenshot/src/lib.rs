//! OCR, redaction and recording in the official screenshot module process.

use std::{io, sync::Arc, time::Duration};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler};
use taomni_screenshot_api::{
    CLASSIFY_TSV, COMMANDS, MAX_IMAGE_BYTES, OcrAvailability, OcrInput, PROBE_OCR, RECOGNIZE,
    REDACT, RedactResult, START_RECORDING,
};
use taomni_screenshot_ocr::{engine_name, find_sensitive, install_hint, ocr_image, redact_tsv};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod recording;

pub fn serve_stdio() -> io::Result<()> {
    let config = HostConfig {
        plugin_id: "taomni-plugin-screenshot".into(),
        plugin_version: env!("CARGO_PKG_VERSION").into(),
        commands: COMMANDS.map(str::to_owned).into_iter().collect(),
        permissions: Default::default(),
        required_services: Default::default(),
        optional_services: Default::default(),
        operation_timeout: Duration::from_secs(65),
        snapshot_timeout: Duration::from_secs(30),
    };
    taomni_plugin_sdk::serve_stdio_with(config, |storage| {
        storage.ok_or_else(|| io::Error::other("Screenshot profile ownership required"))?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        Ok(Arc::new(Host {
            runtime,
            recording: recording::Recorder::default(),
        }))
    })
}

struct Host {
    runtime: tokio::runtime::Runtime,
    recording: recording::Recorder,
}

impl PluginHandler for Host {
    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        operation.check_current()?;
        let value = match method {
            PROBE_OCR => {
                let engine = engine_name();
                result(OcrAvailability {
                    engine: engine.map(str::to_owned),
                    hint: engine.is_none().then(|| install_hint().to_owned()),
                })
            }
            CLASSIFY_TSV => {
                let tsv: String = decode(params)?;
                result(redact_tsv(&tsv).map_err(failed)?)
            }
            START_RECORDING => {
                self.recording.start(&self.runtime, decode(params)?)?;
                Ok(Value::Null)
            }
            RECOGNIZE | REDACT => {
                let input = decode(params)?;
                let file = self.read_image(operation, input)?;
                operation.check_current()?;
                let path = file
                    .path()
                    .to_str()
                    .ok_or_else(|| failed("Invalid OCR image path".into()))?;
                let recognized = ocr_image(path).map_err(failed)?;
                if method == REDACT {
                    let boxes = find_sensitive(&recognized.words);
                    result(RedactResult {
                        count: boxes.len(),
                        boxes,
                    })
                } else {
                    result(recognized)
                }
            }
            _ => Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        }?;
        operation.check_current()?;
        Ok(value)
    }
}

impl Host {
    fn read_image(
        &self,
        operation: &Operation,
        input: OcrInput,
    ) -> Result<tempfile::NamedTempFile, RpcError> {
        if input.length == 0 || input.length > MAX_IMAGE_BYTES {
            return Err(RpcError::from_code(ErrorCode::InvalidParams));
        }
        let file = tempfile::Builder::new()
            .prefix("taomni-ocr-")
            .suffix(".png")
            .tempfile()
            .map_err(|error| failed(format!("Prepare OCR image: {error}")))?;
        let output = file
            .reopen()
            .map_err(|error| failed(format!("Open OCR image: {error}")))?;
        self.runtime.block_on(async {
            let mut output = tokio::fs::File::from_std(output);
            let transfer = async {
                let (stream, _) = input.source.connect().await.map_err(failed)?;
                let mut bounded = stream.take(input.length + 1);
                let written = tokio::io::copy(&mut bounded, &mut output)
                    .await
                    .map_err(|error| failed(format!("Read OCR image: {error}")))?;
                if written != input.length {
                    return Err(failed("Incomplete OCR image".into()));
                }
                output
                    .flush()
                    .await
                    .map_err(|error| failed(format!("Save OCR image: {error}")))
            };
            let cancellation = async {
                let mut poll = tokio::time::interval(Duration::from_millis(25));
                loop {
                    poll.tick().await;
                    operation.check_current()?;
                }
            };
            tokio::select! {
                biased;
                cancelled = cancellation => cancelled,
                received = transfer => received,
            }
        })?;
        Ok(file)
    }
}

fn decode<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or_default())
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))
}

fn result(value: impl Serialize) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(|_| RpcError::from_code(ErrorCode::InternalError))
}

fn failed(error: String) -> RpcError {
    RpcError::new(ErrorCode::InternalError, error)
}
