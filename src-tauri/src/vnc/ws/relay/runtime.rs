use crate::vnc::clipboard::ClipboardFormats;
use crate::vnc::clipboard::FORMAT_HTML;
use crate::vnc::clipboard::FORMAT_RTF;
use crate::vnc::clipboard::FORMAT_TEXT;
use crate::vnc::clipboard::build_notify_body;
use crate::vnc::clipboard::build_provide_body;
use crate::vnc::native_pointer::NativePointerSampler;
use crate::vnc::policy::VncClipboardPolicy;
use crate::vnc::quality::UpdateSummary;
use crate::vnc::queue::FrameQueueReceiver;
use crate::vnc::queue::FrameQueueSender;
use crate::vnc::queue::QueuedWsOutgoing;
use crate::vnc::rfb::RfbConnection;
use crate::vnc::rfb::RfbWriter;
use crate::vnc::rfb::RuntimeStats;
use crate::vnc::rfb::ServerMessage;
use crate::vnc::ws::FrameFlow;
use crate::vnc::ws::PointerArbiter;
use crate::vnc::ws::RELAY_TICK;
use crate::vnc::ws::ServerClipboardCaps;
use crate::vnc::ws::SharedFrameFlow;
use crate::vnc::ws::SharedQuality;
use crate::vnc::ws::StatsWindow;
use crate::vnc::ws::VncControl;
use crate::vnc::ws::VncRelayOptions;
use crate::vnc::ws::WS_IDLE_CHECK_INTERVAL;
use crate::vnc::ws::WS_IDLE_TIMEOUT;
use crate::vnc::ws::WS_PING_INTERVAL;
use crate::vnc::ws::WsIncoming;
use crate::vnc::ws::WsOutgoingText;
use crate::vnc::ws::clipboard::can_send_notify;
use crate::vnc::ws::clipboard::can_send_provide;
use crate::vnc::ws::clipboard::handle_server_ext_clipboard;
use crate::vnc::ws::clipboard::server_clipboard_message_allowed;
use crate::vnc::ws::frame_flow::apply_pending_quality;
use crate::vnc::ws::frame_flow::damage_full_framebuffer;
use crate::vnc::ws::frame_flow::flush_frame;
use crate::vnc::ws::frame_flow::note_request;
use crate::vnc::ws::frame_flow::quality_ready;
use crate::vnc::ws::frame_flow::stats_labels;
use crate::vnc::ws::input::coalesce_pointer_control;
use crate::vnc::ws::input::control_allowed;
use crate::vnc::ws::input::native_pointer_target;
use crate::vnc::ws::input::parse_binary_control;
use crate::vnc::ws::input::serialize_cursor;
use crate::vnc::ws::transport::accept_authorized_ws;
use futures::SinkExt;
use futures::StreamExt;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::mpsc;
use tokio::sync::mpsc::Receiver;
use tokio::sync::mpsc::Sender;
use tokio_util::sync::CancellationToken;
use tungstenite::Message;

// ── Relay orchestration ─────────────────────────────────────────────

pub(in crate::vnc::ws) async fn run_relay(
    listener: TcpListener,
    mut rfb: RfbConnection,
    writer: Arc<tokio::sync::Mutex<RfbWriter>>,
    ws_out_tx: FrameQueueSender,
    ws_out_rx: FrameQueueReceiver,
    control_tx: Sender<VncControl>,
    mut control_rx: Receiver<VncControl>,
    cancel: CancellationToken,
    ws_token: String,
    shutdown_stream: std::net::TcpStream,
    view_only: bool,
    clipboard_policy: VncClipboardPolicy,
    quality: SharedQuality,
    options: VncRelayOptions,
) -> Result<(), String> {
    let ws_stream = accept_authorized_ws(listener, &ws_token, &cancel).await?;

    let (mut ws_sink, ws_reader) = ws_stream.split();

    // Shared "last time we heard from the frontend" — updated on every ping/control.
    let last_seen = Arc::new(AsyncMutex::new(Instant::now()));

    // Server's advertised ExtendedClipboard formats/actions. Set on receipt of
    // the server's caps message; until then we fall back to plain ClientCutText.
    let server_clip_caps = Arc::new(AsyncMutex::new(ServerClipboardCaps::default()));
    // Cache the latest local clipboard payload so servers that follow the
    // notify/request/provide flow can request it after our paste shortcut.
    let latest_local_clipboard = Arc::new(AsyncMutex::new(None::<ClipboardFormats>));

    // Task: pump outgoing messages → WS sink
    let mut ws_write = tokio::spawn(async move {
        let mut ping = tokio::time::interval(WS_PING_INTERVAL);
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ping.tick().await;
        loop {
            tokio::select! {
                output = ws_out_rx.recv() => {
                    let Some(out) = output else { break; };
                    match out {
                        QueuedWsOutgoing::Control(json) => {
                            if ws_sink.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                        QueuedWsOutgoing::Frame(rects) => {
                            let mut failed = false;
                            for data in rects {
                                if ws_sink.send(Message::Binary(data.into())).await.is_err() {
                                    failed = true;
                                    break;
                                }
                            }
                            if failed
                                || ws_sink
                                    .send(Message::Binary(Vec::new().into()))
                                    .await
                                    .is_err()
                            {
                                break;
                            }
                        }
                    }
                }
                _ = ping.tick() => {
                    if ws_sink
                        .send(Message::Ping(Vec::new().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });

    // Task: read WS messages → control_tx
    let ctrl = control_tx.clone();
    let cancel_read = cancel.clone();
    let last_seen_read = last_seen.clone();
    let control_limits = crate::vnc::limits::DecodeLimits::default();
    let mut ws_read = tokio::spawn(async move {
        let mut reader = ws_reader;
        while let Some(Ok(msg)) = reader.next().await {
            if cancel_read.is_cancelled() {
                break;
            }
            // Any inbound message counts as the frontend being alive.
            *last_seen_read.lock().await = Instant::now();
            match msg {
                Message::Text(text) => {
                    if let Ok(incoming) = serde_json::from_str::<WsIncoming>(&text) {
                        let ctrl_msg = match incoming {
                            WsIncoming::Ack => Some(VncControl::Ack),
                            WsIncoming::Ping => None, // already refreshed last_seen
                            WsIncoming::Key { down, keysym } => {
                                Some(VncControl::Key { down, keysym })
                            }
                            WsIncoming::Pointer { x, y, buttons } => {
                                Some(VncControl::Pointer { x, y, buttons })
                            }
                            WsIncoming::Clipboard { text } => {
                                log::info!(
                                    "vnc.clip: ws→relay legacy clipboard, len={}",
                                    text.len()
                                );
                                Some(VncControl::Clipboard(text))
                            }
                            WsIncoming::ExtClipboard { text, html, rtf } => {
                                log::info!(
                                    "vnc.clip: ws→relay ext clipboard text_len={} html_len={} rtf_len={}",
                                    text.as_deref().map(str::len).unwrap_or(0),
                                    html.as_deref().map(str::len).unwrap_or(0),
                                    rtf.as_deref().map(str::len).unwrap_or(0),
                                );
                                Some(VncControl::ExtendedClipboard(ClipboardFormats {
                                    text,
                                    html,
                                    rtf,
                                }))
                            }
                            WsIncoming::Refresh => Some(VncControl::Refresh),
                            WsIncoming::NativePointer {
                                on,
                                left,
                                top,
                                width,
                                height,
                                dpr,
                                fb_width,
                                fb_height,
                            } => Some(VncControl::NativePointer(native_pointer_target(
                                on, left, top, width, height, dpr, fb_width, fb_height,
                            ))),
                        };
                        if let Some(m) = ctrl_msg
                            && control_allowed(&m, view_only, clipboard_policy, &control_limits)
                            && ctrl.send(m).await.is_err()
                        {
                            break;
                        }
                    }
                }
                Message::Binary(bytes) => {
                    if let Some(ctrl_msg) = parse_binary_control(&bytes)
                        && control_allowed(&ctrl_msg, view_only, clipboard_policy, &control_limits)
                        && ctrl.send(ctrl_msg).await.is_err()
                    {
                        break;
                    }
                }
                Message::Close(_) => {
                    let _ = ctrl.send(VncControl::Disconnect).await;
                    break;
                }
                _ => {}
            }
        }
    });

    // The RFB decoder is synchronous and may wait on a socket. Keep it on a
    // dedicated blocking worker and bridge decoded messages through a bounded
    // channel so no Tokio executor thread is stalled by a slow server.
    let initial_framebuffer_size = (rfb.width, rfb.height);
    let framebuffer = rfb.framebuffer();
    let flow: SharedFrameFlow = Arc::new(std::sync::Mutex::new(FrameFlow::new()));
    let (server_message_tx, mut server_message_rx) =
        mpsc::channel::<Result<(ServerMessage, u16, u16, RuntimeStats), String>>(2);
    let cancel_reader = cancel.clone();
    let rfb_reader = tokio::task::spawn_blocking(move || {
        while !cancel_reader.is_cancelled() {
            let result = rfb
                .read_server_message()
                .map(|message| (message, rfb.width, rfb.height, rfb.runtime_stats()));
            let should_stop = result.is_err();
            if server_message_tx.blocking_send(result).is_err() || should_stop {
                break;
            }
        }
    });

    // Task: process decoded server messages and push them to the WS queue.
    let rfb_writer_for_read = writer.clone();
    let ws_out = ws_out_tx.clone();
    let server_caps_read = server_clip_caps.clone();
    let latest_clipboard_read = latest_local_clipboard.clone();
    let writer_for_caps = writer.clone();
    let flow_read = flow.clone();
    let framebuffer_read = framebuffer.clone();
    let quality_read = quality.clone();
    let mut vnc_read = tokio::spawn(async move {
        let mut published_framebuffer_size = initial_framebuffer_size;
        let mut framebuffer_generation = 0u64;
        let mut window = StatsWindow::new();
        while let Some(result) = server_message_rx.recv().await {
            if let Ok(mut flow) = flow_read.lock() {
                flow.last_server_at = Instant::now();
                flow.probe_sent_at = None;
            }
            let (msg, fb_width, fb_height, stats) = match result {
                Ok(value) => value,
                Err(message) => {
                    let error = crate::vnc::error::VncError::classify(message);
                    let json = serde_json::to_string(&WsOutgoingText::Disconnected {
                        code: error.code,
                        stage: error.stage,
                        retryable: error.retryable,
                        reason: error.message,
                    })
                    .unwrap();
                    let _ = ws_out.send_critical_control(json);
                    break;
                }
            };
            match msg {
                ServerMessage::FramebufferUpdate {
                    rects,
                    cursor,
                    pointer_pos,
                } => {
                    if (fb_width, fb_height) != published_framebuffer_size {
                        framebuffer_generation = framebuffer_generation.saturating_add(1);
                        published_framebuffer_size = (fb_width, fb_height);
                        // Frames of the old geometry are obsolete; the WebView
                        // also drops whatever it had queued on desktop_size.
                        ws_out.clear_frames();
                        if let Ok(mut flow) = flow_read.lock() {
                            flow.damage.clear();
                            flow.frontend_ready = true;
                        }
                        let json = serde_json::to_string(&WsOutgoingText::DesktopSize {
                            width: fb_width,
                            height: fb_height,
                            generation: framebuffer_generation,
                        })
                        .unwrap();
                        let _ = ws_out.send_critical_control(json);
                    }
                    if let Ok(mut quality) = quality_read.lock() {
                        quality.observe_update(UpdateSummary {
                            pixel_rects: stats.last_update_pixel_rects,
                            tight_rects: stats.last_update_tight_rects,
                            compressed_rects: stats.last_update_compressed_rects,
                            raw_pixels: stats.last_update_raw_pixels,
                        });
                    }
                    let request_now = {
                        match flow_read.lock() {
                            Ok(mut flow) => {
                                flow.outstanding = flow.outstanding.saturating_sub(1);
                                flow.last_update_at = Instant::now();
                                // Keep one screen frame in flight. This is
                                // deliberately based on damage rather than
                                // server timing: a slow old VNC server must
                                // not receive another expensive request while
                                // WebKit is still painting the previous one.
                                flow.note_update(rects)
                            }
                            Err(_) => true,
                        }
                    };
                    {
                        let mut writer = rfb_writer_for_read.lock().await;
                        writer.set_framebuffer_size(fb_width, fb_height);
                        let pending_quality = quality_read
                            .lock()
                            .map(|quality| quality.has_pending())
                            .unwrap_or(false);
                        if pending_quality && quality_ready(&quality_read, &flow_read) {
                            // The switch includes its own full update request.
                            if let Err(error) =
                                apply_pending_quality(&mut writer, &quality_read, &flow_read)
                            {
                                tracing::warn!(%error, "VNC picture quality switch failed");
                            }
                        } else if request_now && !pending_quality {
                            // Empty/cursor-only updates do not occupy the canvas;
                            // keep polling those without waiting for an ACK.
                            if writer.request_update(true).is_ok() {
                                note_request(&flow_read);
                            }
                        } else if request_now {
                            // A pixel-format switch waits for the outstanding
                            // update; no new request until it has been sent.
                            if let Ok(mut flow) = flow_read.lock() {
                                flow.request_deferred = false;
                            }
                        }
                    }
                    if let Some(cursor) = cursor {
                        match serialize_cursor(cursor) {
                            Ok(json) => {
                                let _ = ws_out.send_control(json);
                            }
                            Err(error) => {
                                tracing::warn!(%error, "ignoring invalid VNC cursor update");
                            }
                        }
                    }
                    if let Some(pointer_pos) = pointer_pos {
                        let json = serde_json::to_string(&WsOutgoingText::PointerPos {
                            x: pointer_pos.x,
                            y: pointer_pos.y,
                        })
                        .unwrap();
                        let _ = ws_out.send_control(json);
                    }
                    flush_frame(&flow_read, &framebuffer_read, &ws_out);
                    let frames_sent = flow_read.lock().map(|flow| flow.frames_sent).unwrap_or(0);
                    let labels = stats_labels(&quality_read);
                    if let Some(json) = window.observe(stats, frames_sent, &labels) {
                        if let Ok(mut quality) = quality_read.lock() {
                            quality.observe_line_speed(window.line_kbps);
                        }
                        let _ = ws_out.send_control(json);
                    }
                }
                ServerMessage::Bell => {
                    let json = serde_json::to_string(&WsOutgoingText::Bell).unwrap();
                    let _ = ws_out.send_control(json);
                }
                ServerMessage::ServerCutText { text } => {
                    if !clipboard_policy.allows_server_to_client() {
                        continue;
                    }
                    log::info!("vnc.clip: server→client legacy cut text len={}", text.len());
                    let json = serde_json::to_string(&WsOutgoingText::Clipboard { text }).unwrap();
                    let _ = ws_out.send_control(json);
                }
                ServerMessage::ExtendedClipboard(ext) => {
                    if !server_clipboard_message_allowed(&ext, clipboard_policy) {
                        continue;
                    }
                    log::info!("vnc.clip: server→client ext clipboard message");
                    handle_server_ext_clipboard(
                        ext,
                        &server_caps_read,
                        &latest_clipboard_read,
                        &writer_for_caps,
                        &ws_out,
                    )
                    .await;
                }
                ServerMessage::SetColourMapEntries => {}
            }
        }
    });

    // Task: control loop — process commands from WS client
    let rfb_ctrl = writer.clone();
    let cl_cancel = cancel.clone();
    let server_caps_ctrl = server_clip_caps.clone();
    let latest_clipboard_ctrl = latest_local_clipboard.clone();
    let dispatch_limits = crate::vnc::limits::DecodeLimits::default();
    let flow_ctrl = flow.clone();
    let framebuffer_ctrl = framebuffer.clone();
    let ws_out_ctrl = ws_out_tx.clone();
    let quality_ctrl = quality.clone();
    let native_pointer_tx = control_tx.clone();
    let mut vnc_ctrl = tokio::spawn(async move {
        let mut deferred_ctrl: Option<VncControl> = None;
        let mut last_pointer_buttons = 0u8;
        // Dropped with this task, which stops its sampling thread.
        let mut native_pointer = NativePointerSampler::new();
        let mut pointer_arbiter = PointerArbiter::default();
        loop {
            let ctrl = match deferred_ctrl.take() {
                Some(ctrl) => ctrl,
                None => match control_rx.recv().await {
                    Some(ctrl) => ctrl,
                    None => break,
                },
            };
            if cl_cancel.is_cancelled() {
                break;
            }
            let ctrl = coalesce_pointer_control(
                ctrl,
                &mut control_rx,
                &mut deferred_ctrl,
                last_pointer_buttons,
            );
            if let VncControl::Pointer { buttons, .. } = &ctrl {
                last_pointer_buttons = *buttons;
                native_pointer.set_buttons_held(*buttons != 0);
            }
            if !control_allowed(&ctrl, view_only, clipboard_policy, &dispatch_limits) {
                continue;
            }
            if let VncControl::Pointer { x, y, buttons } = &ctrl
                && !pointer_arbiter.web(*x, *y, *buttons, Instant::now())
            {
                continue;
            }
            let result = match ctrl {
                VncControl::Ack => {
                    // The WebView painted the previous frame: hand it the
                    // accumulated damage. If another frame was sent, wait for
                    // its ACK before requesting more pixels from the server.
                    if let Ok(mut flow) = flow_ctrl.lock() {
                        flow.frontend_ready = true;
                    }
                    flush_frame(&flow_ctrl, &framebuffer_ctrl, &ws_out_ctrl);
                    let mut writer = rfb_ctrl.lock().await;
                    let request_now = flow_ctrl
                        .lock()
                        .map(|mut flow| flow.take_deferred_request())
                        .unwrap_or(false);
                    if request_now {
                        if quality_ready(&quality_ctrl, &flow_ctrl) {
                            apply_pending_quality(&mut writer, &quality_ctrl, &flow_ctrl)
                                .map(|_| ())
                        } else {
                            let result = writer.request_update(true);
                            if result.is_ok() {
                                note_request(&flow_ctrl);
                            }
                            result
                        }
                    } else {
                        Ok(())
                    }
                }
                VncControl::Key { down, keysym } => {
                    rfb_ctrl.lock().await.send_key_event(down, keysym)
                }
                VncControl::Pointer { x, y, buttons } => {
                    rfb_ctrl.lock().await.send_pointer_event(x, y, buttons)
                }
                VncControl::Clipboard(text) => {
                    log::debug!("vnc.clip: relay→server legacy cut text len={}", text.len());
                    rfb_ctrl.lock().await.send_client_cut_text(&text)
                }
                VncControl::ExtendedClipboard(formats) => {
                    let server_caps = *server_caps_ctrl.lock().await;
                    *latest_clipboard_ctrl.lock().await = Some(formats.clone());
                    let mut conn = rfb_ctrl.lock().await;
                    if server_caps.formats == 0 {
                        // No caps received — server doesn't support ExtendedClipboard.
                        // Send UTF-8 bytes via legacy ClientCutText. RFC 6143 nominally
                        // specifies Latin-1, but vino and most modern servers accept UTF-8
                        // and write it directly into the X11 selection (which is UTF-8).
                        if let Some(text) = formats.text.as_deref() {
                            log::info!(
                                "vnc.clip: relay→server FALLBACK (no ext caps), sending legacy cut text (UTF-8) len={}",
                                text.len(),
                            );
                            conn.send_client_cut_text(text)
                        } else {
                            Ok(())
                        }
                    } else {
                        // Filter to formats the server actually supports.
                        let filtered = ClipboardFormats {
                            text: if server_caps.formats & FORMAT_TEXT != 0 {
                                formats.text
                            } else {
                                None
                            },
                            html: if server_caps.formats & FORMAT_HTML != 0 {
                                formats.html
                            } else {
                                None
                            },
                            rtf: if server_caps.formats & FORMAT_RTF != 0 {
                                formats.rtf
                            } else {
                                None
                            },
                        };
                        if filtered.format_mask() == 0 {
                            log::info!(
                                "vnc.clip: relay→server skip — server caps {:b} don't overlap with our payload",
                                server_caps.formats,
                            );
                            Ok(())
                        } else {
                            log::info!(
                                "vnc.clip: relay→server ext (server caps fmt={:b} actions={:b}) text_len={}",
                                server_caps.formats,
                                server_caps.actions,
                                filtered.text.as_deref().map(str::len).unwrap_or(0),
                            );
                            if can_send_notify(server_caps) {
                                conn.send_extended_clipboard(&build_notify_body(
                                    filtered.format_mask(),
                                ))
                            } else if can_send_provide(server_caps) {
                                match build_provide_body(&filtered) {
                                    Ok(body) => conn.send_extended_clipboard(&body),
                                    Err(e) => Err(e),
                                }
                            } else {
                                Ok(())
                            }
                        }
                    }
                }
                VncControl::Refresh => {
                    // The WebView lost pixels (or the user asked to refresh):
                    // repaint from the authoritative framebuffer right away and
                    // also ask the server for a full update.
                    if let Ok(mut flow) = flow_ctrl.lock() {
                        flow.frontend_ready = true;
                        flow.request_deferred = false;
                    }
                    damage_full_framebuffer(&flow_ctrl, &framebuffer_ctrl);
                    flush_frame(&flow_ctrl, &framebuffer_ctrl, &ws_out_ctrl);
                    let result = rfb_ctrl.lock().await.request_update(false);
                    if result.is_ok() {
                        note_request(&flow_ctrl);
                    }
                    result
                }
                VncControl::SetQuality(preset) => {
                    if let Ok(mut quality) = quality_ctrl.lock() {
                        quality.set_preset(preset);
                    }
                    if quality_ready(&quality_ctrl, &flow_ctrl) {
                        let mut writer = rfb_ctrl.lock().await;
                        apply_pending_quality(&mut writer, &quality_ctrl, &flow_ctrl).map(|_| ())
                    } else {
                        Ok(())
                    }
                }
                VncControl::NativePointer(target) => {
                    pointer_arbiter.set_native(target.is_some());
                    native_pointer.set(target, &native_pointer_tx);
                    Ok(())
                }
                VncControl::SampledPointer { x, y } => {
                    if pointer_arbiter.sample(x, y, Instant::now()) {
                        rfb_ctrl.lock().await.send_pointer_event(x, y, 0)
                    } else {
                        Ok(())
                    }
                }
                VncControl::Disconnect => {
                    cl_cancel.cancel();
                    Ok(())
                }
            };
            if let Err(e) = result {
                tracing::error!("VNC control error: {}", e);
            }
        }
    });

    // Task: relay tick — force an overdue pixel-format switch (the server
    // merged our requests) and run the KeepAlive probe (VNC-SESS-003).
    let tick_flow = flow.clone();
    let tick_quality = quality.clone();
    let tick_writer = writer.clone();
    let tick_out = ws_out_tx.clone();
    let tick_cancel = cancel.clone();
    let mut relay_tick = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(RELAY_TICK);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = tick_cancel.cancelled() => break,
            }
            let (last_update, last_server, probe_sent) = match tick_flow.lock() {
                Ok(flow) => (flow.last_update_at, flow.last_server_at, flow.probe_sent_at),
                Err(_) => break,
            };
            let overdue = tick_quality
                .lock()
                .map(|quality| quality.pending_overdue(last_update))
                .unwrap_or(false);
            if overdue {
                if let Ok(mut flow) = tick_flow.lock() {
                    flow.outstanding = 0;
                }
                let mut writer = tick_writer.lock().await;
                if let Err(error) = apply_pending_quality(&mut writer, &tick_quality, &tick_flow) {
                    tracing::warn!(%error, "VNC picture quality switch failed");
                }
            }
            match probe_sent {
                Some(sent) if sent.elapsed() >= options.keepalive_timeout => {
                    let error = crate::vnc::error::VncError::classify(format!(
                        "VNC keepalive: no response from the server for {} s",
                        (last_server.elapsed().as_secs())
                    ));
                    let json = serde_json::to_string(&WsOutgoingText::Disconnected {
                        code: error.code,
                        stage: error.stage,
                        retryable: error.retryable,
                        reason: error.message,
                    })
                    .unwrap();
                    let _ = tick_out.send_critical_control(json);
                    // Give the writer a moment to deliver the reason.
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    tick_cancel.cancel();
                    break;
                }
                None if last_server.elapsed() >= options.keepalive_interval => {
                    let sent = tick_writer.lock().await.request_probe();
                    if sent.is_ok() {
                        if let Ok(mut flow) = tick_flow.lock() {
                            flow.outstanding = flow.outstanding.saturating_add(1);
                            flow.probe_sent_at = Some(Instant::now());
                        }
                    }
                }
                _ => {}
            }
        }
    });

    // Task: idle watchdog — if the frontend stops pinging, tear everything down.
    let watchdog_cancel = cancel.clone();
    let watchdog_last_seen = last_seen.clone();
    let mut idle_watch = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(WS_IDLE_CHECK_INTERVAL);
        // The first tick fires immediately; skip it so we don't race the ws_read task.
        ticker.tick().await;
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let elapsed = watchdog_last_seen.lock().await.elapsed();
                    if elapsed > WS_IDLE_TIMEOUT {
                        tracing::warn!(
                            "VNC relay idle for {:?} (> {:?}); disconnecting",
                            elapsed,
                            WS_IDLE_TIMEOUT
                        );
                        watchdog_cancel.cancel();
                        break;
                    }
                }
                _ = watchdog_cancel.cancelled() => break,
            }
        }
    });

    // Wait for any critical task to finish, then cancel everything
    tokio::select! {
        _ = cancel.cancelled() => {},
        _ = tokio::signal::ctrl_c() => {},
        r = &mut ws_write => {
            if let Err(e) = r { tracing::error!("ws_write: {}", e); }
        }
        r = &mut ws_read => {
            if let Err(e) = r { tracing::error!("ws_read: {}", e); }
        }
        r = &mut vnc_read => {
            if let Err(e) = r { tracing::error!("vnc_read: {}", e); }
        }
        r = &mut vnc_ctrl => {
            if let Err(e) = r { tracing::error!("vnc_ctrl: {}", e); }
        }
        r = &mut idle_watch => {
            if let Err(e) = r { tracing::error!("idle_watch: {}", e); }
        }
        r = &mut relay_tick => {
            if let Err(e) = r { tracing::error!("relay_tick: {}", e); }
        }
    }

    cancel.cancel();
    // Closing the underlying socket interrupts the blocking runtime read.
    let _ = shutdown_stream.shutdown(std::net::Shutdown::Both);
    rfb_reader.abort();
    ws_write.abort();
    ws_read.abort();
    vnc_read.abort();
    vnc_ctrl.abort();
    idle_watch.abort();
    relay_tick.abort();
    Ok(())
}
