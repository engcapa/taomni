use super::{Asr, AsrResult, StubAsr};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Manages the lifecycle of the active ASR engine:
/// - startup warm (load model into memory)
/// - idle unload (release RAM after inactivity)
/// - model download coordination (stub — real download in models::downloader)
pub struct AsrManager {
    engine: Arc<RwLock<Arc<dyn Asr>>>,
    warm_on_startup: bool,
}

impl AsrManager {
    pub fn new(warm_on_startup: bool) -> Self {
        Self {
            engine: Arc::new(RwLock::new(Arc::new(StubAsr))),
            warm_on_startup,
        }
    }

    /// Synchronously install an engine before the manager is shared.
    /// Used at startup when the runtime hasn't begun yet.
    pub fn set_engine_sync(&self, engine: Arc<dyn Asr>) {
        // RwLock::blocking_write is safe to call from sync context.
        let mut guard = self.engine.blocking_write();
        *guard = engine;
    }

    /// Replace the active engine (called when user changes ASR provider in settings).
    pub async fn set_engine(&self, engine: Arc<dyn Asr>) {
        let mut guard = self.engine.write().await;
        *guard = engine;
    }

    /// Get a reference to the current engine for transcription.
    pub async fn engine(&self) -> Arc<dyn Asr> {
        self.engine.read().await.clone()
    }

    /// Transcribe PCM audio using the current engine.
    pub async fn transcribe(&self, pcm: &[f32]) -> AsrResult<String> {
        let engine = self.engine().await;
        engine.transcribe(pcm).await
    }

    /// Returns true if the current engine is warm.
    pub async fn is_warm(&self) -> bool {
        self.engine().await.is_warm()
    }

    /// Unload the current engine (called on idle timeout).
    pub async fn unload(&self) {
        let engine = self.engine().await;
        engine.unload().await;
    }

    pub fn warm_on_startup(&self) -> bool {
        self.warm_on_startup
    }
}
