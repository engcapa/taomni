//! One owner for a thread's reservation, including spawn cancellation and panic.
use super::MobileRuntime;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Turn {
    pub id: String,
    pub cancel: CancellationToken,
    pub failed: Arc<AtomicBool>,
}
pub struct TurnGuard {
    runtime: Arc<MobileRuntime>,
    thread: String,
    pub turn: Turn,
    runs: Option<Arc<crate::chat::run::ChatRunRegistry>>,
    completed: bool,
}
impl TurnGuard {
    pub fn reserve(runtime: &Arc<MobileRuntime>, thread: &str) -> Result<Self, String> {
        let mut turns = runtime
            .pending_turns
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if turns.contains_key(thread) {
            return Err("turn_in_progress".into());
        }
        let turn = Turn {
            id: uuid::Uuid::new_v4().to_string(),
            cancel: CancellationToken::new(),
            failed: Arc::new(AtomicBool::new(false)),
        };
        turns.insert(thread.into(), turn.clone());
        let mut tools = runtime.tools.lock().unwrap_or_else(|e| e.into_inner());
        if tools.len() >= 200 {
            tools.clear();
        }
        tools.insert(thread.into(), Vec::new());
        Ok(Self {
            runtime: runtime.clone(),
            thread: thread.into(),
            turn,
            runs: None,
            completed: false,
        })
    }
    pub fn bind_runs(&mut self, runs: Arc<crate::chat::run::ChatRunRegistry>) {
        self.runs = Some(runs);
    }
    pub fn finish(&mut self) {
        self.completed = true;
    }
    pub fn failed(&self) -> bool {
        self.turn.failed.load(Ordering::Relaxed)
    }
}
fn release(runtime: &MobileRuntime, thread: &str, turn: &str) {
    let mut turns = runtime
        .pending_turns
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if turns.get(thread).is_some_and(|t| t.id == turn) {
        turns.remove(thread);
    }
}
impl Drop for TurnGuard {
    fn drop(&mut self) {
        self.turn.cancel.cancel();
        if !self.completed {
            self.runtime
                .task_status(&self.thread, "idle", "turn_failed");
        }
        if let Some(calls) = self
            .runtime
            .tools
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&self.thread)
        {
            for call in calls {
                if call["status"] == "running" {
                    call["status"] = serde_json::json!(if self.completed {
                        "completed"
                    } else {
                        "interrupted"
                    });
                }
            }
        }
        if let Some(runs) = self.runs.take() {
            // Keep the reservation until process cancellation finishes. A new
            // turn must never race cleanup of the previous bridge process.
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let runtime = self.runtime.clone();
                let thread = self.thread.clone();
                let id = self.turn.id.clone();
                if let Ok(mut registry) = runs.try_lock() {
                    if let Some(run) = registry.remove(&thread) {
                        handle.spawn(async move {
                            run.stop().await;
                            release(&runtime, &thread, &id);
                        });
                        return;
                    }
                } else {
                    let cleanup_runs = runs.clone();
                    handle.spawn(async move {
                        let run = cleanup_runs.lock().await.remove(&thread);
                        if let Some(run) = run {
                            run.stop().await;
                        }
                        release(&runtime, &thread, &id);
                    });
                    return;
                }
            }
        }
        release(&self.runtime, &self.thread, &self.turn.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn aborted_or_panicking_turn_releases_the_reservation() {
        let runtime = Arc::new(MobileRuntime::default());
        let guard = TurnGuard::reserve(&runtime, "t").unwrap();
        assert!(TurnGuard::reserve(&runtime, "t").is_err());
        let task = tokio::spawn(async move {
            let _guard = guard;
            std::future::pending::<()>().await;
        });
        task.abort();
        let _ = task.await;
        let guard = TurnGuard::reserve(&runtime, "t").unwrap();
        let _ = tokio::spawn(async move {
            let _guard = guard;
            panic!("test panic");
        })
        .await;
        assert!(TurnGuard::reserve(&runtime, "t").is_ok());
    }
}
