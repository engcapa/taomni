//! Stable per-turn notification identities also deduplicate snapshot reconciliation.
use super::{
    Runtime, actions,
    config::Config,
    worker::{Outbound, enqueue},
};
use crate::mobile::Core;
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use tokio::sync::mpsc;

#[derive(Default)]
pub struct Notifications {
    seen: HashSet<String>,
    order: VecDeque<String>,
}
impl Notifications {
    pub fn deliver(
        &mut self,
        runtime: &Runtime,
        core: &Core,
        config: &Config,
        output: &mpsc::Sender<Outbound>,
        event: &Value,
    ) {
        if event["type"] != "task_status" {
            return;
        }
        let status = event["status"].as_str().unwrap_or("");
        let summary = event["summary"].as_str().unwrap_or("");
        if status != "awaiting_confirmation"
            && !(status == "idle" && matches!(summary, "turn_finished" | "turn_failed" | "stopped"))
        {
            return;
        }
        let task = event["task_id"].as_str().unwrap_or("");
        let confirmations = if status == "awaiting_confirmation" {
            task.strip_prefix("thread:")
                .map(|tid| crate::mobile::agent_view::confirmations(&core.state(), tid))
                .unwrap_or_default()
        } else {
            vec![]
        };
        let turn = event["turn_id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| event["seq"].to_string());
        let transition = if status == "idle" {
            "terminal"
        } else {
            summary
        };
        let key = format!(
            "{task}:{turn}:{status}:{transition}:{}",
            confirmations
                .iter()
                .map(|c| c["id"].to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        if !self.seen.insert(key.clone()) {
            return;
        }
        self.order.push_back(key.clone());
        while self.order.len() > 1024 {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
        let chats: HashSet<_> = config.bindings.iter().map(|b| b.chat_id.clone()).collect();
        for chat in chats {
            let id = format!("{}:{key}:{chat}", runtime.instance);
            if confirmations.is_empty() {
                enqueue(
                    runtime,
                    output,
                    Outbound::text(
                        chat,
                        format!(
                            "{}{}",
                            actions::bounded(&format!("Taomni {task} · {status}\n{summary}")),
                            actions::link(config)
                        ),
                        &id,
                    ),
                );
            } else {
                for confirmation in &confirmations {
                    enqueue(
                        runtime,
                        output,
                        Outbound {
                            chat: chat.clone(),
                            kind: "interactive",
                            content: actions::confirmation_card(config, task, confirmation),
                            uuid: actions::key(&format!("{id}:{}", confirmation["id"]))[..32]
                                .into(),
                        },
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn each_turn_has_exactly_one_terminal_notification_even_after_reconciliation() {
        let fixture = crate::mobile::service_tests::Fixture::new().await;
        let core = Core::Headless(fixture.state.clone());
        let mut notifications = Notifications::default();
        let (tx, mut rx) = mpsc::channel(16);
        let runtime = Runtime::default();
        let config = super::super::tests::config();
        for (turn, summary) in [
            ("one", "stopped"),
            ("one", "stopped"),
            ("one", "turn_finished"),
            ("two", "turn_finished"),
            ("two", "turn_finished"),
        ] {
            notifications.deliver(&runtime, &core, &config, &tx, &serde_json::json!({"type":"task_status","task_id":"thread:t","turn_id":turn,"status":"idle","summary":summary}));
        }
        let first = rx.try_recv().unwrap();
        let second = rx.try_recv().unwrap();
        assert_ne!(first.uuid, second.uuid);
        assert!(rx.try_recv().is_err());
        fixture.finish().await;
    }
}
