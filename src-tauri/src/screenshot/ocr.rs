//! Desktop command surface for OCR and automatic redaction.

use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Serialize, de::DeserializeOwned};
use taomni_plugin_stream::routed_tcp::Route;
use taomni_screenshot_api::{
    CLASSIFY_TSV, MAX_IMAGE_BYTES, OcrAvailability, OcrInput, PROBE_OCR, SLUG,
};
use tauri::State;

pub use taomni_screenshot_api::{OcrResult, RedactResult};
pub use taomni_screenshot_ocr::{find_sensitive, ocr_image};

use crate::{
    plugin::{LifecycleState, PluginRegistry},
    state::AppState,
};

pub(super) const MODULE_UNAVAILABLE: &str =
    "OCR_MODULE_UNAVAILABLE: Enable the Screenshot OCR module in Settings → Module Store.";

pub(super) fn use_host(registry: &PluginRegistry, method: &str) -> Result<bool, String> {
    let Some(record) = registry.get(SLUG) else {
        return Ok(false);
    };
    if record.state == LifecycleState::Enabled && record.manifest.commands.contains(method) {
        Ok(true)
    } else {
        Err(MODULE_UNAVAILABLE.into())
    }
}

pub(super) async fn probe(registry: Arc<PluginRegistry>) -> Result<OcrAvailability, String> {
    if use_host(&registry, PROBE_OCR)? {
        return invoke(registry, PROBE_OCR, ()).await;
    }
    tokio::task::spawn_blocking(|| {
        let engine = taomni_screenshot_ocr::engine_name();
        OcrAvailability {
            engine: engine.map(str::to_owned),
            hint: engine
                .is_none()
                .then(|| taomni_screenshot_ocr::install_hint().to_owned()),
        }
    })
    .await
    .map_err(|error| format!("OCR probe task failed: {error}"))
}

/// A one-use authenticated route grants only the already validated artifact.
pub(super) async fn process_image<T: DeserializeOwned>(
    registry: Arc<PluginRegistry>,
    method: &'static str,
    path: String,
) -> Result<T, String> {
    let path = tokio::task::spawn_blocking(move || super::capture::ensure_artifact_path(&path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(super::runtime::internal_error)?;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| error.to_string())?;
    let size = file
        .metadata()
        .await
        .map_err(|error| error.to_string())?
        .len();
    if size == 0 || size > MAX_IMAGE_BYTES {
        return Err("Unsupported OCR image size".into());
    }
    let mut file = Some(file);
    let (_route, source) = Route::bind(move || {
        std::future::ready(
            file.take()
                .map(|file| {
                    (
                        tokio::io::join(file, tokio::io::sink()),
                        SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                    )
                })
                .ok_or_else(|| "OCR image was already read".into()),
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    invoke(
        registry,
        method,
        OcrInput {
            source,
            length: size,
        },
    )
    .await
}

#[tauri::command]
pub async fn screenshot_redact_tsv(
    tsv: String,
    state: State<'_, AppState>,
) -> Result<RedactResult, String> {
    if use_host(&state.plugins, CLASSIFY_TSV)? {
        return invoke(state.plugins.clone(), CLASSIFY_TSV, tsv).await;
    }
    tokio::task::spawn_blocking(move || taomni_screenshot_ocr::redact_tsv(&tsv))
        .await
        .map_err(|error| format!("OCR classification task failed: {error}"))?
}

async fn invoke<T: DeserializeOwned>(
    registry: Arc<PluginRegistry>,
    method: &'static str,
    payload: impl Serialize + Send + 'static,
) -> Result<T, String> {
    let call = PendingCall {
        registry: registry.clone(),
        id: uuid::Uuid::new_v4().to_string(),
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    let id = call.id.clone();
    let cancelled = call.cancelled.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let value = serde_json::to_value(payload).map_err(|error| error.to_string())?;
        registry
            .invoke_cancellable(SLUG, method, value, &id, || {
                cancelled.load(Ordering::Acquire)
            })
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("OCR task failed: {error}"))??;
    serde_json::from_value(outcome).map_err(|_| "Invalid OCR module response".into())
}

struct PendingCall {
    registry: Arc<PluginRegistry>,
    id: String,
    cancelled: Arc<AtomicBool>,
}

impl Drop for PendingCall {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        self.registry.cancel_request(SLUG, &self.id);
    }
}
