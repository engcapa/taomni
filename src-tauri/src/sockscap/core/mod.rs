//! Connect the desktop relay to the SocksCap host's upstream processes.

use std::sync::{Arc, Mutex};
#[cfg(windows)]
use std::time::Duration;

use taomni_sockscap_api::{SLUG, XRAY, XrayProcesses, XrayRequest};
use tokio::sync::mpsc::UnboundedSender;

use crate::plugin::{LifecycleState, PluginRegistry};

pub use config_gen::ResolvedCoreUpstream;
pub use taomni_sockscap_api::{share_link, xray_config as config_gen};

type Monitor = Option<tokio::task::JoinHandle<()>>;

pub struct XrayManager {
    registry: Arc<PluginRegistry>,
    in_use: tokio::sync::Mutex<bool>,
    monitor: Mutex<Monitor>,
    respawn_tx: Mutex<Option<UnboundedSender<Vec<u32>>>>,
}

impl XrayManager {
    pub fn new(registry: Arc<PluginRegistry>) -> Self {
        Self {
            registry,
            in_use: tokio::sync::Mutex::new(false),
            monitor: Mutex::new(None),
            respawn_tx: Mutex::new(None),
        }
    }

    fn available(&self) -> bool {
        self.registry.get(SLUG).is_some_and(|module| {
            module.state == LifecycleState::Enabled && module.manifest.commands.contains(XRAY)
        })
    }

    async fn exchange<T: serde::de::DeserializeOwned + Send + 'static>(
        &self,
        request: XrayRequest,
    ) -> Result<T, String> {
        super::module_host::invoke(
            &self.registry,
            XRAY,
            serde_json::to_value(request).map_err(|error| error.to_string())?,
        )
        .await
    }

    pub async fn ensure(&self, profile: &str, spec: &ResolvedCoreUpstream) -> Result<u16, String> {
        let mut in_use = self.in_use.lock().await;
        if !self.available() {
            return Err("Install or update the SocksCap module to use this upstream".into());
        }
        // A cancelled caller may have reached the host. Include it in teardown.
        *in_use = true;
        self.exchange(XrayRequest::Ensure {
            profile: profile.into(),
            spec: Box::new(spec.clone()),
        })
        .await
    }

    pub async fn remove(&self, profile: &str) {
        let _in_use = self.in_use.lock().await;
        if self.available()
            && let Err(error) = self
                .exchange::<()>(XrayRequest::Remove {
                    profile: profile.into(),
                })
                .await
        {
            tracing::warn!("Could not release the SocksCap upstream probe: {error}");
        }
    }

    pub async fn processes(&self) -> Result<Option<XrayProcesses>, String> {
        let _operations = self.in_use.lock().await;
        if self.available() {
            self.exchange(XrayRequest::State).await.map(Some)
        } else {
            Ok(None)
        }
    }

    #[cfg(windows)]
    pub async fn pids(&self) -> Vec<u32> {
        match self.processes().await {
            Ok(Some(processes)) => processes.children,
            Ok(None) => Vec::new(),
            Err(error) => {
                tracing::warn!("Could not query SocksCap upstream processes: {error}");
                Vec::new()
            }
        }
    }

    #[cfg(windows)]
    pub async fn running_count(&self) -> usize {
        self.pids().await.len()
    }

    pub async fn shutdown_all(&self) {
        self.shutdown_all_blocking();
        let mut in_use = self.in_use.lock().await;
        if *in_use
            && self.available()
            && let Err(error) = self.exchange::<()>(XrayRequest::Stop).await
        {
            tracing::warn!("Could not stop SocksCap upstream processes: {error}");
            return;
        }
        *in_use = false;
    }

    pub fn shutdown_all_blocking(&self) {
        if let Some(monitor) = self.monitor.lock().expect("SocksCap monitor").take() {
            monitor.abort();
        }
        self.respawn_tx
            .lock()
            .expect("SocksCap bypass sender")
            .take();
    }

    #[cfg(windows)]
    pub fn set_respawn_notifier(&self, sender: UnboundedSender<Vec<u32>>) {
        *self.respawn_tx.lock().expect("SocksCap bypass sender") = Some(sender);
    }

    #[cfg(windows)]
    pub fn start_monitor(self: &Arc<Self>, interval: Duration) {
        let mut monitor = self.monitor.lock().expect("SocksCap monitor");
        if monitor.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        let manager = Arc::downgrade(self);
        *monitor = Some(tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut previous = None;
            loop {
                tick.tick().await;
                let Some(manager) = manager.upgrade() else {
                    break;
                };
                let mut pids = manager.pids().await;
                pids.sort_unstable();
                if previous.as_ref() != Some(&pids) {
                    if let Some(sender) = manager
                        .respawn_tx
                        .lock()
                        .expect("SocksCap bypass sender")
                        .as_ref()
                    {
                        let _ = sender.send(pids.clone());
                    }
                    previous = Some(pids);
                }
            }
        }));
    }
}
