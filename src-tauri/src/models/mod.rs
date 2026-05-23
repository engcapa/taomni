// Model manifest + downloader.
//
// Bundles the canonical manifest at compile time (resources/models.manifest.json),
// and at runtime tries to fetch a fresher one from https://newmob.app/models.manifest.json
// (best-effort; falls back silently). Each model entry lists 2-3 mirror URLs probed
// in parallel — the first to return 200 wins. Downloads support Range-resume and
// are SHA-256 verified after completion.
//
// Models live under `dirs::cache_dir()/newmob/models/<id>/<filename>`.
// Sidecar binaries live under `.../newmob/binaries/<id>/<filename>`.

pub mod downloader;
pub mod manifest;
pub mod store;

pub use downloader::{download_model, DownloadProgress};
pub use manifest::{ModelKind, ModelManifest, ModelMeta};
pub use store::{model_path, models_root, sidecars_root};

#[tauri::command]
pub async fn models_list() -> Result<Vec<crate::models::manifest::ModelMetaSummary>, String> {
    let manifest = manifest::load_manifest().map_err(|e| e.to_string())?;
    Ok(manifest.summaries())
}

#[tauri::command]
pub async fn models_download(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let manifest = manifest::load_manifest().map_err(|e| e.to_string())?;
    let meta = manifest
        .models
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("Unknown model id: {id}"))?;

    let target = store::model_path(&id, &meta);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let event_name = format!("model-progress:{id}");
    let app_clone = app.clone();
    download_model(&meta, &target, move |p| {
        let _ = app_clone.emit(&event_name, p);
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn models_delete(id: String) -> Result<(), String> {
    let manifest = manifest::load_manifest().map_err(|e| e.to_string())?;
    let meta = manifest
        .models
        .get(&id)
        .ok_or_else(|| format!("Unknown model id: {id}"))?;

    let path = store::model_path(&id, meta);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::remove_dir(parent); // ok if non-empty
    }
    Ok(())
}

#[tauri::command]
pub async fn models_verify(id: String) -> Result<bool, String> {
    let manifest = manifest::load_manifest().map_err(|e| e.to_string())?;
    let meta = manifest
        .models
        .get(&id)
        .ok_or_else(|| format!("Unknown model id: {id}"))?;

    let path = store::model_path(&id, meta);
    if !path.exists() {
        return Ok(false);
    }
    let placeholder = "0".repeat(64);
    if meta.sha256 == placeholder {
        // Manifest entry is a placeholder — accept presence as "installed"
        // until the real digest is published.
        return Ok(true);
    }
    let digest = downloader::sha256_file(&path).map_err(|e| e.to_string())?;
    Ok(digest.eq_ignore_ascii_case(&meta.sha256))
}
