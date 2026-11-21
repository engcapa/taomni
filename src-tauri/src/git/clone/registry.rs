use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

struct ActiveClone {
    cancel: Arc<AtomicBool>,
    destination: PathBuf,
}

static ACTIVE_CLONES: LazyLock<Mutex<HashMap<String, ActiveClone>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn register_task(task_id: &str, destination: &Path) -> Result<Arc<AtomicBool>, String> {
    if task_id.trim().is_empty() {
        return Err("clone task id is required".into());
    }
    let mut active = ACTIVE_CLONES
        .lock()
        .map_err(|_| "clone registry is unavailable".to_string())?;
    if active.contains_key(task_id) {
        return Err("This clone task is already running".into());
    }
    if active
        .values()
        .any(|clone| clone.destination == destination)
    {
        return Err("A clone is already running for this destination".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    active.insert(
        task_id.to_string(),
        ActiveClone {
            cancel: cancel.clone(),
            destination: destination.to_path_buf(),
        },
    );
    Ok(cancel)
}

pub(super) fn unregister_task(task_id: &str) {
    if let Ok(mut active) = ACTIVE_CLONES.lock() {
        active.remove(task_id);
    }
}

pub(super) fn cancel_task(task_id: &str) -> bool {
    let Ok(active) = ACTIVE_CLONES.lock() else {
        return false;
    };
    active
        .get(task_id)
        .map(|task| {
            task.cancel.store(true, Ordering::SeqCst);
            true
        })
        .unwrap_or(false)
}
