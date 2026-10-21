use super::peer_exchange::handle_peer_exchange;
use crate::lanchat::LanChatState;
use crate::lanchat::protocol::Envelope;
use crate::lanchat::protocol::frame;
use serde_json::json;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Emitter;

/// Route an inbound frame. Phase 4 handles keepalive; phase 5 adds text
/// messaging; later phases extend with file-*, signal-*, wb-*.
pub(super) async fn dispatch_inbound(
    app: &AppHandle,
    state: &Arc<LanChatState>,
    peer_id: &str,
    my_id: &str,
    env: Envelope,
) {
    match env.frame_type.as_str() {
        frame::PING => {
            let conns = state.connections.read().await;
            if let Some(handle) = conns.get(peer_id) {
                let _ = handle.send(Envelope::new(
                    frame::PONG,
                    my_id,
                    Some(peer_id.to_string()),
                    json!({}),
                ));
            }
        }
        frame::PONG => {
            if let Some(peer) = state.peers.write().await.get_mut(peer_id) {
                peer.last_seen = chrono::Utc::now().timestamp_millis();
            }
        }
        frame::TEXT_MSG => {
            crate::lanchat::messaging::handle_text_msg(app, state, peer_id, &env).await;
        }
        frame::TEXT_ACK => {
            crate::lanchat::messaging::handle_text_ack(app, state, &env).await;
        }
        frame::GROUP_ANNOUNCE => {
            crate::lanchat::messaging::handle_group_announce(app, state, &env).await;
        }
        frame::GROUP_JOIN | frame::GROUP_LEAVE => {
            crate::lanchat::messaging::handle_group_membership(app, state, &env).await;
        }
        frame::SWARM_OFFER => {
            crate::lanchat::swarm::handle_offer(app, state, peer_id, &env).await;
        }
        frame::SWARM_ACCEPT => {
            crate::lanchat::swarm::handle_accept(app, state, peer_id, &env).await;
        }
        frame::SWARM_REJECT => {
            crate::lanchat::swarm::handle_reject(app, state, peer_id, &env).await;
        }
        frame::SWARM_REQUEST => {
            crate::lanchat::swarm::handle_request(state, peer_id, &env).await;
        }
        frame::SWARM_HAVE => {
            crate::lanchat::swarm::handle_have(app, state, peer_id, &env).await;
        }
        frame::SWARM_BITFIELD => {
            crate::lanchat::swarm::handle_bitfield(app, state, peer_id, &env).await;
        }
        frame::SWARM_CANCEL => {
            crate::lanchat::swarm::handle_cancel(app, state, peer_id, &env).await;
        }
        frame::CALL_INVITE
        | frame::CALL_ACCEPT
        | frame::CALL_REJECT
        | frame::CALL_CANCEL
        | frame::CALL_END
        | frame::SIGNAL_SDP
        | frame::SIGNAL_ICE
        | frame::MEETING_JOIN
        | frame::MEETING_LEAVE
        | frame::MEDIA_STATE
        | frame::NMEDIA_OFFER
        | frame::NMEDIA_ANSWER
        | frame::NMEDIA_STOP => {
            // Relay call signaling to the frontend. The WebRTC stack (lanRtc)
            // consumes signal-sdp/ice; the native stack consumes nmedia-*.
            let _ = app.emit(
                crate::lanchat::events::SIGNAL,
                &json!({ "from": peer_id, "type": env.frame_type, "payload": env.payload }),
            );
        }
        frame::WB_OPEN
        | frame::WB_INVITE
        | frame::WB_JOIN
        | frame::WB_LEAVE
        | frame::WB_OP
        | frame::WB_CURSOR
        | frame::WB_SNAPSHOT_REQ
        | frame::WB_SNAPSHOT => {
            // Relay whiteboard frames to the frontend (Yjs provider handles them).
            let _ = app.emit(
                crate::lanchat::events::WB,
                &json!({ "from": peer_id, "type": env.frame_type, "payload": env.payload }),
            );
        }
        frame::PEER_EXCHANGE => {
            handle_peer_exchange(app, state, peer_id, &env).await;
        }
        other => {
            log::debug!("lanchat: unhandled frame '{other}' from {peer_id}");
        }
    }
}
