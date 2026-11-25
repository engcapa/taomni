//! Named background jobs have application ownership and bounded shutdown.
use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

struct Task {
    name: &'static str,
    handle: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub(crate) struct RuntimeTasks {
    cancel: CancellationToken,
    tasks: Mutex<Vec<Task>>,
}
impl RuntimeTasks {
    pub(crate) fn cancellation(&self) -> CancellationToken {
        self.cancel.clone()
    }

    pub(crate) fn spawn(
        &self,
        name: &'static str,
        future: impl Future<Output = ()> + Send + 'static,
    ) {
        let mut tasks = self.tasks.lock().expect("runtime task registry poisoned");
        if self.cancel.is_cancelled() {
            return;
        }
        tasks.push(Task {
            name,
            handle: tauri::async_runtime::spawn(future),
        });
    }

    pub(crate) fn spawn_blocking(&self, name: &'static str, work: impl FnOnce() + Send + 'static) {
        let mut tasks = self.tasks.lock().expect("runtime task registry poisoned");
        if self.cancel.is_cancelled() {
            return;
        }
        tasks.push(Task {
            name,
            handle: tauri::async_runtime::spawn_blocking(work),
        });
    }

    pub(crate) async fn shutdown(&self) {
        self.cancel.cancel();
        let mut tasks =
            std::mem::take(&mut *self.tasks.lock().expect("runtime task registry poisoned"));
        let deadline = Instant::now() + Duration::from_secs(5);
        for task in &mut tasks {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if tokio::time::timeout(remaining, &mut task.handle)
                .await
                .is_err()
            {
                tracing::warn!(
                    task = task.name,
                    "Background task exceeded shutdown deadline"
                );
                task.handle.abort();
                let _ = (&mut task.handle).await;
            }
        }
    }
}
impl Drop for RuntimeTasks {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Ok(tasks) = self.tasks.get_mut() {
            for task in tasks.drain(..) {
                task.handle.abort();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    #[tokio::test]
    async fn shutdown_cancels_and_joins_owned_work_and_rejects_new_jobs() {
        let tasks = RuntimeTasks::default();
        let finished = Arc::new(AtomicBool::new(false));
        let done = finished.clone();
        let cancel = tasks.cancellation();
        tasks.spawn("unit-cancel", async move {
            cancel.cancelled().await;
            done.store(true, Ordering::Release);
        });
        tasks.shutdown().await;
        assert!(finished.load(Ordering::Acquire));
        tasks.spawn("after-stop", async {
            panic!("new work after shutdown");
        });
        assert!(tasks.tasks.lock().unwrap().is_empty());
        tasks.shutdown().await;
    }
}
