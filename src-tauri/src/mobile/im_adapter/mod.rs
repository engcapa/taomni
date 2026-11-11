//! Opt-in Feishu adapter; long connection only, no public webhook ingress.
mod actions;
mod cards;
mod commands;
mod config;
mod network;
mod notifications;
mod protocol;
mod settings;
mod worker;
use crate::mobile::Core;
pub use config::Config;
use serde::Serialize;
pub use settings::*;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

#[derive(Clone, Default, Serialize)]
pub struct Status {
    pub state: String,
    pub error: Option<String>,
    pub reconnects: u64,
    pub delivered: u64,
    pub failed_deliveries: u64,
    pub rejected: u64,
    pub duplicates: u64,
}
struct Running {
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
    network: network::Network,
}
pub struct Runtime {
    lifecycle: tokio::sync::Mutex<Option<Running>>,
    status: Mutex<Status>,
    instance: String,
    /// Last terminal each chat user operated, so follow-up input needs no id.
    focus: Mutex<HashMap<String, String>>,
    /// Chat + terminal -> (follow id, cancellation) for in-place card refreshes.
    follows: Mutex<HashMap<String, (String, CancellationToken)>>,
}
/// Follow window for a terminal card. Short enough to stay within platform
/// update quotas, long enough to watch a command finish.
const FOLLOW_TICKS: usize = 20;
const FOLLOW_INTERVAL: Duration = Duration::from_secs(3);
impl Default for Runtime {
    fn default() -> Self {
        Self {
            lifecycle: tokio::sync::Mutex::new(None),
            status: Mutex::new(Status {
                state: "stopped".into(),
                ..Default::default()
            }),
            instance: uuid::Uuid::new_v4().to_string(),
            focus: Mutex::new(HashMap::new()),
            follows: Mutex::new(HashMap::new()),
        }
    }
}
impl Runtime {
    pub fn snapshot(&self) -> Status {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    fn state(&self, state: &str, error: Option<String>) {
        let mut value = self.status.lock().unwrap_or_else(|e| e.into_inner());
        value.state = state.into();
        value.error = error;
    }
    fn error(&self, error: &str) {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).error = Some(error.into());
    }
    pub fn focus_get(&self, key: &str) -> Option<String> {
        self.focus
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned()
    }
    pub fn focus_set(&self, key: &str, id: &str) {
        self.focus
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.into(), id.into());
    }
    fn follow_key(chat: &str, term: &str) -> String {
        format!("{chat}:{term}")
    }
    pub fn is_following(&self, chat: &str, term: &str) -> bool {
        self.follows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&Self::follow_key(chat, term))
    }
    /// Stops refreshing one card in place.
    pub fn unfollow(&self, chat: &str, term: &str) {
        if let Some((_, token)) = self
            .follows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&Self::follow_key(chat, term))
        {
            token.cancel();
        }
    }
    fn clear_follows(&self) {
        let follows = {
            let mut guard = self.follows.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut *guard)
        };
        for (_, token) in follows.values() {
            token.cancel();
        }
    }
    /// Updates a terminal card in place for a bounded window. Feishu requires
    /// `update_multi` in the card and caps updates per message, so this is a
    /// short follow window rather than a permanent subscription.
    pub fn start_follow(
        self: &Arc<Self>,
        core: Core,
        network: network::Network,
        chat: String,
        term: String,
        message_id: String,
    ) {
        let key = Self::follow_key(&chat, &term);
        let id = uuid::Uuid::new_v4().to_string();
        let token = CancellationToken::new();
        if let Some((_, old)) = self
            .follows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.clone(), (id.clone(), token.clone()))
        {
            old.cancel();
        }
        let runtime = self.clone();
        tokio::spawn(async move {
            let config = network.config.clone();
            for _ in 0..FOLLOW_TICKS {
                tokio::select! {
                    _ = token.cancelled() => break,
                    _ = tokio::time::sleep(FOLLOW_INTERVAL) => {}
                }
                let (title, status, tail) = match actions::terminal_snapshot(&core, &term) {
                    Ok(value) => value,
                    Err(_) => {
                        let card = cards::terminal(
                            &config,
                            &term,
                            &term,
                            "exited",
                            "终端已关闭。",
                            false,
                            Some(&chat),
                        );
                        let _ = network.update_card(&message_id, &card).await;
                        break;
                    }
                };
                let card =
                    cards::terminal(&config, &term, &title, &status, &tail, true, Some(&chat));
                if network.update_card(&message_id, &card).await.is_err() {
                    break;
                }
                if status == "exited" {
                    break;
                }
            }
            let mut follows = runtime.follows.lock().unwrap_or_else(|e| e.into_inner());
            if follows.get(&key).is_some_and(|(current, _)| current == &id) {
                follows.remove(&key);
            }
        });
    }
    pub async fn start(
        self: &Arc<Self>,
        core: Core,
        config: Config,
        secret: Zeroizing<String>,
    ) -> Result<(), String> {
        let proxy = config.resolve_proxy(&core.state())?;
        let network = network::Network::new(config, secret, proxy)?;
        self.start_network(core, network).await
    }
    async fn start_network(
        self: &Arc<Self>,
        core: Core,
        network: network::Network,
    ) -> Result<(), String> {
        network.config.validate()?;
        if network.config.app_id.is_empty() || network.config.bindings.is_empty() {
            return Err("configure_app_and_identity_bindings".into());
        }
        let mut slot = self.lifecycle.lock().await;
        if slot.as_ref().is_some_and(|r| !r.task.is_finished()) {
            return Err("feishu_already_running_stop_before_reconfiguring".into());
        }
        actions::prepare(&core)?;
        let events = core.state().mobile.events.tasks.subscribe();
        let cancel = CancellationToken::new();
        let runtime = self.clone();
        let task_core = core.clone();
        let task_network = network.clone();
        let token = cancel.clone();
        self.state("connecting", None);
        let task = tokio::spawn(async move {
            worker::run(runtime, task_core, task_network, token, events).await;
        });
        *slot = Some(Running {
            cancel,
            task,
            network,
        });
        Ok(())
    }
    pub async fn stop(&self) {
        self.clear_follows();
        let mut slot = self.lifecycle.lock().await;
        if let Some(r) = slot.take() {
            r.cancel.cancel();
            let _ = r.task.await;
            // Best effort only: an abrupt process/network failure cannot notify
            // through the failed connection. Recovery remains visible in status.
            let chats: std::collections::HashSet<_> = r
                .network
                .config
                .bindings
                .iter()
                .map(|b| b.chat_id.clone())
                .collect();
            let notice = async {
                for chat in chats {
                    let _ = r
                        .network
                        .send(
                            &chat,
                            "text",
                            &serde_json::json!({"text":"Taomni 飞书适配器已停止，实例可能离线。"}),
                            &uuid::Uuid::new_v4().to_string(),
                        )
                        .await;
                }
            };
            let _ = tokio::time::timeout(std::time::Duration::from_secs(3), notice).await;
        }
        self.state("stopped", None);
    }
    pub async fn idle(&self) -> bool {
        self.lifecycle
            .lock()
            .await
            .as_ref()
            .is_none_or(|r| r.task.is_finished())
    }
}
#[cfg(test)]
mod tests;

#[cfg(test)]
mod terminal_tests;

#[cfg(test)]
mod network_tests;

#[cfg(test)]
mod commands_tests;

#[cfg(test)]
mod cards_tests;
