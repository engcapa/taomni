//! Wire protocols checked against official vendor documentation (see ASR sources).
use super::*;
use crate::ai::config::AsrProviderConfig;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    io::{Read, Write},
    time::Instant,
};

pub(super) async fn run_soniox(
    app: TranscriptSink,
    session_id: String,
    chunks: &mut tokio::sync::mpsc::Receiver<Vec<f32>>,
    config: &AsrProviderConfig,
    key: &str,
    language: &str,
    words: &[String],
    started: Instant,
    proxy: Option<&ResolvedProxy>,
) -> Result<(), String> {
    let (mut ws, _) = connect_ws(
        ws_request(
            &config.endpoint,
            &[("Authorization", &format!("Bearer {key}"))],
        )?,
        proxy,
    )
    .await?;
    let setup = json!({"model":config.model,"audio_format":"pcm_s16le","sample_rate":16000,"num_channels":1,
        "language_hints":if language=="auto" { vec![] } else { vec![language] },
        "enable_endpoint_detection":true,"context":{"terms":words}});
    ws.send(tungstenite::Message::Text(setup.to_string().into()))
        .await
        .map_err(|_| "ASR_SETUP: Soniox setup failed")?;
    let mut finishing = false;
    loop {
        tokio::select! {
            chunk = chunks.recv(), if !finishing => {
                let message = if let Some(chunk) = chunk { tungstenite::Message::Binary(pcm16(&chunk).into()) }
                    else { finishing = true; tungstenite::Message::Text("".into()) };
                ws.send(message).await.map_err(|_| "ASR_SEND: Soniox audio send failed")?;
            }
            msg = ws.next() => match msg {
                Some(Ok(tungstenite::Message::Text(text))) => {
                    let value: Value = serde_json::from_str(&text).map_err(|_| "ASR_PROTOCOL: invalid Soniox JSON")?;
                    if value.get("error_code").is_some() { return Err("ASR_PROVIDER: Soniox rejected the stream; check model and credentials".into()); }
                    let (finals, partial) = soniox_tokens(&value);
                    for (text, final_text) in [(finals, true), (partial, false)] {
                        if !text.is_empty() { emit(&app, TranscriptEvent { session_id: session_id.clone(), text, final_text,
                            processing_ms: started.elapsed().as_millis() as u64, provider:"soniox".into() }); }
                    }
                    if value.get("finished").and_then(Value::as_bool) == Some(true) { return Ok(()); }
                }
                Some(Ok(tungstenite::Message::Close(_))) | None => return Err("ASR_DISCONNECTED: Soniox closed before final acknowledgement".into()),
                Some(Err(_)) => return Err("ASR_RECEIVE: Soniox connection failed".into()),
                _ => {}
            }
        }
    }
}

fn soniox_tokens(value: &Value) -> (String, String) {
    let mut final_text = String::new();
    let mut partial = String::new();
    for token in value
        .get("tokens")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let text = token.get("text").and_then(Value::as_str).unwrap_or("");
        if ["<end>", "<fin>"].contains(&text) {
            continue;
        }
        if token.get("is_final").and_then(Value::as_bool) == Some(true) {
            final_text.push_str(text);
        } else {
            partial.push_str(text);
        }
    }
    (final_text, partial)
}

fn volc_frame(kind: u8, last: bool, payload: &[u8]) -> Result<Vec<u8>, String> {
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gzip.write_all(payload)
        .map_err(|_| "ASR_PROTOCOL: cannot compress frame")?;
    let payload = gzip
        .finish()
        .map_err(|_| "ASR_PROTOCOL: cannot finish frame")?;
    let mut frame = vec![
        0x11,
        (kind << 4) | if last { 2 } else { 0 },
        if kind == 1 { 0x11 } else { 0x01 },
        0,
    ];
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend(payload);
    Ok(frame)
}

fn volc_response(frame: &[u8]) -> Result<(Value, bool), String> {
    let invalid = || "ASR_PROTOCOL: malformed Volcengine frame".to_owned();
    if frame.len() < 8 || frame[0] >> 4 != 1 {
        return Err(invalid());
    }
    let mut offset = ((frame[0] & 15) as usize) * 4;
    if offset < 4 || offset > frame.len() {
        return Err(invalid());
    }
    let kind = frame[1] >> 4;
    let flags = frame[1] & 15;
    if flags > 3 {
        return Err(invalid());
    }
    let mut number = || -> Result<i32, String> {
        let bytes = frame.get(offset..offset + 4).ok_or_else(invalid)?;
        offset += 4;
        Ok(i32::from_be_bytes(bytes.try_into().unwrap()))
    };
    if kind == 15 {
        let code = number()?;
        return Err(format!("ASR_PROVIDER: Volcengine error {code}"));
    }
    if kind != 9 {
        return Err(invalid());
    }
    if flags & 1 != 0 {
        let sequence = number()?;
        if (flags & 2 != 0) != (sequence < 0) {
            return Err(invalid());
        }
    }
    let size = number()?;
    if size < 0 || size as usize > 1024 * 1024 {
        return Err(invalid());
    }
    let payload = frame.get(offset..).ok_or_else(invalid)?;
    if payload.len() != size as usize || frame[2] >> 4 != 1 {
        return Err(invalid());
    }
    let bytes = match frame[2] & 15 {
        0 => payload.to_vec(),
        1 => {
            let mut out = Vec::new();
            Read::take(flate2::read::GzDecoder::new(payload), 1024 * 1024 + 1)
                .read_to_end(&mut out)
                .map_err(|_| invalid())?;
            if out.len() > 1024 * 1024 {
                return Err(invalid());
            }
            out
        }
        _ => return Err(invalid()),
    };
    Ok((
        serde_json::from_slice(&bytes).map_err(|_| invalid())?,
        flags & 2 != 0,
    ))
}

pub(super) async fn run_volcengine(
    app: TranscriptSink,
    session_id: String,
    chunks: &mut tokio::sync::mpsc::Receiver<Vec<f32>>,
    config: &AsrProviderConfig,
    key: &str,
    vocabulary: &str,
    started: Instant,
    proxy: Option<&ResolvedProxy>,
) -> Result<(), String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let request = ws_request(
        &config.endpoint,
        &[
            ("X-Api-Key", key),
            ("X-Api-Resource-Id", &config.resource_id),
            ("X-Api-Connect-Id", &request_id),
            ("X-Api-Request-Id", &request_id),
        ],
    )?;
    let (mut ws, _) = connect_ws(request, proxy).await?;
    let mut setup = json!({"user":{"uid":"taomni"},"audio":{"format":"pcm","rate":16000,"bits":16,"channel":1},
        "request":{"model_name":config.model,"enable_itn":true,"enable_punc":true,"show_utterances":true,
            "enable_nonstream":true,"result_type":"full"}});
    if !vocabulary.is_empty() {
        setup["request"]["corpus"] = json!({"boosting_table_id":vocabulary});
    }
    ws.send(tungstenite::Message::Binary(
        volc_frame(1, false, &serde_json::to_vec(&setup).unwrap())?.into(),
    ))
    .await
    .map_err(|_| "ASR_SETUP: Volcengine setup failed")?;
    let mut finishing = false;
    let mut committed = HashSet::new();
    loop {
        tokio::select! {
            chunk = chunks.recv(), if !finishing => {
                let bytes = if let Some(chunk) = chunk { pcm16(&chunk) } else { finishing = true; Vec::new() };
                ws.send(tungstenite::Message::Binary(volc_frame(2, finishing, &bytes)?.into())).await.map_err(|_| "ASR_SEND: Volcengine audio send failed")?;
            }
            msg = ws.next() => match msg {
                Some(Ok(tungstenite::Message::Binary(bytes))) => {
                    let (value, last) = volc_response(&bytes)?;
                    let mut partial = String::new();
                    for utterance in value.pointer("/result/utterances").and_then(Value::as_array).into_iter().flatten() {
                        let text = utterance.get("text").and_then(Value::as_str).unwrap_or("");
                        let final_text = last || utterance.get("definite").and_then(Value::as_bool) == Some(true);
                        let start = utterance.get("start_time").and_then(Value::as_i64).ok_or("ASR_PROTOCOL: missing utterance timestamp")?;
                        if final_text {
                            if !text.is_empty() && committed.insert(start) { emit(&app, TranscriptEvent { session_id: session_id.clone(), text:text.into(), final_text:true,
                                processing_ms:started.elapsed().as_millis() as u64, provider:"volcengine".into() }); }
                        } else if !committed.contains(&start) { partial.push_str(text); }
                    }
                    if !partial.is_empty() { emit(&app, TranscriptEvent { session_id:session_id.clone(), text:partial, final_text:false,
                        processing_ms:started.elapsed().as_millis() as u64, provider:"volcengine".into() }); }
                    if last { return Ok(()); }
                }
                Some(Ok(tungstenite::Message::Close(_))) | None => return Err("ASR_DISCONNECTED: Volcengine closed before final acknowledgement".into()),
                Some(Err(_)) => return Err("ASR_RECEIVE: Volcengine connection failed".into()),
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn soniox_socket_drains_delayed_finals_and_splits_mixed_tokens() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "ws://{}/transcribe-websocket",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_hdr_async(
                socket,
                |req: &tungstenite::handshake::server::Request, response| {
                    assert_eq!(req.headers()["Authorization"], "Bearer fixture");
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let setup: Value =
                serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            assert_eq!(setup["audio_format"], "pcm_s16le");
            assert_eq!(setup["context"]["terms"][0], "Taomni");
            assert!(ws.next().await.unwrap().unwrap().is_binary());
            assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap(), "");
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            ws.send(tungstenite::Message::Text(json!({"tokens":[{"text":"Hello ","is_final":true},{"text":"wor","is_final":false}]}).to_string().into())).await.unwrap();
            ws.send(tungstenite::Message::Text(
                json!({"tokens":[{"text":"world","is_final":true}],"finished":true})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        });
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        tx.send(vec![0.1; 1600]).await.unwrap();
        drop(tx);
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let output = events.clone();
        let sink: TranscriptSink =
            std::sync::Arc::new(move |event| output.lock().unwrap().push(event));
        let config = AsrProviderConfig {
            endpoint,
            model: "stt-rt-v5".into(),
            ..Default::default()
        };
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_soniox(
                sink,
                "fixture".into(),
                &mut rx,
                &config,
                "fixture",
                "en",
                &["Taomni".into()],
                Instant::now(),
                None,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        server.await.unwrap();
        let events = events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| e.final_text)
                .map(|e| e.text.as_str())
                .collect::<String>(),
            "Hello world"
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| !e.final_text)
                .map(|e| e.text.as_str())
                .collect::<String>(),
            "wor"
        );
    }

    #[tokio::test]
    async fn volc_socket_sends_last_packet_and_commits_cumulative_utterances_once() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "ws://{}/api/v3/sauc/bigmodel_async",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_hdr_async(
                socket,
                |req: &tungstenite::handshake::server::Request, response| {
                    assert_eq!(req.headers()["X-Api-Key"], "fixture");
                    assert_eq!(
                        req.headers()["X-Api-Resource-Id"],
                        "volc.seedasr.sauc.duration"
                    );
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let setup = ws.next().await.unwrap().unwrap().into_data();
            assert_eq!(setup[1], 0x10);
            let audio = ws.next().await.unwrap().unwrap().into_data();
            assert_eq!(audio[1], 0x20);
            let last = ws.next().await.unwrap().unwrap().into_data();
            assert_eq!(last[1], 0x22);
            for last in [false, true] {
                let value = json!({"result":{"utterances":[{"text":"你好","start_time":0,"end_time":800,"definite":true}]}});
                let mut frame = volc_frame(1, last, &serde_json::to_vec(&value).unwrap()).unwrap();
                frame[1] = if last { 0x92 } else { 0x90 };
                ws.send(tungstenite::Message::Binary(frame.into()))
                    .await
                    .unwrap();
            }
        });
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        tx.send(vec![0.1; 1600]).await.unwrap();
        drop(tx);
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let output = events.clone();
        let sink: TranscriptSink = std::sync::Arc::new(move |e| output.lock().unwrap().push(e));
        let config = AsrProviderConfig {
            endpoint,
            model: "bigmodel".into(),
            resource_id: "volc.seedasr.sauc.duration".into(),
            ..Default::default()
        };
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_volcengine(
                sink,
                "fixture".into(),
                &mut rx,
                &config,
                "fixture",
                "",
                Instant::now(),
                None,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        server.await.unwrap();
        assert_eq!(events.lock().unwrap().len(), 1);
        assert_eq!(events.lock().unwrap()[0].text, "你好");
    }

    #[test]
    fn soniox_mixed_tokens_keep_final_and_partial_separate() {
        let result = soniox_tokens(
            &json!({"tokens":[{"text":"Hello", "is_final":true},{"text":" wor", "is_final":false},{"text":"<end>","is_final":true}]}),
        );
        assert_eq!(result, ("Hello".into(), " wor".into()));
    }
    #[test]
    fn volc_gzip_frames_validate_sequences_sizes_and_errors() {
        let value = json!({"result":{"text":"你好"}});
        let mut frame = volc_frame(1, false, &serde_json::to_vec(&value).unwrap()).unwrap();
        frame[1] = 0x93;
        frame.splice(4..4, (-2i32).to_be_bytes());
        assert_eq!(volc_response(&frame).unwrap(), (value, true));
        for n in 0..frame.len() {
            assert!(volc_response(&frame[..n]).is_err());
        }
        let mut bad = frame.clone();
        bad[7] = 2;
        bad[4] = 0;
        bad[5] = 0;
        bad[6] = 0;
        assert!(volc_response(&bad).is_err());
        let mut error = vec![0x11, 0xf0, 0x11, 0];
        error.extend(45000001i32.to_be_bytes());
        assert!(volc_response(&error).unwrap_err().contains("45000001"));
        assert_eq!(volc_frame(2, true, &[]).unwrap()[1], 0x22);
    }
}
