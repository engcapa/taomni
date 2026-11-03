//! Per-thread startup observation and cancellation, scoped by the caller.
//! Unobserved RDP/recording captures retain their normal lifecycle.

use std::cell::Cell;
use std::cell::RefCell;
use std::future::Future;
use tokio_util::sync::CancellationToken;

thread_local! {
    static OBSERVER: Cell<Option<fn(&str)>> = const { Cell::new(None) };
    static CANCELLATION: RefCell<Option<CancellationToken>> = const { RefCell::new(None) };
}

/// Run `f` with this thread's backend milestones observed.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn observe<R>(observer: fn(&str), f: impl FnOnce() -> R) -> R {
    struct Reset(Option<fn(&str)>);
    impl Drop for Reset {
        fn drop(&mut self) {
            OBSERVER.with(|cell| cell.set(self.0));
        }
    }
    let _reset = Reset(OBSERVER.with(|cell| cell.replace(Some(observer))));
    f()
}

/// Scope cancellation to this capture constructor/operation on its owning thread.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn observe_cancellable<R>(
    observer: fn(&str),
    cancel: CancellationToken,
    f: impl FnOnce() -> R,
) -> R {
    struct Reset(Option<CancellationToken>);
    impl Drop for Reset {
        fn drop(&mut self) {
            CANCELLATION.with(|cell| *cell.borrow_mut() = self.0.take());
        }
    }
    let _reset = Reset(CANCELLATION.with(|cell| cell.replace(Some(cancel))));
    observe(observer, f)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn check_cancelled() -> anyhow::Result<()> {
    if CANCELLATION.with(|cell| cell.borrow().as_ref().is_some_and(|c| c.is_cancelled())) {
        anyhow::bail!("screenshot opening was cancelled");
    }
    Ok(())
}

/// Await portal authorization on its constructor's current-thread runtime.
/// The session owner closes the session if this interrupts an operation.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) async fn cancellable<T>(
    operation: impl Future<Output = anyhow::Result<T>>,
) -> anyhow::Result<T> {
    let cancel = CANCELLATION.with(|cell| cell.borrow().clone());
    match cancel {
        Some(cancel) => tokio::select! {
            biased;
            _ = cancel.cancelled() => anyhow::bail!("screenshot opening was cancelled"),
            result = operation => result,
        },
        None => operation.await,
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn mark(stage: &str) {
    if let Some(observer) = OBSERVER.with(Cell::get) {
        observer(stage);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

    fn record(stage: &str) {
        SEEN.lock().unwrap().push(stage.to_string());
    }

    #[test]
    fn marks_reach_only_the_installed_observer_on_this_thread() {
        mark("before");
        let value = observe(record, || {
            mark("inside");
            std::thread::spawn(|| mark("other-thread")).join().unwrap();
            7
        });
        mark("after");
        assert_eq!(value, 7);
        assert_eq!(*SEEN.lock().unwrap(), vec!["inside".to_string()]);
    }

    #[test]
    fn cancellation_is_scoped_nested_and_not_inherited_by_other_threads() {
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        observe_cancellable(
            |_| {},
            cancelled,
            || {
                assert!(check_cancelled().is_err());
                std::thread::spawn(|| assert!(check_cancelled().is_ok()))
                    .join()
                    .unwrap();
                observe_cancellable(
                    |_| {},
                    CancellationToken::new(),
                    || {
                        assert!(check_cancelled().is_ok());
                    },
                );
                assert!(check_cancelled().is_err());
            },
        );
        assert!(check_cancelled().is_ok());
    }

    #[test]
    fn pending_authorization_is_interrupted_and_dropped_before_returning() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let token = CancellationToken::new();
        let worker = token.clone();
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct Dropped(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        observe_cancellable(
            |_| {},
            token,
            || {
                runtime.block_on(async {
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        worker.cancel();
                    });
                    let pending = async {
                        let _owned = Dropped(dropped.clone());
                        std::future::pending::<anyhow::Result<()>>().await
                    };
                    let result =
                        tokio::time::timeout(Duration::from_secs(1), cancellable(pending)).await;
                    assert!(result.unwrap().is_err());
                    assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
                })
            },
        );
    }

    #[tokio::test]
    async fn unobserved_operations_are_not_cancelled() {
        assert_eq!(cancellable(async { Ok(7) }).await.unwrap(), 7);
    }
}
