//! Agent process reaping retains active-turn ownership and is cancellable.
use crate::state::AppState;
use std::collections::HashSet;
use tauri::Manager;
const AI_PROCESS_REAPER_INTERVAL_SECS: u64 = 30;
const AI_PROCESS_IDLE_REAP_SECS: u64 = 300;
pub(super) fn should_reap_ai_process(
    chat_turn_active: bool,
    process_turn_active: bool,
    idle_secs: u64,
) -> bool {
    !chat_turn_active && !process_turn_active && idle_secs >= AI_PROCESS_IDLE_REAP_SECS
}
pub(super) async fn run(
    handle_for_reaper: tauri::AppHandle,
    cancel: tokio_util::sync::CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = tokio::time::sleep(std::time::Duration::from_secs(AI_PROCESS_REAPER_INTERVAL_SECS)) => {}
        }
        let state = handle_for_reaper.state::<AppState>();
        let active_chat_threads: HashSet<String> = state
            .core
            .agent
            .chat_runs
            .lock()
            .await
            .keys()
            .cloned()
            .collect();
        let mut registry = state.core.agent.cc_processes.lock().await;
        let now = std::time::Instant::now();
        let mut to_remove = Vec::new();
        for (thread_id, proc) in registry.iter() {
            let last_active = *proc.last_active_at.lock().unwrap();
            if should_reap_ai_process(
                active_chat_threads.contains(thread_id),
                proc.is_turn_active(),
                now.duration_since(last_active).as_secs(),
            ) {
                to_remove.push(thread_id.clone());
            }
        }
        let removed: Vec<_> = to_remove
            .into_iter()
            .filter_map(|tid| registry.remove(&tid))
            .collect();
        drop(registry);
        for process in removed {
            process.stop().await;
        }

        let mut codex_registry = state.core.agent.codex_processes.lock().await;
        let mut codex_to_remove = Vec::new();
        for (thread_id, proc) in codex_registry.iter() {
            let last_active = *proc.last_active_at.lock().unwrap();
            if should_reap_ai_process(
                active_chat_threads.contains(thread_id),
                proc.is_turn_active(),
                now.duration_since(last_active).as_secs(),
            ) {
                codex_to_remove.push(thread_id.clone());
            }
        }
        let removed: Vec<_> = codex_to_remove
            .into_iter()
            .filter_map(|tid| codex_registry.remove(&tid))
            .collect();
        drop(codex_registry);
        for process in removed {
            process.stop().await;
        }

        let mut acp_registry = state.core.agent.acp_processes.lock().await;
        let mut acp_to_remove = Vec::new();
        for (thread_id, proc) in acp_registry.iter() {
            if should_reap_ai_process(
                active_chat_threads.contains(thread_id),
                proc.is_turn_active(),
                now.saturating_duration_since(proc.last_active_at())
                    .as_secs(),
            ) {
                acp_to_remove.push(thread_id.clone());
            }
        }
        let removed: Vec<_> = acp_to_remove
            .into_iter()
            .filter_map(|tid| acp_registry.remove(&tid))
            .collect();
        drop(acp_registry);
        for process in removed {
            process.stop().await;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn active_turns_survive_the_idle_window() {
        assert!(!should_reap_ai_process(
            false,
            false,
            AI_PROCESS_IDLE_REAP_SECS - 1
        ));
        assert!(should_reap_ai_process(
            false,
            false,
            AI_PROCESS_IDLE_REAP_SECS
        ));
        assert!(!should_reap_ai_process(
            true,
            false,
            AI_PROCESS_IDLE_REAP_SECS
        ));
        assert!(!should_reap_ai_process(
            false,
            true,
            AI_PROCESS_IDLE_REAP_SECS
        ));
        assert!(!should_reap_ai_process(
            true,
            true,
            AI_PROCESS_IDLE_REAP_SECS
        ));
    }
}
