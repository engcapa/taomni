use crate::asr::catalog;
use serde::Serialize;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

pub(super) static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Serialize, Debug)]
pub struct InstallationProgress {
    pub(super) revision: u64,
    pub(super) job_id: String,
    pub(super) model_id: String,
    pub(super) bytes: u64,
    pub(super) total: u64,
    pub(super) phase: &'static str,
    pub(super) error: Option<String>,
}
#[derive(Default)]
pub(super) struct InstallationTracker(pub(super) std::sync::Mutex<Option<InstallationProgress>>);
impl InstallationTracker {
    pub(super) fn snapshot(&self) -> Option<InstallationProgress> {
        self.0.lock().unwrap().clone()
    }
    pub(super) fn update(
        &self,
        model: &catalog::Model,
        job_id: &str,
        phase: &'static str,
        bytes: u64,
        error: Option<String>,
    ) -> InstallationProgress {
        let mut current = self.0.lock().unwrap();
        let next = InstallationProgress {
            revision: current.as_ref().map_or(1, |p| p.revision + 1),
            job_id: job_id.into(),
            model_id: model.id.into(),
            bytes: bytes.min(bundle_bytes(model)),
            total: bundle_bytes(model),
            phase,
            error,
        };
        *current = Some(next.clone());
        next
    }
}
pub(super) static INSTALLATION: InstallationTracker =
    InstallationTracker(std::sync::Mutex::new(None));
/// Retained in the backend, independently of the initiating window/component.
#[tauri::command]
pub fn voice_model_installation() -> Option<InstallationProgress> {
    INSTALLATION.snapshot()
}
pub(super) static CANCELLATION: std::sync::Mutex<Option<(String, CancellationToken)>> =
    std::sync::Mutex::new(None);
#[tauri::command]
pub fn voice_cancel_model_installation(job_id: String) {
    if let Some((current, token)) = CANCELLATION.lock().unwrap().as_ref() {
        if current == &job_id {
            token.cancel();
        }
    }
}
#[tauri::command]
pub fn voice_cancel_sherpa_model_installation(job_id: String) {
    voice_cancel_model_installation(job_id);
}
pub(super) fn bundle_bytes(model: &catalog::Model) -> u64 {
    model.bytes
        + if model.id == "sensevoice-small" {
            catalog::SENSE_TOKENS.bytes
        } else {
            0
        }
}

pub(super) struct InstallationReporter<'a> {
    pub(super) app: &'a tauri::AppHandle,
    pub(super) model: &'static catalog::Model,
    pub(super) job_id: String,
    pub(super) bytes: u64,
    pub(super) offset: u64,
    pub(super) finished: bool,
}
impl InstallationReporter<'_> {
    pub(super) fn report(&mut self, phase: &'static str, bytes: u64, error: Option<String>) {
        self.bytes = bytes;
        self.finished = matches!(phase, "complete" | "failed" | "cancelled");
        let progress =
            INSTALLATION.update(self.model, &self.job_id, phase, bytes + self.offset, error);
        let _ = self.app.emit("voice-model-progress", progress);
    }
}
impl Drop for InstallationReporter<'_> {
    fn drop(&mut self) {
        let mut cancellation = CANCELLATION.lock().unwrap();
        if cancellation
            .as_ref()
            .is_some_and(|(id, _)| id == &self.job_id)
        {
            cancellation.take();
        }
        if !self.finished {
            self.report(
                "failed",
                self.bytes,
                Some("Model installation interrupted".into()),
            );
        }
    }
}
