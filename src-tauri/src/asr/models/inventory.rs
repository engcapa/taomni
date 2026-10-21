use super::installation::INSTALL;
use super::installation::bundle_bytes;
use crate::asr::catalog;
use crate::asr::catalog::MODELS;
use futures::StreamExt;
use serde::Serialize;

#[derive(Serialize)]
pub struct ModelStatus {
    #[serde(flatten)]
    pub(super) model: catalog::Model,
    pub(super) installed: bool,
    pub(super) replacement: Option<&'static str>,
    pub(super) download_url: String,
    pub(super) resumable_bytes: u64,
    pub(super) license: &'static str,
    pub(super) catalog_version: &'static str,
    pub(super) available_version: &'static str,
    pub(super) installed_version: Option<String>,
    pub(super) update_available: bool,
    pub(super) integrity: &'static str,
}

pub(super) fn inventory(m: &catalog::Model, root: &std::path::Path, verify: bool) -> ModelStatus {
    let target = catalog::version_path(root, m);
    let exists = target.is_file();
    let mut installed = std::fs::metadata(&target)
        .map(|v| v.len() == m.bytes)
        .unwrap_or(false);
    if m.id == "sensevoice-small" {
        installed &=
            catalog::verify(&catalog::SENSE_TOKENS, &target.with_file_name("tokens.txt")).is_ok();
    }
    let integrity = if !exists {
        "missing"
    } else if !installed {
        "corrupt"
    } else if verify {
        if catalog::verify(m, &target).is_ok() {
            "verified"
        } else {
            installed = false;
            "corrupt"
        }
    } else {
        "unverified"
    };
    let previous = std::fs::read_dir(root.join(m.id))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .find_map(|entry| {
            let version = entry.file_name().to_string_lossy().into_owned();
            if version != m.sha256
                && version.len() == 64
                && version.bytes().all(|b| b.is_ascii_hexdigit())
                && entry.path().join(m.filename).is_file()
            {
                Some(version)
            } else {
                None
            }
        });
    let legacy = root.join(m.id).join(m.filename).is_file();
    ModelStatus {
        model: {
            let mut display = m.clone();
            display.bytes = bundle_bytes(m);
            display
        },
        replacement: catalog::replacement(m.id),
        download_url: catalog::download_url(m),
        resumable_bytes: std::fs::metadata(target.with_extension("bin.part"))
            .map(|v| v.len())
            .ok()
            .filter(|n| *n <= m.bytes)
            .unwrap_or(0),
        license: if m.id == "sensevoice-small" {
            "FunASR Model License v1.1"
        } else {
            "MIT"
        },
        catalog_version: catalog::CATALOG_VERSION,
        available_version: &m.sha256[..12],
        installed_version: if exists {
            Some(m.sha256[..12].into())
        } else {
            previous
                .as_ref()
                .map(|v| v[..12].into())
                .or_else(|| legacy.then(|| "legacy".into()))
        },
        update_available: !installed && (previous.is_some() || legacy),
        installed,
        integrity,
    }
}
#[tauri::command]
pub fn voice_models() -> Vec<ModelStatus> {
    let root = crate::models::store::models_root();
    MODELS.iter().map(|m| inventory(m, &root, false)).collect()
}
/// Explicit integrity/version check uses the catalog shipped with this app.
/// No unreviewed upstream revision or network source silently changes the model.
#[tauri::command]
pub async fn voice_check_models() -> Result<Vec<ModelStatus>, String> {
    let _lock = INSTALL
        .try_lock()
        .map_err(|_| "A model installation is already running")?;
    tokio::task::spawn_blocking(|| {
        let root = crate::models::store::models_root();
        MODELS.iter().map(|m| inventory(m, &root, true)).collect()
    })
    .await
    .map_err(|e| e.to_string())
}
