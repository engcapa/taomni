//! Text messaging (phase 5): one-to-one send/receive with delivery state.
//!
//! Outbound: persist (sending) -> dial+send the `text-msg` frame -> mark `sent`,
//! then `delivered` on `text-ack` or `failed` on timeout. Inbound: persist
//! (deduped by message id), bump unread, emit to the UI, and reply `text-ack`.
//! Group fan-out is added in phase 6.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::lanchat::protocol::{frame, Envelope, PROTOCOL_VERSION};
use crate::lanchat::store::{direct_conv_id, LanMessage};
use crate::lanchat::{events, transport, LanChatState};

/// How long an unacked message waits before it is marked `failed`.
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);

fn emit_message(app: &AppHandle, msg: &LanMessage) {
    if let Err(e) = app.emit(events::MESSAGE, msg) {
        log::warn!("lanchat: emit message failed: {e}");
    }
}

async fn emit_conversation(app: &AppHandle, state: &Arc<LanChatState>, conv_id: &str) {
    if let Ok(Some(conv)) = state.store.get_conversation(conv_id) {
        if let Err(e) = app.emit(events::CONVERSATION, &conv) {
            log::warn!("lanchat: emit conversation failed: {e}");
        }
    }
}

/// Send `text` to a peer, tracking delivery. Returns the persisted message.
pub async fn send_text(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    peer_id: &str,
    text: String,
    mentions: Vec<String>,
) -> Result<LanMessage, String> {
    let my_id = state.node_id().await;
    let conv_id = direct_conv_id(peer_id);
    state
        .store
        .ensure_conversation(&conv_id, "direct", peer_id)
        .map_err(|e| e.to_string())?;

    let payload = json!({ "convId": conv_id.clone(), "text": text.clone(), "mentions": mentions.clone() });
    let env = Envelope::new(frame::TEXT_MSG, &my_id, Some(peer_id.to_string()), payload);
    let msg = LanMessage {
        id: env.id.clone(),
        conv_id: conv_id.clone(),
        sender_id: my_id,
        body: text,
        mentions,
        created_at: env.ts,
        state: "sending".into(),
    };
    state.store.insert_message(&msg).map_err(|e| e.to_string())?;
    let _ = state.store.touch_conversation(&conv_id, msg.created_at, 0);
    emit_message(app, &msg);
    emit_conversation(app, state, &conv_id).await;

    dispatch_and_track(app, state, peer_id, env).await;
    Ok(state
        .store
        .get_message(&msg.id)
        .ok()
        .flatten()
        .unwrap_or(msg))
}

/// Re-send a previously failed/sending direct message (e.g. after reconnect),
/// reusing the original message id so the ack still correlates.
pub async fn resend(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    msg_id: &str,
) -> Result<LanMessage, String> {
    let msg = state
        .store
        .get_message(msg_id)
        .map_err(|e| e.to_string())?
        .ok_or("message not found")?;
    let peer_id = msg
        .conv_id
        .strip_prefix("direct:")
        .ok_or("resend only supports direct conversations")?
        .to_string();

    let my_id = state.node_id().await;
    let env = Envelope {
        v: PROTOCOL_VERSION,
        frame_type: frame::TEXT_MSG.to_string(),
        id: msg.id.clone(),
        from: my_id,
        to: Some(peer_id.clone()),
        ts: chrono::Utc::now().timestamp_millis(),
        payload: json!({ "convId": msg.conv_id, "text": msg.body, "mentions": msg.mentions }),
    };
    let _ = state.store.set_message_state(&msg.id, "sending");
    if let Ok(Some(m)) = state.store.get_message(&msg.id) {
        emit_message(app, &m);
    }
    dispatch_and_track(app, state, &peer_id, env).await;
    Ok(state.store.get_message(&msg.id).ok().flatten().unwrap_or(msg))
}

/// Send the frame and track delivery: `sent` on success (+ failure timeout),
/// `failed` immediately if the peer is unreachable.
async fn dispatch_and_track(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    peer_id: &str,
    env: Envelope,
) {
    let msg_id = env.id.clone();
    match transport::send_to_peer(app, state, peer_id, env).await {
        Ok(()) => {
            let _ = state.store.set_message_state(&msg_id, "sent");
            if let Ok(Some(m)) = state.store.get_message(&msg_id) {
                emit_message(app, &m);
            }
            spawn_delivery_timeout(app.clone(), state.clone(), msg_id);
        }
        Err(e) => {
            log::debug!("lanchat: send to {peer_id} failed: {e}");
            let _ = state.store.set_message_state(&msg_id, "failed");
            if let Ok(Some(m)) = state.store.get_message(&msg_id) {
                emit_message(app, &m);
            }
        }
    }
}

/// After `DELIVERY_TIMEOUT`, demote a still-unacked `sent` message to `failed`.
fn spawn_delivery_timeout(app: AppHandle, state: Arc<LanChatState>, msg_id: String) {
    tokio::spawn(async move {
        tokio::time::sleep(DELIVERY_TIMEOUT).await;
        if let Ok(Some(m)) = state.store.get_message(&msg_id) {
            if m.state == "sent" {
                let _ = state.store.set_message_state(&msg_id, "failed");
                if let Ok(Some(updated)) = state.store.get_message(&msg_id) {
                    emit_message(&app, &updated);
                }
            }
        }
    });
}

/// Handle an inbound `text-msg`: persist (deduped), bump unread, emit, and ack.
pub async fn handle_text_msg(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    from: &str,
    env: &Envelope,
) {
    let text = env
        .payload
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mentions: Vec<String> = env
        .payload
        .get("mentions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    // Receiver keys the conversation by the sender.
    let conv_id = direct_conv_id(from);
    if let Err(e) = state.store.ensure_conversation(&conv_id, "direct", from) {
        log::debug!("lanchat: ensure conversation failed: {e}");
        return;
    }
    let msg = LanMessage {
        id: env.id.clone(),
        conv_id: conv_id.clone(),
        sender_id: from.to_string(),
        body: text,
        mentions,
        created_at: env.ts,
        state: "delivered".into(),
    };
    match state.store.insert_message(&msg) {
        Ok(true) => {
            let _ = state.store.touch_conversation(&conv_id, env.ts, 1);
            emit_message(app, &msg);
            emit_conversation(app, state, &conv_id).await;
        }
        Ok(false) => { /* duplicate delivery — already stored */ }
        Err(e) => log::debug!("lanchat: insert inbound message failed: {e}"),
    }
    // Ack even duplicates so the sender stops waiting.
    send_ack(state, from, &env.id).await;
}

/// Handle an inbound `text-ack`: mark the referenced message delivered.
pub async fn handle_text_ack(app: &AppHandle, state: &Arc<LanChatState>, env: &Envelope) {
    if let Some(ack_of) = env.payload.get("ackOf").and_then(|v| v.as_str()) {
        let _ = state.store.set_message_state(ack_of, "delivered");
        if let Ok(Some(m)) = state.store.get_message(ack_of) {
            emit_message(app, &m);
        }
    }
}

async fn send_ack(state: &Arc<LanChatState>, to: &str, msg_id: &str) {
    let my_id = state.node_id().await;
    let ack = Envelope::new(
        frame::TEXT_ACK,
        &my_id,
        Some(to.to_string()),
        json!({ "ackOf": msg_id }),
    );
    if let Some(handle) = state.connections.read().await.get(to) {
        let _ = handle.send(ack);
    }
}
