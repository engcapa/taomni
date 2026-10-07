//! ASR installation is explicit, serialized and verified before atomic publication.
use super::catalog::{self, MODELS};
use futures::StreamExt;
use serde::Serialize;
use tauri::Emitter;
static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize)]
pub struct ModelStatus {
    #[serde(flatten)]
    model: catalog::Model,
    installed: bool,
    license: &'static str,
    catalog_version: &'static str,
    available_version: &'static str,
    installed_version: Option<String>,
    update_available: bool,
    integrity: &'static str,
}
fn inventory(m: &catalog::Model, root: &std::path::Path, verify: bool) -> ModelStatus {
    let target = catalog::version_path(root, m);
    let exists = target.is_file();
    let mut installed = std::fs::metadata(&target)
        .map(|v| v.len() == m.bytes)
        .unwrap_or(false);
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
        model: m.clone(),
        license: "MIT",
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
#[tauri::command]
pub async fn voice_install_model(
    app: tauri::AppHandle,
    model_id: String,
    source_path: Option<String>,
) -> Result<(), String> {
    let _lock = INSTALL
        .try_lock()
        .map_err(|_| "A model installation is already running")?;
    let m = catalog::model(&model_id)?;
    let target = catalog::path(m);
    std::fs::create_dir_all(target.parent().ok_or("Invalid model directory")?)
        .map_err(|e| e.to_string())?;
    let part = target.with_extension("bin.part");
    let result: Result<(), String> = async {
        if let Some(source) = source_path {
            if tokio::fs::metadata(&source)
                .await
                .map_err(|e| e.to_string())?
                .len()
                != m.bytes
            {
                return Err("Incorrect model file size".into());
            }
            let dest = part.clone();
            tokio::task::spawn_blocking(move || std::fs::copy(source, dest))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
        } else {
            // Explicit downloads use the official source; offline import works without network.
            let origin = format!(
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/{}",
                catalog::UPSTREAM_REVISION
            );
            let client = reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(20))
                .timeout(std::time::Duration::from_secs(1800))
                .build()
                .map_err(|e| e.to_string())?;
            let response = client
                .get(format!("{origin}/{}", m.filename))
                .send()
                .await
                .map_err(|e| e.to_string())?
                .error_for_status()
                .map_err(|e| e.to_string())?;
            let mut file = tokio::fs::File::create(&part)
                .await
                .map_err(|e| e.to_string())?;
            let mut stream = response.bytes_stream();
            let mut bytes = 0u64;
            let mut last = std::time::Instant::now();
            use tokio::io::AsyncWriteExt;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| e.to_string())?;
                bytes += chunk.len() as u64;
                if bytes > m.bytes {
                    return Err("Model exceeds expected size".into());
                }
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                if last.elapsed().as_millis() >= 200 || bytes == m.bytes {
                    let _ = app.emit(
                        "voice-model-progress",
                        serde_json::json!({"model_id": m.id, "bytes": bytes, "total": m.bytes}),
                    );
                    last = std::time::Instant::now();
                }
            }
            file.sync_all().await.map_err(|e| e.to_string())?;
        }
        let install_target = target.clone();
        let install_part = part.clone();
        tokio::task::spawn_blocking(move || publish_verified(m, &install_part, &install_target))
            .await
            .map_err(|e| e.to_string())??;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result
}

fn publish_verified(
    m: &catalog::Model,
    part: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    catalog::verify(m, part)?;
    if target.exists() {
        if catalog::verify(m, target).is_ok() {
            // Never delete a valid current file on reinstall, including Windows.
            return std::fs::remove_file(part).map_err(|e| e.to_string());
        }
        // This is only the corrupt current revision; previous revisions have
        // different directories and are never modified by this transaction.
        std::fs::remove_file(target).map_err(|e| e.to_string())?;
    }
    std::fs::rename(part, target).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_catalog_updates_and_corruption_without_removing_old_versions() {
        let root = tempfile::tempdir().unwrap();
        let old = catalog::Model {
            id: "test",
            filename: "model.bin",
            bytes: 3,
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        };
        let current = catalog::Model {
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ..old.clone()
        };
        let old_path = catalog::version_path(root.path(), &old);
        std::fs::create_dir_all(old_path.parent().unwrap()).unwrap();
        std::fs::write(&old_path, b"old").unwrap();
        let status = inventory(&current, root.path(), false);
        assert!(status.update_available);
        assert!(!status.installed);
        assert_eq!(status.installed_version.as_deref(), Some("aaaaaaaaaaaa"));
        let path = catalog::version_path(root.path(), &current);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"bad").unwrap();
        assert_eq!(inventory(&current, root.path(), true).integrity, "corrupt");
        assert_eq!(std::fs::read(&old_path).unwrap(), b"old");
        let part = path.with_extension("bin.part");
        std::fs::write(&part, b"bad").unwrap();
        assert!(publish_verified(&current, &part, &path).is_err());
        assert_eq!(std::fs::read(&old_path).unwrap(), b"old");
        assert_eq!(std::fs::read(&path).unwrap(), b"bad");
        std::fs::write(&part, b"abc").unwrap();
        publish_verified(&current, &part, &path).unwrap();
        assert!(!part.exists());
        let status = inventory(&current, root.path(), true);
        assert!(status.installed);
        assert!(!status.update_available);
        assert_eq!(status.integrity, "verified");
        assert_eq!(std::fs::read(&old_path).unwrap(), b"old");
    }
}
