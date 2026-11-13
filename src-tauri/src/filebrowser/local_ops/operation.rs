use super::model::{OpError, OpResult};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

fn registry() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    REGISTRY.get_or_init(Mutex::default)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    operation_id: String,
    bytes: u64,
    items: u64,
    path: String,
}

/// Owned by the command's blocking worker, never by a view. Dropping an IPC
/// promise or closing its tab does not interrupt a filesystem operation.
pub(super) struct Operation {
    id: String,
    cancelled: Arc<AtomicBool>,
    bytes: u64,
    items: u64,
    last_emit: Instant,
    app: Option<tauri::AppHandle>,
}

impl Operation {
    pub fn register(id: Option<String>, app: Option<tauri::AppHandle>) -> OpResult<Self> {
        let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if id.is_empty() || id.len() > 256 {
            return Err(OpError::new(
                "invalid_operation",
                "Invalid operation identifier",
            ));
        }
        let mut registry = registry()
            .lock()
            .map_err(|_| OpError::new("internal_error", "Operation registry unavailable"))?;
        if registry.contains_key(&id) {
            return Err(OpError::new(
                "operation_running",
                "This operation is already running",
            ));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        registry.insert(id.clone(), cancelled.clone());
        Ok(Self {
            id,
            cancelled,
            bytes: 0,
            items: 0,
            last_emit: Instant::now(),
            app,
        })
    }

    pub fn check(&self) -> OpResult<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err(OpError::new(
                "cancelled",
                "Operation cancelled; completed and partial destination entries are retained",
            ))
        } else {
            Ok(())
        }
    }

    pub fn advance(&mut self, path: &std::path::Path, bytes: u64, items: u64) -> OpResult<()> {
        self.check()?;
        self.bytes = self.bytes.saturating_add(bytes);
        self.items = self.items.saturating_add(items);
        // Small file actions are instantaneous; do not flood the event bus.
        if (self.bytes >= 16 * 1024 * 1024 || self.items >= 100)
            && self.last_emit.elapsed() >= Duration::from_millis(100)
        {
            if let Some(app) = &self.app {
                let _ = app.emit(
                    "explorer:progress",
                    Progress {
                        operation_id: self.id.clone(),
                        bytes: self.bytes,
                        items: self.items,
                        path: path.to_string_lossy().into_owned(),
                    },
                );
            }
            self.last_emit = Instant::now();
        }
        Ok(())
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        if let Ok(mut registry) = registry().lock() {
            if registry
                .get(&self.id)
                .is_some_and(|token| Arc::ptr_eq(token, &self.cancelled))
            {
                registry.remove(&self.id);
            }
        }
    }
}

pub(super) fn cancel(id: &str) -> OpResult<()> {
    if let Some(token) = registry()
        .lock()
        .map_err(|_| OpError::new("internal_error", "Operation registry unavailable"))?
        .get(id)
    {
        token.store(true, Ordering::Relaxed);
    }
    Ok(())
}
