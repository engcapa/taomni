//! Cloneable log ownership for capture workers.

use std::sync::Arc;

/// A capture consumer decides where its diagnostics belong.
pub trait CaptureLog: Send + Sync {
    fn line(&self, message: String);
}

impl<F: Fn(String) + Send + Sync> CaptureLog for F {
    fn line(&self, message: String) {
        self(message);
    }
}

#[derive(Clone)]
pub struct CaptureLogger(Arc<dyn CaptureLog>);

impl CaptureLogger {
    pub fn new(sink: impl CaptureLog + 'static) -> Self {
        Self(Arc::new(sink))
    }
    pub fn line(&self, message: impl Into<String>) {
        self.0.line(message.into());
    }
    pub fn silent() -> Self {
        Self::new(|_| {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn cloned_workers_retain_the_same_sink_without_an_application_handle() {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let observed = lines.clone();
        let log = CaptureLogger::new(move |message| observed.lock().unwrap().push(message));
        let worker = log.clone();
        drop(log);
        worker.line("capture ready");
        assert_eq!(*lines.lock().unwrap(), ["capture ready"]);
    }
}
