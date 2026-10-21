use super::events::TranscriptEvent;
use super::events::TranscriptSink;
use super::events::emit;
use super::events::pcm16;
use super::transport::connect_ws;
use super::transport::ws_request;
use crate::proxy::ResolvedProxy;
use base64::Engine;
use futures::SinkExt;
use futures::StreamExt;
use url::Url;

pub(super) async fn run_deepgram(
    app: TranscriptSink,
    session_id: String,
    chunks: &mut tokio::sync::mpsc::Receiver<Vec<f32>>,
    model: &str,
    endpoint: &str,
    api_key: &str,
    language: &str,
    started: std::time::Instant,
    proxy: Option<&ResolvedProxy>,
    hotwords: &[String],
) -> Result<(), String> {
    let mut url = Url::parse(endpoint).map_err(|_| "ASR_WS_URL: invalid Deepgram endpoint")?;
    {
        let mut query = url.query_pairs_mut();
        query.extend_pairs([
            ("model", model),
            ("encoding", "linear16"),
            ("sample_rate", "16000"),
            ("channels", "1"),
            ("interim_results", "true"),
            ("endpointing", "300"),
            (
                "language",
                if language == "auto" {
                    "multi"
                } else {
                    language
                },
            ),
        ]);
        for word in hotwords {
            query.append_pair("keyterm", word);
        }
    }
    let req = ws_request(
        url.as_str(),
        &[("Authorization", &format!("Token {api_key}"))],
    )?;
    let (mut ws, _) = connect_ws(req, proxy).await?;
    let mut finishing = false;
    loop {
        tokio::select! {
            chunk = chunks.recv(), if !finishing => match chunk {
                    Some(chunk) => ws.send(tungstenite::Message::Binary(pcm16(&chunk).into())).await.map_err(|e| format!("ASR_SEND: {e}"))?,
                None => { finishing = true; ws.send(tungstenite::Message::Text(r#"{"type":"CloseStream"}"#.into())).await.map_err(|_| "ASR_SEND: cannot finalize stream")?; }
            },
            msg = ws.next() => match msg {
                Some(Ok(tungstenite::Message::Text(text))) => {
                    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                    if value.get("type").and_then(|v| v.as_str()) == Some("Error") { return Err("ASR_PROVIDER: Deepgram rejected the stream".into()); }
                    if finishing && value.get("type").and_then(|v| v.as_str()) == Some("Metadata") { break; }
                    let text = value.pointer("/channel/alternatives/0/transcript").and_then(|v| v.as_str()).unwrap_or("");
                    if !text.is_empty() { emit(&app, TranscriptEvent { session_id: session_id.clone(), text: text.into(), final_text: value.get("is_final").and_then(|v| v.as_bool()).unwrap_or(false), processing_ms: started.elapsed().as_millis() as u64, provider: "deepgram".into() }); }
                }
                Some(Ok(tungstenite::Message::Close(_))) | None => return Err("ASR_RECEIVE: Deepgram closed before final acknowledgement".into()),
                Some(Err(e)) => return Err(format!("ASR_RECEIVE: {e}")),
                _ => {}
            }
        }
    }
    Ok(())
}

pub(super) async fn run_gemini(
    app: TranscriptSink,
    session_id: String,
    chunks: &mut tokio::sync::mpsc::Receiver<Vec<f32>>,
    model: &str,
    endpoint: &str,
    api_key: &str,
    language: &str,
    started: std::time::Instant,
    proxy: Option<&ResolvedProxy>,
) -> Result<(), String> {
    let url = format!("{}?key={}", endpoint, urlencoding::encode(api_key));
    let req = ws_request(&url, &[])?;
    let (mut ws, _) = connect_ws(req, proxy).await?;
    let setup = serde_json::json!({"setup":{"model":format!("models/{model}"),"generationConfig":{"responseModalities":["TEXT"]},"inputAudioTranscription":{"languageCodes":if language == "auto" { Vec::<String>::new() } else { vec![language.to_string()] }}}});
    ws.send(tungstenite::Message::Text(setup.to_string().into()))
        .await
        .map_err(|e| format!("ASR_SETUP: {e}"))?;
    loop {
        tokio::select! {
            chunk = chunks.recv() => match chunk {
                Some(chunk) => { let data = base64::engine::general_purpose::STANDARD.encode(pcm16(&chunk)); let msg = serde_json::json!({"realtimeInput":{"audio":{"data":data,"mimeType":"audio/pcm;rate=16000"}}}); ws.send(tungstenite::Message::Text(msg.to_string().into())).await.map_err(|e| format!("ASR_SEND: {e}"))?; }
                None => { let msg = serde_json::json!({"realtimeInput":{"audioStreamEnd":true}}); let _ = ws.send(tungstenite::Message::Text(msg.to_string().into())).await; break; }
            },
            msg = ws.next() => match msg {
                Some(Ok(tungstenite::Message::Text(text))) => {
                    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                    let content = value.get("serverContent").unwrap_or(&serde_json::Value::Null);
                    for (path, final_text) in [("interimInputTranscription", false), ("inputTranscription", true)] {
                        if let Some(text) = content.get(path).and_then(|v| v.get("text")).and_then(|v| v.as_str()) { if !text.is_empty() { emit(&app, TranscriptEvent { session_id: session_id.clone(), text: text.into(), final_text, processing_ms: started.elapsed().as_millis() as u64, provider: "gemini".into() }); } }
                    }
                }
                Some(Ok(tungstenite::Message::Close(_))) | None => break,
                Some(Err(e)) => return Err(format!("ASR_RECEIVE: {e}")),
                _ => {}
            }
        }
    }
    Ok(())
}

pub(super) async fn run_aliyun(
    app: TranscriptSink,
    session_id: String,
    chunks: &mut tokio::sync::mpsc::Receiver<Vec<f32>>,
    model: &str,
    endpoint: &str,
    api_key: &str,
    language: &str,
    started: std::time::Instant,
    proxy: Option<&ResolvedProxy>,
    vocabulary: &str,
) -> Result<(), String> {
    let req = ws_request(
        endpoint,
        &[
            ("Authorization", &format!("bearer {api_key}")),
            ("X-DashScope-DataInspection", "enable"),
        ],
    )?;
    let (mut ws, _) = connect_ws(req, proxy).await?;
    let task_id = uuid::Uuid::new_v4().to_string();
    let mut run = serde_json::json!({"header":{"action":"run-task","task_id":task_id,"streaming":"duplex"},"payload":{"task_group":"audio","task":"asr","function":"recognition","input":{},"model":model,"parameters":{"sample_rate":16000,"format":"pcm","language_hints":if language == "auto" { vec!["zh","en"] } else { vec![language] }}}});
    if !vocabulary.is_empty() {
        run["payload"]["parameters"]["vocabulary_id"] = vocabulary.into();
    }
    ws.send(tungstenite::Message::Text(run.to_string().into()))
        .await
        .map_err(|e| format!("ASR_SETUP: {e}"))?;
    let mut ready = false;
    let mut finishing = false;
    loop {
        tokio::select! {
            chunk = chunks.recv(), if ready && !finishing => match chunk {
                Some(chunk) => ws.send(tungstenite::Message::Binary(pcm16(&chunk).into())).await.map_err(|e| format!("ASR_SEND: {e}"))?,
                None => { finishing = true; let finish = serde_json::json!({"header":{"action":"finish-task","task_id":task_id,"streaming":"duplex"},"payload":{"input":{}}}); ws.send(tungstenite::Message::Text(finish.to_string().into())).await.map_err(|_| "ASR_SEND: cannot finalize task")?; }
            },
            msg = ws.next() => match msg {
                Some(Ok(tungstenite::Message::Text(text))) => {
                    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                    match value.pointer("/header/event").and_then(|v| v.as_str()) {
                        Some("task-started") => ready = true,
                        Some("task-finished") => break,
                        Some("task-failed") => return Err("ASR_PROVIDER: Aliyun rejected the task; check model and credentials".into()),
                        _ => {}
                    }
                    let output = value.pointer("/payload/output").unwrap_or(&serde_json::Value::Null);
                    if let Some(sentence) = output.get("sentence") { let text = sentence.get("text").and_then(|v| v.as_str()).unwrap_or(""); if !text.is_empty() { emit(&app, TranscriptEvent { session_id: session_id.clone(), text: text.into(), final_text: sentence.get("sentence_end").and_then(|v| v.as_bool()).unwrap_or(false), processing_ms: started.elapsed().as_millis() as u64, provider: "aliyun".into() }); } }
                }
                Some(Ok(tungstenite::Message::Close(_))) | None => return Err("ASR_RECEIVE: Aliyun closed before task-finished".into()),
                Some(Err(e)) => return Err(format!("ASR_RECEIVE: {e}")),
                _ => {}
            }
        }
    }
    Ok(())
}
