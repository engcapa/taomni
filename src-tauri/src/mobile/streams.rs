use super::{
    pty_broker::Broker,
    server::{ApiError, Service, origin, origin_allowed},
};
use axum::{
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::Response,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

#[derive(Deserialize)]
pub struct Ticket {
    ticket: String,
    after_seq: Option<u64>,
}
fn authorize(s: &Service, headers: &HeaderMap, ticket: &str) -> Result<String, ApiError> {
    if origin(headers).is_none() || !origin_allowed(s, headers) {
        return Err("origin_denied".into());
    }
    s.runtime
        .auth
        .lock()
        .unwrap()
        .consume_ticket(ticket, origin(headers))
        .ok_or_else(|| "unauthorized".into())
}
pub async fn events(
    State(s): State<Service>,
    Query(q): Query<Ticket>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let device = authorize(&s, &headers, &q.ticket)?;
    // Subscribe before hello/sequence snapshot: no event can fall in the gap.
    let rx = s.runtime.events.tx.subscribe();
    let frames = q
        .after_seq
        .map(|after| s.runtime.events.resume(after))
        .unwrap_or_default();
    Ok(ws
        .max_message_size(64 * 1024)
        .on_upgrade(move |socket| run(socket, s, device, None, rx, frames)))
}
pub async fn terminal(
    State(s): State<Service>,
    Query(q): Query<Ticket>,
    Path(id): Path<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let device = authorize(&s, &headers, &q.ticket)?;
    let id = id
        .strip_prefix("term:")
        .ok_or("terminal_not_found")?
        .to_owned();
    let (rx, mut frames) = s.runtime.broker.subscribe(&id)?;
    if let Some(after) = q.after_seq {
        let state: Vec<_> = frames
            .iter()
            .filter(|v| v["type"] != "replay")
            .cloned()
            .collect();
        frames = s.runtime.broker.resume(&id, after);
        frames.extend(state);
    }
    Ok(ws
        .max_message_size(64 * 1024)
        .on_upgrade(move |socket| run(socket, s, device, Some(id), rx, frames)))
}
async fn send(socket: &mut WebSocket, event: Value) -> Result<(), ()> {
    tokio::time::timeout(
        Duration::from_secs(10),
        socket.send(Message::Text(event.to_string().into())),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}
async fn run(
    mut socket: WebSocket,
    s: Service,
    device: String,
    terminal: Option<String>,
    mut rx: broadcast::Receiver<Value>,
    frames: Vec<Value>,
) {
    let connection = uuid::Uuid::new_v4().to_string();
    let hello = json!({"type":"hello", "instance_id":s.runtime.instance_id,"run_mode":s.core.mode(),"event_seq":s.runtime.events.seq(), "device_id":device,"connection_id":connection});
    if send(&mut socket, hello).await.is_err() {
        return;
    }
    for frame in frames {
        if send(&mut socket, frame).await.is_err() {
            return;
        }
    }
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    let mut last_in = Instant::now();
    let mut last_out = Instant::now();
    loop {
        if !s.runtime.auth.lock().unwrap().exists(&device) {
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: 4001,
                    reason: "device_revoked".into(),
                })))
                .await;
            break;
        }
        tokio::select! {
            _ = s.cancel.cancelled() => break,
            _ = s.runtime.devices_changed.notified() => {
                if !s.runtime.auth.lock().unwrap().exists(&device) {
                    let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame { code:4001, reason:"device_revoked".into() }))).await;
                    break;
                }
            }
            _ = heartbeat.tick() => {
                if last_in.elapsed() > Duration::from_secs(90) { break; }
                // A busy output-only viewer still needs an opportunity to ACK.
                if last_out.elapsed() >= Duration::from_secs(30) || last_in.elapsed() >= Duration::from_secs(30) {
                    if send(&mut socket, json!({"type":"heartbeat"})).await.is_err() { break; }
                    last_out = Instant::now();
                }
            }
            event = rx.recv() => match event {
                Ok(event) => { if send(&mut socket, event).await.is_err() { break; } last_out = Instant::now(); }
                Err(_) => break, // bounded backpressure: reconnect/resume, never silently skip
            },
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { break; };
                last_in = Instant::now();
                let Message::Text(text) = message else {
                    if matches!(message, Message::Close(_)) { break; }
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else { break; };
                let kind = value["type"].as_str().unwrap_or("");
                if kind == "heartbeat-ack" { continue; }
                if kind == "resume" {
                    let Some(after) = value["after_seq"].as_u64() else { break; };
                    let frames = terminal.as_ref().map(|id| s.runtime.broker.resume(id, after))
                        .unwrap_or_else(|| s.runtime.events.resume(after));
                    for frame in frames { if send(&mut socket, frame).await.is_err() { break; } }
                    continue;
                }
                let result = if let Some(id) = &terminal {
                    terminal_command(&s, id, &device, &connection, &value).await
                } else { Err("invalid_message".into()) };
                if let Err(code) = result {
                    if send(&mut socket, json!({"type":"error","code":code})).await.is_err() { break; }
                }
            }
        }
    }
    if let Some(id) = terminal {
        if let Ok(gate) = s.runtime.broker.gate(&id) {
            let _guard = gate.lock().await;
            if let Ok(Some((cols, rows))) =
                s.runtime.broker.control(&id, &device, &connection, false)
            {
                let _ =
                    crate::terminal::resize_terminal_inner(&s.core.state(), &id, cols, rows).await;
            }
        }
    }
    let _ = socket.close().await;
}
async fn terminal_command(
    s: &Service,
    id: &str,
    device: &str,
    connection: &str,
    value: &Value,
) -> Result<(), String> {
    let broker: &Broker = &s.runtime.broker;
    let gate = broker.gate(id)?;
    let _guard = gate.lock().await;
    // Recheck after taking the operation gate: revoke cannot authorize queued input.
    if !s.runtime.auth.lock().unwrap().exists(device) {
        return Err("unauthorized".into());
    }
    let state = s.core.state();
    match value["type"].as_str().unwrap_or("") {
        "take-control" => {
            broker.control(id, device, connection, true)?;
        }
        "release-control" => {
            if let Some((cols, rows)) = broker.control(id, device, connection, false)? {
                let _ = crate::terminal::resize_terminal_inner(&state, id, cols, rows).await;
            }
        }
        "input" => {
            broker.ensure_holder(id, connection)?;
            let data = value["data_b64"].as_str().ok_or("invalid_input")?;
            crate::terminal::write_terminal_inner(&state, id, data).await?;
        }
        "resize" => {
            let cols = value["cols"]
                .as_u64()
                .ok_or("invalid_size")?
                .min(u16::MAX as u64) as u16;
            let rows = value["rows"]
                .as_u64()
                .ok_or("invalid_size")?
                .min(u16::MAX as u64) as u16;
            if let Some((cols, rows)) = broker.resize(id, connection, cols, rows)? {
                crate::terminal::resize_terminal_inner(&state, id, cols, rows).await?;
            }
        }
        _ => return Err("invalid_message".into()),
    }
    Ok(())
}
