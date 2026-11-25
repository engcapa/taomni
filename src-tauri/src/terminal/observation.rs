//! Typed observations carry no feature-owned state and never own their observer.
use std::sync::{Arc, Mutex, Weak};

pub(crate) trait TerminalObserver: Send + Sync {
    fn output(&self, session_id: &str, bytes: &[u8]);
    fn exited(&self, session_id: &str, code: Option<u32>);
}

#[derive(Default)]
pub(crate) struct TerminalObservations(Mutex<Vec<Weak<dyn TerminalObserver>>>);

impl TerminalObservations {
    pub(crate) fn subscribe(&self, observer: &Arc<dyn TerminalObserver>) {
        self.0
            .lock()
            .expect("terminal observers poisoned")
            .push(Arc::downgrade(observer));
    }

    fn observers(&self) -> Vec<Arc<dyn TerminalObserver>> {
        let mut observers = self.0.lock().expect("terminal observers poisoned");
        let alive: Vec<_> = observers.iter().filter_map(Weak::upgrade).collect();
        observers.retain(|observer| observer.strong_count() != 0);
        alive
    }

    pub(crate) fn output(&self, session_id: &str, bytes: &[u8]) {
        for observer in self.observers() {
            observer.output(session_id, bytes);
        }
    }

    pub(crate) fn exited(&self, session_id: &str, code: Option<u32>) {
        for observer in self.observers() {
            observer.exited(session_id, code);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Observer(Mutex<Vec<String>>);
    impl TerminalObserver for Observer {
        fn output(&self, id: &str, bytes: &[u8]) {
            self.0
                .lock()
                .unwrap()
                .push(format!("{id}:{}", String::from_utf8_lossy(bytes)));
        }
        fn exited(&self, id: &str, code: Option<u32>) {
            self.0.lock().unwrap().push(format!("{id}:{code:?}"));
        }
    }
    #[test]
    fn observations_do_not_keep_feature_runtime_alive() {
        let observations = TerminalObservations::default();
        let observer = Arc::new(Observer::default());
        let typed: Arc<dyn TerminalObserver> = observer.clone();
        observations.subscribe(&typed);
        drop(typed);
        observations.output("pty", b"kept");
        observations.exited("pty", Some(7));
        assert_eq!(*observer.0.lock().unwrap(), ["pty:kept", "pty:Some(7)"]);
        let weak = Arc::downgrade(&observer);
        drop(observer);
        assert!(weak.upgrade().is_none());
        observations.output("pty", b"no observer");
        assert!(observations.0.lock().unwrap().is_empty());
    }
    struct Reentrant(Arc<TerminalObservations>);
    impl TerminalObserver for Reentrant {
        fn output(&self, _: &str, _: &[u8]) {
            assert!(
                self.0.0.try_lock().is_ok(),
                "subscriber called while registry locked"
            );
        }
        fn exited(&self, _: &str, _: Option<u32>) {}
    }
    #[test]
    fn observation_callbacks_run_outside_registry_lock() {
        let observations = Arc::new(TerminalObservations::default());
        let observer: Arc<dyn TerminalObserver> = Arc::new(Reentrant(observations.clone()));
        observations.subscribe(&observer);
        observations.output("pty", b"output");
    }
}
