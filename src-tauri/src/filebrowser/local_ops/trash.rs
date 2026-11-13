use super::model::{
    CompletedEntry, EntryOperationResult, OpError, OpResult, TrashRef, TrashResult,
};
use super::paths::{absolute_entry, rename_no_replace};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone)]
enum PlatformRef {
    #[cfg(not(target_os = "macos"))]
    Item(trash::TrashItem),
    #[cfg(target_os = "macos")]
    Path(PathBuf),
    Unavailable,
}

#[derive(Clone)]
struct StoredTrash {
    original: PathBuf,
    reference: PlatformRef,
    created: Instant,
}

fn registry() -> &'static Mutex<HashMap<String, StoredTrash>> {
    static ITEMS: OnceLock<Mutex<HashMap<String, StoredTrash>>> = OnceLock::new();
    ITEMS.get_or_init(Mutex::default)
}

pub(super) fn trash_entries(paths: Vec<String>) -> TrashResult {
    let mut result = TrashResult::default();
    // Deletion + native lookup is serialized so two requests for the same
    // original name cannot accidentally claim one another's trash identifier.
    let Ok(mut registry) = registry().lock() else {
        result.failed.extend(paths.into_iter().map(|path| {
            OpError::new("trash_unavailable", "Trash registry unavailable").failure(path)
        }));
        return result;
    };
    registry.retain(|_, item| item.created.elapsed() < Duration::from_secs(600));
    for path in paths {
        match trash_one(Path::new(&path)) {
            Ok((original, reference)) => {
                let id = uuid::Uuid::new_v4().to_string();
                result.trashed.push(TrashRef {
                    id: id.clone(),
                    original_path: original.to_string_lossy().into_owned(),
                });
                registry.insert(
                    id,
                    StoredTrash {
                        original,
                        reference,
                        created: Instant::now(),
                    },
                );
            }
            Err(error) => result.failed.push(error.failure(path)),
        }
    }
    result
}

#[cfg(not(target_os = "macos"))]
fn trash_one(path: &Path) -> OpResult<(PathBuf, PlatformRef)> {
    let original = absolute_entry(path)?;
    fs::symlink_metadata(&original).map_err(|e| OpError::io("stat trash source", &original, e))?;
    let before: HashSet<_> = trash::os_limited::list()
        .map_err(|e| {
            OpError::new(
                "trash_unavailable",
                format!("Cannot inspect system trash: {e}"),
            )
        })?
        .into_iter()
        .map(|item| item.id)
        .collect();
    #[cfg(windows)]
    super::windows_trash::delete(&original)?;
    #[cfg(not(windows))]
    trash::delete(&original).map_err(|e| {
        OpError::new(
            "trash_unavailable",
            format!("Cannot move {} to system trash: {e}", original.display()),
        )
    })?;
    // Once the source has been trashed, never return it as a failed deletion:
    // the UI may offer permanent-delete fallback for failures. A lookup failure
    // must instead be a recoverable undo failure, not another delete attempt.
    let reference = trash::os_limited::list()
        .ok()
        .and_then(|items| {
            items.into_iter().find(|item| {
                !before.contains(&item.id) && same_original(&item.original_path(), &original)
            })
        })
        .map(PlatformRef::Item)
        .unwrap_or(PlatformRef::Unavailable);
    Ok((original, reference))
}

#[cfg(not(target_os = "macos"))]
fn same_original(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        super::windows_trash::shell_path(a)
            .eq_ignore_ascii_case(&super::windows_trash::shell_path(b))
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

#[cfg(target_os = "macos")]
fn trash_one(path: &Path) -> OpResult<(PathBuf, PlatformRef)> {
    use objc2::rc::autoreleasepool;
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let original = absolute_entry(path)?;
    fs::symlink_metadata(&original).map_err(|e| OpError::io("stat trash source", &original, e))?;
    autoreleasepool(|_| {
        // trash-rs intentionally does not expose restore on macOS. Use the same
        // NSFileManager backend but retain its resultingItemURL, so undo needs
        // neither Finder automation permission nor an AppleScript filename guess.
        let url = NSURL::fileURLWithPath(&NSString::from_str(&original.to_string_lossy()));
        let mut trashed_url = None;
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, Some(&mut trashed_url))
            .map_err(|e| {
                OpError::new(
                    "trash_unavailable",
                    format!("NSFileManager trash failed: {e}"),
                )
            })?;
        let reference = trashed_url
            .and_then(|url| url.path())
            .map(|p| PlatformRef::Path(PathBuf::from(p.to_string())))
            .unwrap_or(PlatformRef::Unavailable);
        Ok((original, reference))
    })
}

pub(super) fn restore_entries(items: Vec<TrashRef>) -> EntryOperationResult {
    let mut result = EntryOperationResult::default();
    let Ok(mut registry) = registry().lock() else {
        result.failed.extend(items.into_iter().map(|item| {
            OpError::new("restore_unavailable", "Trash registry unavailable")
                .failure(item.original_path)
        }));
        return result;
    };
    for item in items {
        let action = (|| {
            let stored = registry.get(&item.id).ok_or_else(|| {
                OpError::new(
                    "undo_expired",
                    "The undo reference has expired or the application was restarted",
                )
            })?;
            if stored.original.to_string_lossy() != item.original_path
                || stored.created.elapsed() >= Duration::from_secs(600)
            {
                return Err(OpError::new(
                    "undo_expired",
                    "The undo reference is invalid or expired",
                ));
            }
            restore_one(stored)?;
            Ok(stored.original.to_string_lossy().into_owned())
        })();
        match action {
            Ok(path) => {
                registry.remove(&item.id);
                result.done.push(CompletedEntry {
                    from: item.id,
                    to: path,
                });
            }
            Err(error) => result.failed.push(error.failure(item.original_path)),
        }
    }
    result
}

fn restore_one(stored: &StoredTrash) -> OpResult<()> {
    if fs::symlink_metadata(&stored.original).is_ok() {
        return Err(OpError::new(
            "already_exists",
            format!(
                "Cannot restore: {} already exists",
                stored.original.display()
            ),
        ));
    }
    match &stored.reference {
        PlatformRef::Unavailable => Err(OpError::new(
            "restore_unavailable",
            "The file is in system trash but its undo identifier could not be read; restore it in the system file manager",
        )),
        #[cfg(target_os = "macos")]
        PlatformRef::Path(path) => rename_no_replace(path, &stored.original)
            .map_err(|e| OpError::io("restore from Trash", &stored.original, e)),
        #[cfg(not(target_os = "macos"))]
        PlatformRef::Item(item) => restore_native_item(item, &stored.original),
    }
}

#[cfg(not(target_os = "macos"))]
fn restore_native_item(item: &trash::TrashItem, original: &Path) -> OpResult<()> {
    let current = trash::os_limited::list()
        .map_err(|e| {
            OpError::new(
                "restore_unavailable",
                format!("Cannot inspect system trash: {e}"),
            )
        })?
        .into_iter()
        .find(|current| {
            current.id == item.id
                && current.original_path() == item.original_path()
                && current.time_deleted == item.time_deleted
        })
        .ok_or_else(|| {
            OpError::new(
                "undo_expired",
                "The item was removed or changed in system trash",
            )
        })?;
    #[cfg(target_os = "linux")]
    {
        // trash-rs restore uses exists()+rename(), which can replace a file
        // created concurrently. Its documented Linux id is the .trashinfo path;
        // use an atomic no-replace rename for the corresponding files entry.
        let info = PathBuf::from(current.id);
        let name = info.file_stem().ok_or_else(|| {
            OpError::new("restore_unavailable", "Invalid trash metadata identifier")
        })?;
        let base = info.parent().and_then(Path::parent).ok_or_else(|| {
            OpError::new("restore_unavailable", "Invalid trash metadata location")
        })?;
        let file = base.join("files").join(name);
        rename_no_replace(&file, original)
            .map_err(|e| OpError::io("restore from trash", original, e))?;
        if let Err(error) = fs::remove_file(&info) {
            tracing::warn!(path = %info.display(), %error, "Restored Explorer item but could not remove obsolete trash metadata");
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = original;
        trash::os_limited::restore_all([current]).map_err(|e| {
            OpError::new(
                "restore_failed",
                format!("Cannot restore from recycle bin: {e}"),
            )
        })
    }
}
