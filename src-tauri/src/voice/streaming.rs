//! Realtime speech-to-text backends.
//!
//! The capture thread owns the microphone. This module consumes bounded
//! ~100 ms chunks and emits two kinds of events: `interim` hypotheses which
//! may be replaced, and `final` utterances which the UI commits. Keeping this
//! contract provider-neutral lets local sherpa and WebSocket services share
//! the same editor behavior.

use crate::proxy::ResolvedProxy;
use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use url::Url;

#[derive(Clone, Debug, Serialize)]
pub struct TranscriptEvent {
    pub session_id: String,
    pub text: String,
    pub final_text: bool,
    pub processing_ms: u64,
    pub provider: String,
}

fn pcm16(chunk: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(chunk.len() * 2);
    for sample in chunk {
        out.extend_from_slice(&((*sample * 32767.0).clamp(-32768.0, 32767.0) as i16).to_le_bytes());
    }
    out
}

fn emit(app: &AppHandle, event: TranscriptEvent) {
    let _ = app.emit("voice-transcript", event);
}

/// Run the local streaming Zipformer backend. Model files are deliberately
/// kept outside the installer and are resolved from the user's cache. The
/// model installer will populate this directory in the next phase; a missing
/// bundle produces an actionable error and never falls back to a cloud call.
#[cfg(feature = "asr-sherpa")]
pub async fn run_local(
    app: AppHandle,
    session_id: String,
    mut chunks: tokio::sync::mpsc::Receiver<Vec<f32>>,
    language: String,
) -> Result<(), String> {
    let dir = sherpa_model_dir();
    let encoder = dir.join("encoder-epoch-99-avg-1.int8.onnx");
    let decoder = dir.join("decoder-epoch-99-avg-1.onnx");
    let joiner = dir.join("joiner-epoch-99-avg-1.int8.onnx");
    let tokens = dir.join("tokens.txt");
    for path in [&encoder, &decoder, &joiner, &tokens] {
        if !path.is_file() {
            return Err(format!(
                "STREAMING_MODEL_MISSING: install sherpa Zipformer model files in {} (missing {})",
                dir.display(),
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
    }
    let (recognizer, stream) = tokio::task::spawn_blocking(move || {
        let mut cfg = sherpa_onnx::OnlineRecognizerConfig::default();
        cfg.model_config.transducer.encoder = Some(encoder.to_string_lossy().into_owned());
        cfg.model_config.transducer.decoder = Some(decoder.to_string_lossy().into_owned());
        cfg.model_config.transducer.joiner = Some(joiner.to_string_lossy().into_owned());
        cfg.model_config.tokens = Some(tokens.to_string_lossy().into_owned());
        cfg.model_config.num_threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4) as i32)
            .unwrap_or(2);
        cfg.enable_endpoint = true;
        cfg.rule1_min_trailing_silence = 1.2;
        cfg.rule2_min_trailing_silence = 0.8;
        // Rule 3 is a maximum utterance length, not trailing silence.
        cfg.rule3_min_utterance_length = 20.0;
        cfg.decoding_method = Some("greedy_search".into());
        let recognizer = sherpa_onnx::OnlineRecognizer::create(&cfg).ok_or_else(|| {
            "STREAMING_MODEL_LOAD: unable to create Zipformer recognizer".to_string()
        })?;
        let stream = recognizer.create_stream();
        Ok::<_, String>((recognizer, stream))
    })
    .await
    .map_err(|e| e.to_string())??;

    let started = std::time::Instant::now();
    let mut last = String::new();
    while let Some(chunk) = chunks.recv().await {
        let pcm = chunk;
        let (text, endpoint) = tokio::task::block_in_place(|| {
            stream.accept_waveform(16_000, &pcm);
            while recognizer.is_ready(&stream) {
                recognizer.decode(&stream);
            }
            let result = recognizer
                .get_result(&stream)
                .map(|r| r.text)
                .unwrap_or_default();
            (result, recognizer.is_endpoint(&stream))
        });
        if !text.trim().is_empty() && (text != last || endpoint) {
            last = text.clone();
            emit(
                &app,
                TranscriptEvent {
                    session_id: session_id.clone(),
                    text,
                    final_text: endpoint,
                    processing_ms: started.elapsed().as_millis() as u64,
                    provider: if language == "auto" {
                        "sherpa-zipformer".into()
                    } else {
                        format!("sherpa-zipformer:{language}")
                    },
                },
            );
        }
        if endpoint {
            recognizer.reset(&stream);
            last.clear();
        }
    }
    // Flush the feature extraction tail before marking input complete.
    stream.accept_waveform(16_000, &vec![0.0; 4800]);
    stream.input_finished();
    while recognizer.is_ready(&stream) {
        recognizer.decode(&stream);
    }
    if let Some(result) = recognizer.get_result(&stream) {
        if !result.text.trim().is_empty() {
            emit(
                &app,
                TranscriptEvent {
                    session_id,
                    text: result.text,
                    final_text: true,
                    processing_ms: started.elapsed().as_millis() as u64,
                    provider: "sherpa-zipformer".into(),
                },
            );
        }
    }
    Ok(())
}

#[cfg(not(feature = "asr-sherpa"))]
pub async fn run_local(
    _app: AppHandle,
    _session_id: String,
    _chunks: tokio::sync::mpsc::Receiver<Vec<f32>>,
    _language: String,
) -> Result<(), String> {
    Err("STREAMING_MODEL_UNAVAILABLE: build with the asr-sherpa feature".into())
}

fn sherpa_model_dir() -> PathBuf {
    crate::asr::models::sherpa_model_dir()
}

/// Connect one of the supported realtime cloud APIs. The provider receives
/// exactly the same 16 kHz PCM chunks as the local engine and emits the same
/// interim/final event contract. Direct connections are used only when the
/// user explicitly selects `proxy_mode = "none"`; application/custom proxy
/// resolution is handled by the caller and an unavailable proxy is surfaced.
pub async fn run_online(
    app: AppHandle,
    session_id: String,
    mut chunks: tokio::sync::mpsc::Receiver<Vec<f32>>,
    provider: String,
    model: String,
    endpoint: String,
    api_key: String,
    language: String,
    proxy: Option<ResolvedProxy>,
) -> Result<(), String> {
    if api_key.is_empty() || api_key.starts_with("vault:") {
        return Err(
            "ASR_API_KEY_MISSING: unlock the credential vault and configure an API key".into(),
        );
    }
    let started = std::time::Instant::now();
    match provider.as_str() {
        "deepgram" => {
            run_deepgram(
                app,
                session_id,
                &mut chunks,
                &model,
                &endpoint,
                &api_key,
                &language,
                started,
                proxy.as_ref(),
            )
            .await
        }
        "gemini" => {
            run_gemini(
                app,
                session_id,
                &mut chunks,
                &model,
                &endpoint,
                &api_key,
                &language,
                started,
                proxy.as_ref(),
            )
            .await
        }
        "aliyun" => {
            run_aliyun(
                app,
                session_id,
                &mut chunks,
                &model,
                &endpoint,
                &api_key,
                &language,
                started,
                proxy.as_ref(),
            )
            .await
        }
        other => Err(format!("STREAMING_PROVIDER_UNAVAILABLE: {other}")),
    }
}

async fn connect_ws(
    request: tungstenite::http::Request<()>,
    proxy: Option<&ResolvedProxy>,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
        tungstenite::http::Response<Option<Vec<u8>>>,
    ),
    String,
> {
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        connect_ws_inner(request, proxy),
    )
    .await
    .map_err(|_| "ASR_CONNECT_TIMEOUT: check the provider and proxy settings".to_string())?
}

async fn connect_ws_inner(
    request: tungstenite::http::Request<()>,
    proxy: Option<&ResolvedProxy>,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
        tungstenite::http::Response<Option<Vec<u8>>>,
    ),
    String,
> {
    let uri = request.uri().to_string();
    let url = Url::parse(&uri).map_err(|e| format!("ASR_WS_URL: {e}"))?;
    let host = url.host_str().ok_or("ASR_WS_URL: missing host")?;
    let port = url
        .port_or_known_default()
        .ok_or("ASR_WS_URL: missing port")?;
    let stream = if let Some(proxy) = proxy {
        let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        if proxy.kind == "socks5" {
            socks5_connect(&mut stream, host, port, proxy).await?;
        } else {
            http_connect(&mut stream, host, port, proxy).await?;
        }
        stream
    } else {
        TcpStream::connect((host, port))
            .await
            .map_err(|e| format!("ASR_CONNECT: {e}"))?
    };
    tokio_tungstenite::client_async_tls(request, stream)
        .await
        .map_err(|_| {
            "ASR_CONNECT: WebSocket handshake failed; check endpoint and credentials".into()
        })
}

async fn http_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    proxy: &ResolvedProxy,
) -> Result<(), String> {
    let mut request = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    if !proxy.username.is_empty() {
        let token = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", proxy.username, proxy.password));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("Connection: Keep-Alive\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    let mut response = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while response.len() < 16 * 1024 {
        stream
            .read_exact(&mut byte)
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        response.push(byte[0]);
        if response.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&response);
    let status = text
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .nth(1)
        .unwrap_or_default();
    if !status.starts_with('2') {
        return Err(format!("ASR_PROXY_CONNECT: HTTP CONNECT failed ({status})"));
    }
    Ok(())
}

async fn socks5_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    proxy: &ResolvedProxy,
) -> Result<(), String> {
    let auth = if proxy.username.is_empty() {
        vec![0u8]
    } else {
        vec![0u8, 2u8]
    };
    stream
        .write_all(&[5, auth.len() as u8])
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    stream
        .write_all(&auth)
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    let mut selected = [0u8; 2];
    stream
        .read_exact(&mut selected)
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    if selected[1] == 2 {
        if proxy.username.len() > 255 || proxy.password.len() > 255 {
            return Err("ASR_PROXY_CONNECT: SOCKS5 credentials too long".into());
        }
        stream
            .write_all(&[1, proxy.username.len() as u8])
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        stream
            .write_all(proxy.username.as_bytes())
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        stream
            .write_all(&[proxy.password.len() as u8])
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        stream
            .write_all(proxy.password.as_bytes())
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        let mut result = [0u8; 2];
        stream
            .read_exact(&mut result)
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        if result[1] != 0 {
            return Err("ASR_PROXY_CONNECT: SOCKS5 authentication failed".into());
        }
    } else if selected[1] != 0 {
        return Err("ASR_PROXY_CONNECT: SOCKS5 authentication method rejected".into());
    }
    let host_bytes = host.as_bytes();
    if host_bytes.len() > 255 {
        return Err("ASR_PROXY_CONNECT: host name too long".into());
    }
    let mut command = vec![5, 1, 0, 3, host_bytes.len() as u8];
    command.extend_from_slice(host_bytes);
    command.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&command)
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    let mut head = [0u8; 4];
    stream
        .read_exact(&mut head)
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    if head[1] != 0 {
        return Err(format!(
            "ASR_PROXY_CONNECT: SOCKS5 target rejected ({})",
            head[1]
        ));
    }
    let length = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut n = [0u8; 1];
            stream
                .read_exact(&mut n)
                .await
                .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
            n[0] as usize
        }
        _ => return Err("ASR_PROXY_CONNECT: invalid SOCKS5 address".into()),
    };
    let mut discard = vec![0u8; length + 2];
    stream
        .read_exact(&mut discard)
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    Ok(())
}

fn ws_request(
    url: &str,
    headers: &[(&str, &str)],
) -> Result<tungstenite::http::Request<()>, String> {
    use tungstenite::client::IntoClientRequest;
    let endpoint = Url::parse(url).map_err(|_| "ASR_WS_REQUEST: invalid endpoint")?;
    if !matches!(endpoint.scheme(), "ws" | "wss") || endpoint.host_str().is_none() {
        return Err("ASR_WS_REQUEST: endpoint must use ws:// or wss:// with a host".into());
    }
    // A manually built HTTP request does not acquire the required WebSocket
    // upgrade headers in client_async_tls. Let tungstenite generate a fresh
    // Sec-WebSocket-Key, Host, Connection, Upgrade and version for each session.
    let mut request = url
        .into_client_request()
        .map_err(|_| "ASR_WS_REQUEST: invalid WebSocket endpoint")?;
    for (name, value) in headers {
        let name = tungstenite::http::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "ASR_WS_REQUEST: invalid header name")?;
        let value = tungstenite::http::HeaderValue::from_str(value)
            .map_err(|_| "ASR_WS_REQUEST: invalid header value")?;
        request.headers_mut().insert(name, value);
    }
    Ok(request)
}

async fn run_deepgram(
    app: AppHandle,
    session_id: String,
    chunks: &mut tokio::sync::mpsc::Receiver<Vec<f32>>,
    model: &str,
    endpoint: &str,
    api_key: &str,
    language: &str,
    started: std::time::Instant,
    proxy: Option<&ResolvedProxy>,
) -> Result<(), String> {
    let url = format!(
        "{}?model={}&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=300&language={}",
        endpoint.trim_end_matches('/'),
        urlencoding::encode(model),
        urlencoding::encode(if language == "auto" {
            "multi"
        } else {
            language
        })
    );
    let req = ws_request(&url, &[("Authorization", &format!("Token {api_key}"))])?;
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
                Some(Ok(tungstenite::Message::Close(_))) | None => break,
                Some(Err(e)) => return Err(format!("ASR_RECEIVE: {e}")),
                _ => {}
            }
        }
    }
    Ok(())
}

async fn run_gemini(
    app: AppHandle,
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

async fn run_aliyun(
    app: AppHandle,
    session_id: String,
    chunks: &mut tokio::sync::mpsc::Receiver<Vec<f32>>,
    model: &str,
    endpoint: &str,
    api_key: &str,
    language: &str,
    started: std::time::Instant,
    proxy: Option<&ResolvedProxy>,
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
    let run = serde_json::json!({"header":{"action":"run-task","task_id":task_id,"streaming":"duplex"},"payload":{"task_group":"audio","task":"asr","function":"recognition","input":{},"model":model,"parameters":{"sample_rate":16000,"format":"pcm","language_hints":if language == "auto" { vec!["zh","en"] } else { vec![language] }}}});
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
                Some(Ok(tungstenite::Message::Close(_))) | None => break,
                Some(Err(e)) => return Err(format!("ASR_RECEIVE: {e}")),
                _ => {}
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::net::TcpListener;

    async fn handshake_through(route: &str) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let route = route.to_owned();
        let proxy = (!route.is_empty()).then(|| ResolvedProxy {
            host: "127.0.0.1".into(),
            port,
            kind: route.clone(),
            username: String::new(),
            password: String::new(),
        });
        // A deliberately unresolvable destination proves the selected proxy
        // handles origin DNS. The fixture terminates the tunnel as a WS server.
        let endpoint = if proxy.is_some() {
            "ws://asr-fixture.invalid:8080/listen?language=zh".to_owned()
        } else {
            format!("ws://127.0.0.1:{port}/listen?language=zh")
        };
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            match route.as_str() {
                "http" => {
                    let mut header = Vec::new();
                    while !header.ends_with(b"\r\n\r\n") {
                        assert!(header.len() < 4096);
                        header.push(stream.read_u8().await.unwrap());
                    }
                    assert!(
                        String::from_utf8(header)
                            .unwrap()
                            .starts_with("CONNECT asr-fixture.invalid:8080 HTTP/1.1\r\n")
                    );
                    stream
                        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                        .await
                        .unwrap();
                }
                "socks5" => {
                    let mut greeting = [0; 3];
                    stream.read_exact(&mut greeting).await.unwrap();
                    assert_eq!(greeting, [5, 1, 0]);
                    stream.write_all(&[5, 0]).await.unwrap();
                    let mut header = [0; 5];
                    stream.read_exact(&mut header).await.unwrap();
                    assert_eq!(&header[..4], &[5, 1, 0, 3]);
                    let mut domain = vec![0; header[4] as usize];
                    stream.read_exact(&mut domain).await.unwrap();
                    assert_eq!(domain, b"asr-fixture.invalid");
                    assert_eq!(stream.read_u16().await.unwrap(), 8080);
                    stream
                        .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
                        .await
                        .unwrap();
                }
                "" => {}
                _ => panic!("unknown fixture route"),
            }
            let mut ws = tokio_tungstenite::accept_hdr_async(
                stream,
                |request: &tungstenite::handshake::server::Request, response| {
                    assert_eq!(request.uri().path(), "/listen");
                    assert_eq!(request.uri().query(), Some("language=zh"));
                    assert_eq!(request.headers()["Authorization"], "Token fixture-key");
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let audio = ws.next().await.unwrap().unwrap();
            assert_eq!(audio.into_data().as_ref(), &[0u8, 1, 2, 3]);
            ws.send(tungstenite::Message::Text("fixture transcript".into()))
                .await
                .unwrap();
        });
        let exchange = async {
            let request = ws_request(&endpoint, &[("Authorization", "Token fixture-key")]).unwrap();
            let (mut client, response) = connect_ws(request, proxy.as_ref()).await.unwrap();
            assert_eq!(response.status(), 101);
            client
                .send(tungstenite::Message::Binary(vec![0, 1, 2, 3].into()))
                .await
                .unwrap();
            assert_eq!(
                client.next().await.unwrap().unwrap().into_text().unwrap(),
                "fixture transcript"
            );
            server.await.unwrap();
        };
        tokio::time::timeout(Duration::from_secs(5), exchange)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn online_handshake_direct() {
        handshake_through("").await;
    }

    #[tokio::test]
    async fn online_handshake_http_proxy() {
        handshake_through("http").await;
    }

    #[tokio::test]
    async fn online_handshake_socks5_proxy() {
        handshake_through("socks5").await;
    }

    #[test]
    fn request_rejects_invalid_endpoint_and_header_without_exposing_credentials() {
        assert!(ws_request("https://asr.example.test/listen", &[]).is_err());
        assert!(ws_request("ws:///", &[]).is_err());
        let error = ws_request(
            "wss://asr.example.test/listen",
            &[("Authorization", "secret\r\ninjected")],
        )
        .unwrap_err();
        assert!(error.starts_with("ASR_WS_REQUEST:"));
        assert!(!error.contains("secret"));
    }
}
