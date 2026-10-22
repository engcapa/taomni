use super::*;

// ── Helpers ─────────────────────────────────────────────────────────

/// Drive the ExtendedClipboard handshake on receipt of a server message.
pub(super) async fn handle_server_ext_clipboard(
    msg: ExtendedClipboardMsg,
    server_caps: &Arc<AsyncMutex<ServerClipboardCaps>>,
    latest_local_clipboard: &Arc<AsyncMutex<Option<ClipboardFormats>>>,
    writer: &Arc<tokio::sync::Mutex<RfbWriter>>,
    ws_out: &FrameQueueSender,
) {
    // We support UTF-8 text, RTF, and HTML — call out our caps with a generous
    // 16 MiB ceiling per format.
    const OUR_CAPS: u32 = FORMAT_TEXT | FORMAT_RTF | FORMAT_HTML;
    const MAX_SIZE: u32 = 16 * 1024 * 1024;

    match msg {
        ExtendedClipboardMsg::Caps {
            formats, actions, ..
        } => {
            log::info!(
                "vnc.clip: ← Caps from server formats={:b} actions={:b} (negotiated {:b})",
                formats,
                actions,
                formats & OUR_CAPS,
            );
            *server_caps.lock().await = ServerClipboardCaps {
                formats: formats & OUR_CAPS,
                actions,
            };
            // Reply with our caps so the server knows what to deliver.
            let body = build_caps_body(OUR_CAPS, MAX_SIZE);
            log::info!(
                "vnc.clip: → Caps to server formats={:b} actions={:b}",
                OUR_CAPS,
                SUPPORTED_ACTIONS,
            );
            let mut w = writer.lock().await;
            let _ = w.send_extended_clipboard(&body);
            // Tell the frontend which clipboard path is active so diagnostics
            // can distinguish ExtendedClipboard from the legacy fallback.
            let support = WsOutgoingText::ExtClipboardSupport {
                available: (formats & OUR_CAPS) != 0
                    && (actions & (ACTION_REQUEST | ACTION_NOTIFY | ACTION_PROVIDE)) != 0,
            };
            if let Ok(json) = serde_json::to_string(&support) {
                let _ = ws_out.send_control(json);
            }
        }
        ExtendedClipboardMsg::Notify { formats } => {
            let want = formats & OUR_CAPS;
            let caps = *server_caps.lock().await;
            log::info!(
                "vnc.clip: ← Notify from server formats={:b}, requesting={:b}",
                formats,
                want,
            );
            if want != 0 && can_send_request(caps) {
                let body = build_request_body(want);
                let mut w = writer.lock().await;
                let _ = w.send_extended_clipboard(&body);
            }
        }
        ExtendedClipboardMsg::Provide {
            formats: _,
            formats_data,
        } => {
            log::info!(
                "vnc.clip: ← Provide from server text_len={} html_len={} rtf_len={}",
                formats_data.text.as_deref().map(str::len).unwrap_or(0),
                formats_data.html.as_deref().map(str::len).unwrap_or(0),
                formats_data.rtf.as_deref().map(str::len).unwrap_or(0),
            );
            let json = serde_json::to_string(&WsOutgoingText::ExtClipboard {
                text: formats_data.text,
                html: formats_data.html,
                rtf: formats_data.rtf,
            })
            .unwrap();
            let _ = ws_out.send_control(json);
        }
        ExtendedClipboardMsg::Request { formats } => {
            log::info!("vnc.clip: ← Request from server formats={:b}", formats);
            let cached = latest_local_clipboard.lock().await.clone();
            if let Some(data) = cached {
                let filtered = filter_clipboard_formats(data, formats & OUR_CAPS);
                if filtered.format_mask() != 0 {
                    if let Ok(body) = build_provide_body(&filtered) {
                        let mut w = writer.lock().await;
                        let _ = w.send_extended_clipboard(&body);
                    }
                }
            }
        }
        ExtendedClipboardMsg::Peek => {
            log::info!("vnc.clip: ← Peek from server");
            let formats = latest_local_clipboard
                .lock()
                .await
                .as_ref()
                .map(|data| data.format_mask() & OUR_CAPS)
                .unwrap_or(0);
            let body = build_notify_body(formats);
            let mut w = writer.lock().await;
            let _ = w.send_extended_clipboard(&body);
        }
    }
}

pub(super) fn filter_clipboard_formats(data: ClipboardFormats, mask: u32) -> ClipboardFormats {
    ClipboardFormats {
        text: if mask & FORMAT_TEXT != 0 {
            data.text
        } else {
            None
        },
        html: if mask & FORMAT_HTML != 0 {
            data.html
        } else {
            None
        },
        rtf: if mask & FORMAT_RTF != 0 {
            data.rtf
        } else {
            None
        },
    }
}

pub(super) fn can_send_request(caps: ServerClipboardCaps) -> bool {
    caps.actions == 0 || caps.actions & ACTION_REQUEST != 0
}

pub(super) fn can_send_notify(caps: ServerClipboardCaps) -> bool {
    caps.actions == 0 || caps.actions & ACTION_NOTIFY != 0
}

pub(super) fn can_send_provide(caps: ServerClipboardCaps) -> bool {
    caps.actions == 0 || caps.actions & ACTION_PROVIDE != 0
}

pub(super) fn server_clipboard_message_allowed(
    message: &ExtendedClipboardMsg,
    policy: VncClipboardPolicy,
) -> bool {
    match message {
        ExtendedClipboardMsg::Caps { .. } => true,
        ExtendedClipboardMsg::Request { .. } | ExtendedClipboardMsg::Peek => {
            policy.allows_client_to_server()
        }
        ExtendedClipboardMsg::Notify { .. } | ExtendedClipboardMsg::Provide { .. } => {
            policy.allows_server_to_client()
        }
    }
}
