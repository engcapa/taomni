//! Opt-in, instance-owned mobile control plane. No listener exists by default.
mod agent_view;
pub mod im_adapter;
pub use im_adapter::*;
pub mod auth;
pub mod confirmation;
pub mod events;
mod file_policy;
pub(crate) mod file_view;
mod file_watch;
pub mod headless;
mod headless_ops;
mod listener_policy;
pub use listener_policy::ListenerConfig;
pub mod pty_broker;
mod replay;
mod server;
pub mod session_open;
mod session_view;
mod settings;
mod streams;
pub mod turn;
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
    pub im: Arc<im_adapter::Runtime>,
    pub auth: Mutex<auth::Auth>,
    pub events: Arc<events::Events>,
    pub broker: Arc<pty_broker::Broker>,
    pub lifecycle: tokio::sync::Mutex<Option<Running>>,
    pub instance_id: String,
    pub confirmations: Mutex<std::collections::HashMap<String, serde_json::Value>>,
    pub pending_turns: Mutex<std::collections::HashMap<String, turn::Turn>>,
    pub tools: Mutex<std::collections::HashMap<String, Vec<serde_json::Value>>>,
    pub task_summaries: Mutex<std::collections::HashMap<String, serde_json::Value>>,
    pub profile_data: Mutex<Option<PathBuf>>,
    pub file_roots: Mutex<std::collections::HashMap<String, PathBuf>>,
    pub roots_changed: tokio::sync::Notify,
    pub desktop_available: std::sync::atomic::AtomicBool,
    pub devices_changed: tokio::sync::Notify,
    pub open_requests: session_open::OpenRequests,
}
pub struct Running {
    pub address: String,
    pub cancel: CancellationToken,
    pub task: tokio::task::JoinHandle<()>,
    hosts: Arc<std::sync::RwLock<listener_policy::HostPolicy>>,
}
impl Default for MobileRuntime {
    fn default() -> Self {
        let events = Arc::new(events::Events::default());
        Self {
            im: Arc::new(im_adapter::Runtime::default()),
            auth: Mutex::new(auth::Auth::default()),
            broker: Arc::new(pty_broker::Broker::new(events.clone())),
            events,
            lifecycle: tokio::sync::Mutex::new(None),
            instance_id: uuid::Uuid::new_v4().to_string(),
            devices_changed: tokio::sync::Notify::new(),
            confirmations: Mutex::new(Default::default()),
            pending_turns: Mutex::new(Default::default()),
            task_summaries: Mutex::new(Default::default()),
            tools: Mutex::new(Default::default()),
            file_roots: Mutex::new(Default::default()),
            profile_data: Mutex::new(None),
            roots_changed: tokio::sync::Notify::new(),
            desktop_available: std::sync::atomic::AtomicBool::new(false),
            open_requests: session_open::OpenRequests::default(),
        }
    }
}
impl MobileRuntime {
    pub fn turn_cancel(&self, thread: &str) -> CancellationToken {
        self.pending_turns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(thread)
            .map(|turn| turn.cancel.clone())
            .unwrap_or_default()
    }
    pub fn task_status(&self, thread: &str, status: &str, summary: &str) {
        let value = serde_json::json!({"type":"task_status","task_id":format!("thread:{thread}"),
            "status":status,"summary":summary.chars().take(160).collect::<String>(),"last_activity_at":chrono::Utc::now().timestamp()});
        let round = self
            .pending_turns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(thread)
            .map(|t| t.id.clone());
        let mut value = value;
        value["turn_id"] = serde_json::json!(round);
        let mut summaries = self
            .task_summaries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if summaries.get(thread).is_some_and(|old| {
            old["turn_id"] == value["turn_id"]
                && old["status"] == value["status"]
                && old["summary"] == value["summary"]
        }) {
            return;
        }
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
        *self.profile_data.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(data.canonicalize().unwrap_or_else(|_| data.clone()));
        self.open_requests.ensure_loaded(&data);
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
        let hosts = Arc::new(std::sync::RwLock::new(listener_policy::HostPolicy::load(
            &data,
            listener
                .local_addr()
                .map_err(|_| "mobile_address_unavailable")?
                .port(),
            lan,
        )?));
        let service = server::Service {
            hosts: hosts.clone(),
            core,
            runtime: self.clone(),
            cancel: cancel.clone(),
        };
        self.broker
            .enabled
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let task = tokio::spawn(async move {
            let watch = file_watch::watch(service.clone());
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
            hosts,
        });
        Ok(address)
    }
    pub async fn listener_config(&self, data: &std::path::Path) -> Result<ListenerConfig, String> {
        let running = self.lifecycle.lock().await;
        if let Some(r) = running.as_ref().filter(|r| !r.task.is_finished()) {
            return r
                .hosts
                .read()
                .map(|policy| policy.config.clone())
                .map_err(|_| "mobile_listener_unavailable".into());
        }
        ListenerConfig::load(data)
    }
    pub async fn save_listener_config(
        &self,
        data: &std::path::Path,
        config: ListenerConfig,
    ) -> Result<ListenerConfig, String> {
        let config = config.normalized()?;
        // Serialize with start/stop so the persisted and active policies cannot
        // diverge. Persist successfully before admitting requests under it.
        let running = self.lifecycle.lock().await;
        if let Some(r) = running.as_ref().filter(|r| !r.task.is_finished()) {
            let mut policy = r.hosts.write().map_err(|_| "mobile_listener_unavailable")?;
            config.save(data)?;
            policy.config = config.clone();
        } else {
            config.save(data)?;
        }
        Ok(config)
    }
    pub async fn stop(&self) {
        self.open_requests.cancel_pending(None);
        let mut lifecycle = self.lifecycle.lock().await;
        self.im.stop().await;
        if let Some(running) = lifecycle.take() {
            running.cancel.cancel();
            let _ = running.task.await;
        }
        self.broker.disable();
        if let Ok(mut auth) = self.auth.lock() {
            auth.clear_ephemeral();
            let _ = auth.flush();
        }
    }
}

#[cfg(test)]
mod service_tests;

#[cfg(test)]
mod listener_tests;

#[cfg(test)]
mod task_tests;

#[cfg(test)]
mod review_tests;
