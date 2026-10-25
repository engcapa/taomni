use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use tauri::AppHandle;
use tauri::Runtime;
use tauri::WebviewWindow;
use tokio::sync::Mutex;

pub(super) const SESSION_ID: &str = "taomni-qa-macos";
pub(super) static BRIDGE_STARTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[derive(Clone)]
pub(super) struct ElementRef {
    pub(super) using: String,
    pub(super) selector: String,
    pub(super) index: usize,
}

pub(super) struct DriverState<R: Runtime> {
    pub(super) app: AppHandle<R>,
    pub(super) window: Arc<std::sync::RwLock<WebviewWindow<R>>>,
    pub(super) elements: Arc<Mutex<HashMap<String, ElementRef>>>,
    pub(super) next_element: Arc<AtomicU64>,
}

impl<R: Runtime> Clone for DriverState<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            window: self.window.clone(),
            elements: self.elements.clone(),
            next_element: self.next_element.clone(),
        }
    }
}

impl<R: Runtime> DriverState<R> {
    pub(super) fn current_window(&self) -> Result<WebviewWindow<R>, String> {
        self.window
            .read()
            .map(|window| window.clone())
            .map_err(|_| "QA window lock poisoned".into())
    }
}
