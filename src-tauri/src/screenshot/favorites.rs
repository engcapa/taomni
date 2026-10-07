//! Persistent, local screenshot favorites. Each entry is published by one
//! directory rename so an interrupted write cannot expose a partial favorite.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use super::{blocking, capture};

static STORAGE: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotFavorite {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub created_at: u64,
    #[serde(default)]
    pub note: String,
}

fn root(app: &AppHandle) -> anyhow::Result<PathBuf> {
    Ok(crate::resolved_app_data_dir(app)
        .map_err(anyhow::Error::msg)?
        .join("screenshot-favorites"))
}

fn entry_dir(root: &Path, id: &str) -> anyhow::Result<PathBuf> {
    let parsed = Uuid::parse_str(id).context("invalid screenshot favorite ID")?;
    anyhow::ensure!(parsed.to_string() == id, "invalid screenshot favorite ID");
    Ok(root.join(id))
}

fn read(root: &Path, id: &str) -> anyhow::Result<ScreenshotFavorite> {
    let dir = entry_dir(root, id)?;
    let favorite: ScreenshotFavorite =
        serde_json::from_slice(&std::fs::read(dir.join("info.json"))?)?;
    anyhow::ensure!(favorite.id == id, "screenshot favorite metadata mismatch");
    Ok(favorite)
}

fn list(root: &Path) -> anyhow::Result<Vec<ScreenshotFavorite>> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut items = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && Uuid::parse_str(&id).is_ok() {
            items.push(read(root, &id)?);
        }
    }
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    Ok(items)
}

fn add(root: &Path, src: &Path) -> anyhow::Result<ScreenshotFavorite> {
    let image = image::open(src).context("read screenshot to favorite")?;
    let favorite = ScreenshotFavorite {
        id: Uuid::new_v4().to_string(),
        width: image.width(),
        height: image.height(),
        created_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64,
        note: String::new(),
    };
    std::fs::create_dir_all(root)?;
    let staging = root.join(format!(".pending-{}", favorite.id));
    std::fs::create_dir(&staging)?;
    let result = (|| -> anyhow::Result<()> {
        // Keep the original pixels; window zoom/opacity are view preferences.
        std::fs::copy(src, staging.join("image.png"))?;
        image
            .thumbnail(256, 160)
            .save(staging.join("thumbnail.png"))?;
        std::fs::write(staging.join("info.json"), serde_json::to_vec(&favorite)?)?;
        std::fs::rename(&staging, entry_dir(root, &favorite.id)?)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result?;
    Ok(favorite)
}

#[tauri::command]
pub async fn screenshot_list_favorites(app: AppHandle) -> Result<Vec<ScreenshotFavorite>, String> {
    blocking("list favorites", move || {
        let _guard = STORAGE.lock().unwrap_or_else(|e| e.into_inner());
        list(&root(&app)?)
    })
    .await
}

#[tauri::command]
pub async fn screenshot_add_favorite(
    app: AppHandle,
    path: String,
) -> Result<ScreenshotFavorite, String> {
    blocking("favorite", move || {
        let _guard = STORAGE.lock().unwrap_or_else(|e| e.into_inner());
        let root = root(&app)?;
        let mut item = add(&root, &capture::ensure_artifact_path(&path)?)?;
        let note = super::tool_state()
            .pins
            .values()
            .find(|pin| pin.path == path)
            .map(|pin| pin.note.clone())
            .unwrap_or_default();
        item.note = note;
        std::fs::write(
            entry_dir(&root, &item.id)?.join("info.json"),
            serde_json::to_vec(&item)?,
        )?;
        Ok(item)
    })
    .await
}

#[tauri::command]
pub async fn screenshot_remove_favorite(app: AppHandle, id: String) -> Result<(), String> {
    blocking("remove favorite", move || {
        let _guard = STORAGE.lock().unwrap_or_else(|e| e.into_inner());
        let dir = entry_dir(&root(&app)?, &id)?;
        if dir.exists() {
            std::fs::remove_dir_all(dir)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn screenshot_favorite_thumbnail(
    app: AppHandle,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    blocking("favorite thumbnail", move || {
        let _guard = STORAGE.lock().unwrap_or_else(|e| e.into_inner());
        let dir = entry_dir(&root(&app)?, &id)?;
        Ok(tauri::ipc::Response::new(std::fs::read(
            dir.join("thumbnail.png"),
        )?))
    })
    .await
}

#[tauri::command]
pub async fn screenshot_pin_favorite(app: AppHandle, id: String) -> Result<String, String> {
    let storage_app = app.clone();
    let (path, favorite) = blocking("open favorite", move || {
        let _guard = STORAGE.lock().unwrap_or_else(|e| e.into_inner());
        let root = root(&storage_app)?;
        let favorite = read(&root, &id)?;
        let path = capture::untracked_artifact_path("pin", "png")?;
        std::fs::copy(entry_dir(&root, &id)?.join("image.png"), &path)?;
        Ok((path, favorite))
    })
    .await?;
    super::open_pin_with_note(
        &app,
        path,
        favorite.width,
        favorite.height,
        Some(favorite.id),
        favorite.note,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn favorite_survives_source_deletion_and_reloads_original_pixels() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("favorites");
        let src = temp.path().join("source.png");
        let image = image::RgbaImage::from_fn(400, 300, |x, y| {
            image::Rgba([x as u8, y as u8, 80, (x % 255) as u8])
        });
        image.save(&src).unwrap();
        let favorite = add(&root, &src).unwrap();
        std::fs::remove_file(src).unwrap();
        assert_eq!(list(&root).unwrap()[0].id, favorite.id);
        let saved = image::open(entry_dir(&root, &favorite.id).unwrap().join("image.png"))
            .unwrap()
            .to_rgba8();
        assert_eq!(saved, image);
        let thumb = image::open(
            entry_dir(&root, &favorite.id)
                .unwrap()
                .join("thumbnail.png"),
        )
        .unwrap();
        assert!(thumb.width() <= 256 && thumb.height() <= 160);
        std::fs::remove_dir_all(entry_dir(&root, &favorite.id).unwrap()).unwrap();
        assert!(list(&root).unwrap().is_empty());
    }

    #[test]
    fn invalid_ids_cannot_escape_storage_and_failed_add_leaves_no_entry() {
        let temp = tempfile::tempdir().unwrap();
        for id in ["../file", "/tmp/file", "not-an-id"] {
            assert!(entry_dir(temp.path(), id).is_err());
        }
        assert!(add(temp.path(), &temp.path().join("missing.png")).is_err());
        assert!(list(temp.path()).unwrap().is_empty());
    }
}
