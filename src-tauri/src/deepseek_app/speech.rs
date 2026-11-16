//! Optional DeepSeek speech; local ASR/TTS defaults are owned by existing voice.
use super::{client::MessagesClient, runtime::RunGuard};
use crate::state::AppState;
use futures::StreamExt;
use serde_json::{Value, json};
use tauri::{State, ipc::Channel};

#[tauri::command]
pub async fn deepseek_app_asr(
    audio: Vec<u8>,
    mime: String,
    duration_ms: u64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if audio.len() > 8 * 1024 * 1024
        || audio.is_empty()
        || duration_ms == 0
        || duration_ms > 120_000
    {
        return Err("audio: recording must be at most 120 seconds and 8 MiB".into());
    }
    if !matches!(mime.as_str(), "audio/wav" | "audio/ogg") {
        return Err("audio: use PCM WAV or Ogg Opus".into());
    }
    if mime == "audio/wav" {
        validate_wav(&audio)?;
    }
    let client = MessagesClient::resolve(&state).await?;
    let run = RunGuard::begin("tao-asr")?;
    let name = if mime == "audio/wav" {
        "audio.wav"
    } else {
        "audio.ogg"
    };
    let part = reqwest::multipart::Part::bytes(audio)
        .file_name(name)
        .mime_str(&mime)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part);
    tokio::select! {
        _=run.cancel.cancelled()=>Err(format!("{}: transcription cancelled",run.reason())),
        result=async {
            let response=client.http.post(format!("{}/v1/tools/asr",client.base_url))
                .bearer_auth(&client.api_key).multipart(form).send().await.map_err(|_|"network: transcription failed")?;
            if !response.status().is_success(){return Err(format!("http: transcription returned HTTP {}",response.status().as_u16()));}
            let value:Value=response.json().await.map_err(|_|"protocol: invalid transcription response")?;
            value["text"].as_str().or_else(||value["data"]["text"].as_str()).map(str::to_owned)
                .ok_or_else(||"protocol: transcription text missing".into())
        }=>result,
    }
}

#[tauri::command]
pub async fn deepseek_app_tts(
    text: String,
    voice_id: String,
    on_audio: Channel<Vec<u8>>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if text.trim().is_empty() || text.len() > 100_000 {
        return Err("audio: choose nonempty text under 100 kB".into());
    }
    if !matches!(voice_id.as_str(), "stella" | "tide") {
        return Err("audio: unsupported voice".into());
    }
    let client = MessagesClient::resolve(&state).await?;
    let run = RunGuard::begin("tao-tts")?;
    tokio::select! {
        _=run.cancel.cancelled()=>Err(format!("{}: playback cancelled",run.reason())),
        result=async {
            let response=client.http.post(format!("{}/v1/tools/tts",client.base_url)).bearer_auth(&client.api_key)
                .json(&json!({"text":text,"voice_id":voice_id,"format":"pcm","filter_markdown":true}))
                .send().await.map_err(|_|"network: speech synthesis failed")?;
            if !response.status().is_success(){return Err(format!("http: speech synthesis returned HTTP {}",response.status().as_u16()));}
            let mut stream=response.bytes_stream();let mut bytes=0u64;
            while let Some(chunk)=stream.next().await {
                let chunk=chunk.map_err(|_|"network: speech audio interrupted")?;
                bytes+=chunk.len() as u64;if bytes>32*1024*1024{return Err("audio: response exceeds safe audio limit".into());}
                on_audio.send(chunk.to_vec()).map_err(|_|"interrupted: audio consumer closed")?;
            }
            Ok(json!({"sampleRate":24000,"channels":1,"bitsPerSample":16,"bytes":bytes}))
        }=>result,
    }
}

fn validate_wav(audio: &[u8]) -> Result<(), String> {
    if audio.len() < 44 || &audio[..4] != b"RIFF" || &audio[8..12] != b"WAVE" {
        return Err("audio: invalid WAV".into());
    }
    let mut offset = 12usize;
    let mut format = false;
    let mut data_size = 0u64;
    while offset + 8 <= audio.len() {
        let size = u32::from_le_bytes(audio[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let start = offset + 8;
        let end = start.checked_add(size).ok_or("audio: invalid WAV size")?;
        if end > audio.len() {
            return Err("audio: truncated WAV".into());
        }
        if &audio[offset..offset + 4] == b"fmt " {
            if size < 16 {
                return Err("audio: missing PCM format".into());
            }
            let encoding = u16::from_le_bytes(audio[start..start + 2].try_into().unwrap());
            let channels = u16::from_le_bytes(audio[start + 2..start + 4].try_into().unwrap());
            let rate = u32::from_le_bytes(audio[start + 4..start + 8].try_into().unwrap());
            let depth = u16::from_le_bytes(audio[start + 14..start + 16].try_into().unwrap());
            if encoding != 1 || channels != 1 || depth != 16 || rate == 0 {
                return Err("audio: WAV must be mono 16-bit PCM".into());
            }
            if data_size > 0 && data_size / (rate as u64 * 2) > 120 {
                return Err("audio: WAV exceeds 120 seconds".into());
            }
            format = true;
        }
        if &audio[offset..offset + 4] == b"data" {
            data_size += size as u64;
        }
        offset = end + (size % 2);
    }
    if !format || data_size == 0 {
        return Err("audio: WAV has no PCM samples".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_audio_before_network() {
        assert!(validate_wav(b"not audio").is_err());
    }
}
