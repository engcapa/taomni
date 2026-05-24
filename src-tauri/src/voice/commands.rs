// Tauri commands for the voice/PTT pipeline.

use super::VoiceTranscriptResult;
use crate::llm::{ChatMessage, ChatRequest, TaskKind};
use crate::state::AppState;
use std::time::Instant;
use tauri::State;

#[tauri::command]
pub async fn voice_capture_supported() -> bool {
    cfg!(feature = "voice-capture")
}

/// Start microphone capture (PTT pressed).
#[tauri::command]
pub async fn voice_start_capture() -> Result<u32, String> {
    #[cfg(feature = "voice-capture")]
    {
        return super::capture::start();
    }
    #[cfg(not(feature = "voice-capture"))]
    {
        Err("voice-capture feature not built (rebuild with --features voice-capture)".into())
    }
}

/// Stop microphone capture and return the captured PCM size (debugging).
#[tauri::command]
pub async fn voice_stop_capture() -> Result<usize, String> {
    #[cfg(feature = "voice-capture")]
    {
        let pcm = super::capture::stop()?;
        return Ok(pcm.len());
    }
    #[cfg(not(feature = "voice-capture"))]
    {
        Err("voice-capture feature not built".into())
    }
}

/// Stop capture, transcribe via the active ASR engine, and optionally route
/// the transcript through the LLM as a voice intent.
#[tauri::command]
pub async fn voice_stop_and_transcribe(
    route_intent: bool,
    state: State<'_, AppState>,
) -> Result<VoiceTranscriptResult, String> {
    let started = Instant::now();

    let pcm: Vec<f32> = {
        #[cfg(feature = "voice-capture")]
        {
            super::capture::stop()?
        }
        #[cfg(not(feature = "voice-capture"))]
        {
            return Err("voice-capture feature not built".into());
        }
    };

    if pcm.is_empty() {
        return Err("No audio captured".into());
    }

    // Transcribe via the configured ASR engine.
    let ai_ctx = state.ai_ctx.read().await;
    if ai_ctx.config.fully_disabled {
        return Err("AI is fully disabled.".into());
    }
    let transcript = ai_ctx
        .asr
        .transcribe(&pcm)
        .await
        .map_err(|e| e.to_string())?;

    if !route_intent {
        return Ok(VoiceTranscriptResult {
            transcript,
            duration_ms: started.elapsed().as_millis() as u64,
            intent_json: None,
        });
    }

    // Voice intent: ask the LLM to classify the transcript as one of a few
    // tools, returning JSON. Keep this minimal — the rich intent dispatcher
    // belongs in the next iteration.
    let req = ChatRequest {
        messages: vec![
            ChatMessage::system(
                "你是 NewMob 终端管理器的语音意图分类器。把用户的语音转写映射到一个工具调用。\n\
                 工具列表：list_sessions、switch_tab、search_history、explain_error、\n\
                 generate_shell_command、none（普通对话）。\n\
                 只返回一段 JSON：{\"tool\":\"<name>\",\"args\":{...}}。",
            ),
            ChatMessage::user(transcript.clone()),
        ],
        max_tokens: Some(200),
        temperature: Some(0.1),
        stream: false,
    };

    let intent_json = match ai_ctx.llm.complete(req, TaskKind::VoiceIntent).await {
        Ok(resp) => Some(resp.content),
        Err(e) => {
            tracing::warn!(?e, "voice intent classification failed");
            None
        }
    };

    Ok(VoiceTranscriptResult {
        transcript,
        duration_ms: started.elapsed().as_millis() as u64,
        intent_json,
    })
}
