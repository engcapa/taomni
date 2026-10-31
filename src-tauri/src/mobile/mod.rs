//! Opt-in, instance-owned mobile control plane. No listener exists by default.
mod agent_view;
pub mod auth;
pub mod events;
pub(crate) mod file_view;
pub mod headless;
pub mod pty_broker;
mod replay;
mod server;
mod session_view;
mod settings;
mod streams;
pub use settings::*;

use crate::state::AppState;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub enum Core {
    Desktop(tauri::AppHandle),
    Headless(Arc<AppState>),
}
pub enum CoreState<'a> {
    Desktop(tauri::State<'a, AppState>),
    Headless(&'a AppState),
}
impl std::ops::Deref for CoreState<'_> {
    type Target = AppState;
    fn deref(&self) -> &AppState {
        match self {
            Self::Desktop(s) => s.inner(),
            Self::Headless(s) => s,
        }
    }
}
impl Core {
    pub fn state(&self) -> CoreState<'_> {
        match self {
            Self::Desktop(app) => CoreState::Desktop(app.state()),
            Self::Headless(s) => CoreState::Headless(s),
        }
    }
    pub fn app(&self) -> Option<tauri::AppHandle> {
        match self {
            Self::Desktop(app) => Some(app.clone()),
            _ => None,
        }
    }
    pub fn mode(&self) -> &'static str {
        match self {
            Self::Desktop(_) => "desktop",
            _ => "headless",
        }
    }
}

pub struct MobileRuntime {
    pub auth: Mutex<auth::Auth>,
    pub events: Arc<events::Events>,
    pub broker: Arc<pty_broker::Broker>,
    pub lifecycle: tokio::sync::Mutex<Option<Running>>,
    pub instance_id: String,
    pub confirmations: Mutex<std::collections::HashMap<String, serde_json::Value>>,
    pub pending_turns: Mutex<std::collections::HashMap<String, CancellationToken>>,
    pub task_summaries: Mutex<std::collections::HashMap<String, serde_json::Value>>,
    pub file_roots: Mutex<std::collections::HashMap<String, PathBuf>>,
    pub roots_changed: tokio::sync::Notify,
    pub desktop_available: std::sync::atomic::AtomicBool,
    pub devices_changed: tokio::sync::Notify,
}
pub struct Running {
    pub address: String,
    pub cancel: CancellationToken,
    pub task: tokio::task::JoinHandle<()>,
}
impl Default for MobileRuntime {
    fn default() -> Self {
        let events = Arc::new(events::Events::default());
        Self {
            auth: Mutex::new(auth::Auth::default()),
            broker: Arc::new(pty_broker::Broker::new(events.clone())),
            events,
            lifecycle: tokio::sync::Mutex::new(None),
            instance_id: uuid::Uuid::new_v4().to_string(),
            devices_changed: tokio::sync::Notify::new(),
            confirmations: Mutex::new(Default::default()),
            pending_turns: Mutex::new(Default::default()),
            task_summaries: Mutex::new(Default::default()),
            file_roots: Mutex::new(Default::default()),
            roots_changed: tokio::sync::Notify::new(),
            desktop_available: std::sync::atomic::AtomicBool::new(false),
        }
    }
}
impl MobileRuntime {
    pub fn turn_cancel(&self, thread: &str) -> CancellationToken {
        self.pending_turns
            .lock()
            .unwrap()
            .get(thread)
            .cloned()
            .unwrap_or_default()
    }
    pub fn task_status(&self, thread: &str, status: &str, summary: &str) {
        let value = serde_json::json!({"type":"task_status","task_id":format!("thread:{thread}"),
            "status":status,"summary":summary.chars().take(160).collect::<String>(),"last_activity_at":chrono::Utc::now().timestamp()});
        let mut summaries = self.task_summaries.lock().unwrap();
        if !summaries.contains_key(thread) && summaries.len() >= 200 {
            let oldest = summaries
                .iter()
                .min_by_key(|(_, v)| v["last_activity_at"].as_i64().unwrap_or(0))
                .map(|(k, _)| k.clone());
            if let Some(id) = oldest {
                summaries.remove(&id);
            }
        }
        summaries.insert(thread.into(), value.clone());
        drop(summaries);
        if self
            .broker
            .enabled
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            self.events.publish(value);
        }
    }
    pub async fn start(
        self: &Arc<Self>,
        core: Core,
        data: PathBuf,
        lan: bool,
        port: u16,
    ) -> Result<String, String> {
        self.desktop_available
            .store(core.app().is_some(), std::sync::atomic::Ordering::Relaxed);
        let mut running = self.lifecycle.lock().await;
        if let Some(r) = running.as_ref().filter(|r| !r.task.is_finished()) {
            return Ok(r.address.clone());
        }
        self.auth
            .lock()
            .map_err(|_| "auth_unavailable")?
            .load(data.join("mobile-devices.json"))?;
        let listener =
            tokio::net::TcpListener::bind((if lan { "0.0.0.0" } else { "127.0.0.1" }, port))
                .await
                .map_err(|e| format!("Mobile listener: {e}"))?;
        let address = format!(
            "http://{}",
            listener.local_addr().map_err(|e| e.to_string())?
        );
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let runtime = self.clone();
        let service = server::Service {
            core,
            runtime: self.clone(),
            cancel: cancel.clone(),
        };
        self.broker
            .enabled
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let task = tokio::spawn(async move {
            let watch = file_view::watch(service.clone());
            let result = axum::serve(
                listener,
                server::router(service)
                    .into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(task_cancel.clone().cancelled_owned())
            .await;
            task_cancel.cancel();
            watch.abort();
            runtime.broker.disable();
            if result.is_err() {
                log::error!("Mobile listener stopped unexpectedly");
            }
        });
        *running = Some(Running {
            address: address.clone(),
            cancel,
            task,
        });
        Ok(address)
    }
    pub async fn stop(&self) {
        if let Some(running) = self.lifecycle.lock().await.take() {
            running.cancel.cancel();
            let _ = running.task.await;
        }
        self.broker.disable();
        if let Ok(mut auth) = self.auth.lock() {
            let _ = auth.flush();
        }
    }
}

#[cfg(test)]
mod service_tests;

#[cfg(test)]
mod task_tests;
