// Voice/PTT (push-to-talk) capture pipeline.
//
// Flow:
// 1. User presses PTT button → frontend invokes `voice_start_capture`
// 2. cpal opens default microphone, accumulates 16-kHz mono f32 PCM
// 3. User releases PTT → frontend invokes `voice_stop_and_transcribe`
// 4. PCM is fed to AsrManager → text → routed through LlmRouter VoiceIntent
// 5. Transcript + intent are returned to the frontend (and audited)
//
// In the v2.0 scaffolding the cpal capture only runs when the `voice-capture`
// feature is enabled. Without it, the commands return a clear error so the
// frontend can show a "voice support not built" hint without crashing.
//
// ASR engines (sherpa-onnx etc.) integrate through asr::Asr; this module is
// transport-agnostic and never imports asr::* directly — it only goes through
// the AsrManager held in AppAiCtx.

#[cfg(feature = "voice-capture")]
pub mod capture;
pub mod commands;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceTranscriptResult {
    pub transcript: String,
    pub duration_ms: u64,
    /// Optional intent JSON returned by the LLM (when `route_intent=true`).
    pub intent_json: Option<String>,
}
