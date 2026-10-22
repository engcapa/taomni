use super::*;

impl RdpSessionHandle {
    pub fn new() -> (Self, SessionOutputSender, UnboundedReceiver<RdpControl>) {
        let output = SessionOutputQueue::new();
        let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();
        (
            Self {
                output: output.clone(),
                active_frame: VecDeque::new(),
                ctrl_tx,
            },
            SessionOutputSender(output),
            ctrl_rx,
        )
    }

    pub async fn next_outgoing(&mut self) -> Option<SessionOutput> {
        if let Some(output) = self.active_frame.pop_front() {
            return Some(output);
        }
        match self.output.recv().await? {
            QueuedSessionOutput::Control(output) => Some(output),
            QueuedSessionOutput::FrameBatch(batch) => {
                self.active_frame = batch
                    .into_iter()
                    .map(|payload| SessionOutput::Channel {
                        tag: channel::FRAME,
                        payload,
                    })
                    .collect();
                self.active_frame.push_back(SessionOutput::Channel {
                    tag: channel::FRAME_END,
                    payload: Vec::new(),
                });
                self.active_frame.pop_front()
            }
        }
    }

    pub async fn dispatch_control(&self, ctrl: RdpControl) -> Result<(), String> {
        self.ctrl_tx
            .send(ctrl)
            .map_err(|_| "rdp session: ctrl channel closed".to_string())
    }
}

impl Drop for RdpSessionHandle {
    fn drop(&mut self) {
        self.output.close();
    }
}

pub fn start_ironrdp_session(cfg: RdpSessionConfig) -> RdpSessionHandle {
    let (handle, out_tx, ctrl_rx) = RdpSessionHandle::new();
    tokio::spawn(async move {
        if let Err(e) = drive_ironrdp_session(cfg, out_tx.clone(), ctrl_rx).await {
            send_error(&out_tx, "rdp-session", &e);
        }
    });
    handle
}

pub async fn test_ironrdp_connection(
    cfg: RdpSessionConfig,
    timeout: std::time::Duration,
) -> Result<RdpConnectionTestResult, String> {
    let mut handle = start_ironrdp_session(cfg);
    let deadline = tokio::time::Instant::now() + timeout;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            let _ = handle.dispatch_control(RdpControl::Disconnect).await;
            return Err("RDP test timed out before the session reached connected state".into());
        }

        let output = tokio::time::timeout(remaining, handle.next_outgoing())
            .await
            .map_err(|_| {
                "RDP test timed out before the session reached connected state".to_string()
            })?
            .ok_or_else(|| {
                "RDP test ended before the session reached connected state".to_string()
            })?;

        match output {
            SessionOutput::Text(text) => {
                if let Some(result) = parse_connected_event(&text)? {
                    let _ = handle.dispatch_control(RdpControl::Disconnect).await;
                    return Ok(result);
                }
            }
            SessionOutput::Channel { .. } => {}
        }
    }
}

pub(super) async fn drive_ironrdp_session(
    cfg: RdpSessionConfig,
    out_tx: SessionOutputSender,
    mut ctrl_rx: UnboundedReceiver<RdpControl>,
) -> Result<(), String> {
    install_rustls_crypto_provider();

    let RdpSessionConfig {
        stream,
        local_addr,
        host,
        port,
        username,
        password,
        options,
        network,
    } = cfg;
    let mut settings = RdpConnectionSettings {
        host,
        port,
        username,
        password,
        options,
        network,
    };
    let mut next_transport = Some(RdpSessionTransport { stream, local_addr });

    loop {
        let transport = match next_transport.take() {
            Some(transport) => transport,
            None => {
                let transport = open_transport(
                    &settings.host,
                    settings.port,
                    settings.network.as_ref(),
                    settings.options.gateway.as_ref(),
                )
                .await?;
                RdpSessionTransport {
                    stream: transport.stream,
                    local_addr: transport.local_addr,
                }
            }
        };

        match drive_ironrdp_connection(&settings, transport, out_tx.clone(), &mut ctrl_rx).await? {
            SessionRunOutcome::Closed => {
                send_text(
                    &out_tx,
                    json!({
                        "type": "disconnected",
                        "reason": "RDP session closed",
                    })
                    .to_string(),
                );
                return Ok(());
            }
            SessionRunOutcome::Reconnect { width, height } => {
                settings.options.screen_w = width;
                settings.options.screen_h = height;
                send_status(
                    &out_tx,
                    "reconnecting",
                    "Reconnecting the RDP session at the requested desktop size.",
                );
            }
        }
    }
}

pub(super) async fn drive_ironrdp_connection(
    cfg: &RdpConnectionSettings,
    transport: RdpSessionTransport,
    out_tx: SessionOutputSender,
    ctrl_rx: &mut UnboundedReceiver<RdpControl>,
) -> Result<SessionRunOutcome, String> {
    send_status(
        &out_tx,
        "tcp-connected",
        "TCP/proxy tunnel established; starting IronRDP connector.",
    );

    let config = build_ironrdp_config(cfg);

    let clipboard = cfg
        .options
        .redirect_clipboard
        .then(|| ClipboardBridge::new(out_tx.clone()));
    let mut connector = connector::ClientConnector::new(config, transport.local_addr);
    if let Some(clipboard) = &clipboard {
        connector.attach_static_channel(CliprdrClient::new(Box::new(clipboard.backend())));
    }
    let drive_channel =
        crate::rdp::rdpdr::build_drive_channel(&cfg.options.redirect_drive, Some(out_tx.clone()))?;
    let display_control_out = out_tx.clone();
    connector.attach_static_channel(DrdynvcClient::new().with_dynamic_channel(
        DisplayControlClient::new(move |caps| {
            tracing::debug!(?caps, "RDP display control capabilities received");
            send_status(
                &display_control_out,
                "display-control-ready",
                "RDP display control virtual channel is ready.",
            );
            Ok(Vec::new())
        }),
    ));
    let needs_rdpsnd_channel = cfg.options.redirect_audio == "play" || drive_channel.is_some();
    if needs_rdpsnd_channel {
        connector
            .attach_static_channel(Rdpsnd::new(Box::new(RdpsndWsBackend::new(out_tx.clone()))));
        if cfg.options.redirect_audio == "play" {
            send_status(
                &out_tx,
                "audio-enabled",
                "RDP audio playback channel requested.",
            );
        } else {
            send_status(
                &out_tx,
                "audio-helper-enabled",
                "RDPSND helper channel enabled for drive redirection.",
            );
        }
    }
    if let Some(rdpdr) = drive_channel {
        connector.attach_static_channel(rdpdr);
        send_status(
            &out_tx,
            "drive-enabled",
            "RDP drive redirection channel requested.",
        );
    }
    let mut framed = ironrdp_tokio::TokioFramed::new(transport.stream);

    send_status(&out_tx, "negotiating", "Negotiating RDP security protocol.");
    let should_upgrade = tokio::time::timeout(
        RDP_NEGOTIATION_TIMEOUT,
        ironrdp_tokio::connect_begin(&mut framed, &mut connector),
    )
    .await
    .map_err(|_| {
        format!(
            "RDP negotiation timed out after {} seconds",
            RDP_NEGOTIATION_TIMEOUT.as_secs()
        )
    })?
    .map_err(negotiation_error)?;

    send_status(&out_tx, "tls", "Upgrading the transport to TLS.");
    let stream = framed.into_inner_no_leftover();
    let verified = tokio::time::timeout(
        RDP_TLS_TIMEOUT,
        crate::rdp::tls::upgrade(
            stream,
            &cfg.host,
            cfg.port,
            cfg.options.certificate_fingerprint.as_deref(),
        ),
    )
    .await
    .map_err(|_| {
        format!(
            "RDP TLS handshake timed out after {} seconds",
            RDP_TLS_TIMEOUT.as_secs()
        )
    })?
    .map_err(|e| format!("rdp TLS upgrade failed: {}", e))?;
    send_status(
        &out_tx,
        if verified.used_pin {
            "tls-pinned"
        } else {
            "tls-verified"
        },
        &format!(
            "RDP certificate verified (SHA-256 {}).",
            crate::rdp::tls::format_fingerprint(&verified.fingerprint)
        ),
    );
    let server_public_key = verified.server_public_key;

    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
    let mut framed = ironrdp_tokio::TokioFramed::new(verified.stream);
    let mut network_client = ironrdp_tokio::reqwest::ReqwestNetworkClient::new();

    send_status(&out_tx, "credssp", "Authenticating with CredSSP/NLA.");
    let connection_result = tokio::time::timeout(
        RDP_AUTHENTICATION_TIMEOUT,
        ironrdp_tokio::connect_finalize(
            upgraded,
            connector,
            &mut framed,
            &mut network_client,
            cfg.host.clone().into(),
            server_public_key,
            None,
        ),
    )
    .await
    .map_err(|_| {
        format!(
            "RDP authentication timed out after {} seconds",
            RDP_AUTHENTICATION_TIMEOUT.as_secs()
        )
    })?
    .map_err(|e| format!("rdp connection finalization failed: {}", e))?;

    let protocol = if cfg.options.nla {
        "CredSSP/NLA"
    } else {
        "TLS"
    };
    let server_name = cfg.host.clone();
    let width = connection_result.desktop_size.width;
    let height = connection_result.desktop_size.height;
    let activation_factory = connection_result.activation_factory.clone();
    send_connected_event(&out_tx, width, height, protocol, &server_name);
    #[cfg(debug_assertions)]
    let qa_capture_connection = super::super::qa_graphics_capture::begin(
        width,
        height,
        connection_result.user_channel_id,
        connection_result.io_channel_id,
        connection_result.share_id,
    );

    let mut image = IronDecodedImage::new(PixelFormat::RgbA32, width, height);
    let mut active_stage = ActiveStageBuilder {
        static_channels: connection_result.static_channels,
        user_channel_id: connection_result.user_channel_id,
        io_channel_id: connection_result.io_channel_id,
        message_channel_id: connection_result.message_channel_id,
        share_id: connection_result.share_id,
        compression_type: connection_result.compression_type,
        enable_server_pointer: connection_result.enable_server_pointer,
        pointer_software_rendering: connection_result.pointer_software_rendering,
    }
    .build();
    let mut input_db = InputDatabase::new();
    let mut last_buttons = 0u8;
    let mut reactivation: Option<ConnectionActivationSequence> = None;

    loop {
        tokio::select! {
            ctrl = ctrl_rx.recv() => {
                let Some(ctrl) = ctrl else { break; };
                if reactivation.is_some() {
                    match ctrl {
                        RdpControl::Disconnect => break,
                        RdpControl::Ack => {}
                        RdpControl::ReleaseInput => {
                            let _ = input_db.release_all();
                            last_buttons = 0;
                        }
                        _ => send_status(
                            &out_tx,
                            "reactivating",
                            "RDP session is reactivating after a desktop resize.",
                        ),
                    }
                    continue;
                }
                match handle_control(
                    ctrl,
                    &mut active_stage,
                    &mut image,
                    &mut input_db,
                    &mut last_buttons,
                    &mut framed,
                    &out_tx,
                    clipboard.as_ref(),
                    &activation_factory,
                    &mut reactivation,
                ).await? {
                    ControlOutcome::Continue => {}
                    ControlOutcome::Disconnect => break,
                    ControlOutcome::Reconnect { width, height } => {
                        return Ok(SessionRunOutcome::Reconnect { width, height });
                    }
                }
                if reactivation.is_none() {
                    if let Some(clipboard) = &clipboard {
                    drain_clipboard_actions(&mut active_stage, clipboard, &mut framed, &out_tx).await?;
                    }
                }
            }
            read = framed.read_pdu() => {
                let (action, payload) = read.map_err(|e| format!("rdp read frame: {}", e))?;
                #[cfg(debug_assertions)]
                super::super::qa_graphics_capture::packet(qa_capture_connection, &format!("{action:?}"), &payload);
                if let Some(sequence) = reactivation.as_mut() {
                    if matches!(action, Action::X224) {
                        if process_reactivation_frame(
                            sequence,
                            &payload,
                            &mut active_stage,
                            &mut image,
                            &mut framed,
                            &out_tx,
                            protocol,
                            &server_name,
                        )
                        .await?
                        {
                            #[cfg(debug_assertions)]
                            super::super::qa_graphics_capture::resized(qa_capture_connection, image.width(), image.height());
                            reactivation = None;
                            if let Some(clipboard) = &clipboard {
                                drain_clipboard_actions(&mut active_stage, clipboard, &mut framed, &out_tx).await?;
                            }
                        }
                    } else {
                        // In-flight pointer/graphics updates still advance the
                        // history shared with compressed activation PDUs.
                        active_stage
                            .consume_reactivation_fast_path(&payload)
                            .map_err(|e| format!("rdp reactivation fast-path: {}", e.report()))?;
                    }
                    continue;
                }
                let outputs = active_stage
                    .process(&mut image, action, &payload)
                    .map_err(|e| format!("rdp active stage ({action:?}, {} bytes): {}", payload.len(), e.report()))?;
                match handle_active_outputs(&mut framed, &image, outputs, &out_tx).await? {
                    ActiveOutputFlow::Continue => {}
                    ActiveOutputFlow::Terminate => break,
                    ActiveOutputFlow::Reactivate => {
                        reactivation = Some(activation_factory.create());
                    }
                }
                if reactivation.is_none() {
                    if let Some(clipboard) = &clipboard {
                        drain_clipboard_actions(&mut active_stage, clipboard, &mut framed, &out_tx).await?;
                    }
                }
            }
        }
    }

    Ok(SessionRunOutcome::Closed)
}
