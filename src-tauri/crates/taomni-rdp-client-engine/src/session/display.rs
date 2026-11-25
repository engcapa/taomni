use super::*;

/// Ask the server to redraw the entire desktop via a Refresh Rect PDU
/// (MS-RDPBCGR 2.2.11.2). Windows occasionally leaves the client showing a
/// stale framebuffer after a session transition (e.g. the move from the
/// logon/credential screen to the interactive desktop, which arrives as a
/// Deactivate-All → reactivation). Re-requesting the full rectangle forces a
/// fresh paint so the canvas is not stuck on the pre-login image.
pub(super) async fn request_full_refresh<S>(
    active_stage: &mut ActiveStage,
    image: &IronDecodedImage,
    framed: &mut Framed<S>,
    out_tx: &SessionOutputSender,
) -> Result<(), String>
where
    S: FramedWrite,
{
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return Ok(());
    }
    let pdu = ShareDataPdu::RefreshRectangle(RefreshRectanglePdu {
        areas_to_refresh: vec![InclusiveRectangle {
            left: 0,
            top: 0,
            right: width - 1,
            bottom: height - 1,
        }],
    });
    let mut output = WriteBuf::new();
    active_stage
        .encode_static(&mut output, pdu)
        .map_err(|e| format!("rdp refresh encode: {}", e))?;
    if !output.filled().is_empty() {
        framed
            .write_all(output.filled())
            .await
            .map_err(|e| format!("rdp refresh write: {}", e))?;
    }
    send_status(
        out_tx,
        "refresh-requested",
        "Requested a full desktop redraw from the RDP server.",
    );
    Ok(())
}

pub(super) async fn handle_active_outputs<S>(
    framed: &mut Framed<S>,
    image: &IronDecodedImage,
    outputs: Vec<ActiveStageOutput>,
    out_tx: &SessionOutputSender,
) -> Result<ActiveOutputFlow, String>
where
    S: FramedWrite,
{
    let mut sent_frame = false;
    for out in outputs {
        match out {
            ActiveStageOutput::ResponseFrame(frame) => {
                if !frame.is_empty() {
                    framed
                        .write_all(&frame)
                        .await
                        .map_err(|e| format!("rdp write response: {}", e))?;
                }
            }
            ActiveStageOutput::GraphicsUpdate(rect) => {
                tracing::debug!(
                    ?rect,
                    width = image.width(),
                    height = image.height(),
                    "Forwarding decoded RDP graphics"
                );
                if let Some(tile) = tile_from_image(image, rect) {
                    tile.validate()?;
                    let payload = frame_payload_with_header(tile.header, &tile.rgba);
                    let _ = out_tx.send(SessionOutput::Channel {
                        tag: channel::FRAME,
                        payload,
                    });
                    sent_frame = true;
                }
            }
            ActiveStageOutput::PointerDefault => {
                send_cursor_payload(out_tx, vec![cursor::DEFAULT]);
            }
            ActiveStageOutput::PointerHidden => {
                send_cursor_payload(out_tx, vec![cursor::HIDDEN]);
            }
            ActiveStageOutput::PointerPosition { .. } => {
                // Browsers intentionally do not allow applications to warp the
                // host pointer. Normal movement follows local pointer events,
                // while server-provided shape changes are handled below.
            }
            ActiveStageOutput::PointerBitmap(pointer) => {
                match cursor_bitmap_payload(pointer.as_ref()) {
                    Ok(payload) => send_cursor_payload(out_tx, payload),
                    Err(error) => {
                        tracing::warn!(%error, "ignoring invalid RDP cursor bitmap");
                        send_cursor_payload(out_tx, vec![cursor::DEFAULT]);
                    }
                }
            }
            ActiveStageOutput::Terminate(reason) => {
                send_text(
                    out_tx,
                    json!({
                        "type": "disconnected",
                        "reason": reason.description(),
                    })
                    .to_string(),
                );
                return Ok(ActiveOutputFlow::Terminate);
            }
            ActiveStageOutput::DeactivateAll => {
                send_status(
                    out_tx,
                    "reactivating",
                    "Server deactivated the RDP session; reactivation is in progress.",
                );
                return Ok(ActiveOutputFlow::Reactivate);
            }
            ActiveStageOutput::AutoDetect(request) => {
                // RTT probes are answered inside ironrdp-session; the server's
                // conclusions drive the connection bar's quality indicator.
                if let Some(text) = network_characteristics_event(&request) {
                    send_text(out_tx, text);
                }
            }
            ActiveStageOutput::MultitransportRequest(_) => {
                // Optional RDP transports are not established by this client.
            }
        }
    }
    if sent_frame {
        let _ = out_tx.send(SessionOutput::Channel {
            tag: channel::FRAME_END,
            payload: Vec::new(),
        });
    }
    Ok(ActiveOutputFlow::Continue)
}

pub(super) async fn process_reactivation_frame<S>(
    sequence: &mut ConnectionActivationSequence,
    frame: &[u8],
    active_stage: &mut ActiveStage,
    image: &mut IronDecodedImage,
    framed: &mut Framed<S>,
    out_tx: &SessionOutputSender,
    protocol: &str,
    server_name: &str,
) -> Result<bool, String>
where
    S: FramedWrite,
{
    // Step once with the server PDU the current state was waiting for, then
    // keep draining any send-only states without waiting for more input. The
    // Deactivation-Reactivation Sequence (MS-RDPBCGR 1.3.1.3) runs
    // Capabilities Exchange → Synchronize → Control Cooperate → Request
    // Control → Font List before the server sends its Font Map. Those middle
    // states report `next_pdu_hint() == None`: they only emit a PDU and must
    // be advanced with `step_no_input`. The server withholds the Font Map
    // until it receives our Font List, so if we stop after a single `step`
    // (as the old code did) both sides wait on each other forever and the
    // canvas freezes after a maximize/restore until the user reconnects.
    // Activation ShareData PDUs use the same bulk history as graphics. In
    // particular, xrdp's Font Map carries FLUSHED/AT_FRONT; parsing it directly
    // would miss the reset and corrupt the first repaint after this resize.
    let frame = active_stage
        .normalize_reactivation_frame(frame)
        .map_err(|e| format!("rdp reactivation compression: {}", e.report()))?;
    let mut output = WriteBuf::new();
    sequence
        .step(frame.as_ref(), &mut output)
        .map_err(|e| format!("rdp reactivation: {}", e))?;
    flush_reactivation_output(framed, &output).await?;

    loop {
        if let ConnectionActivationState::Finalized {
            desktop_size,
            enable_server_pointer,
            ..
        } = sequence.connection_activation_state()
        {
            tracing::debug!(
                width = desktop_size.width,
                height = desktop_size.height,
                "RDP desktop reactivation finalized"
            );
            active_stage.set_enable_server_pointer(enable_server_pointer);
            *image =
                IronDecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
            send_connected_event(
                out_tx,
                desktop_size.width,
                desktop_size.height,
                protocol,
                server_name,
            );
            send_status(
                out_tx,
                "reactivated",
                "RDP session reactivated after desktop resize.",
            );
            // The desktop that arrives after a reactivation (notably the
            // post-logon interactive desktop when NLA is off) is frequently not
            // fully repainted by the server on its own. Force a full redraw so
            // the canvas does not stay stuck on the pre-transition image.
            request_full_refresh(active_stage, image, framed, out_tx).await?;
            return Ok(true);
        }

        // A `Some` hint means the next transition needs another server PDU;
        // hand control back to the read loop to fetch it.
        if sequence.next_pdu_hint().is_some() {
            return Ok(false);
        }

        // Send-only state: advance without input and flush the produced PDU.
        output.clear();
        sequence
            .step_no_input(&mut output)
            .map_err(|e| format!("rdp reactivation step: {}", e))?;
        flush_reactivation_output(framed, &output).await?;
    }
}

/// Write any bytes a reactivation step produced to the framed transport.
/// Reactivation states may legitimately emit nothing (e.g. the Font Map
/// `WaitForResponse` transition), so an empty buffer is not an error.
pub(super) async fn flush_reactivation_output<S>(
    framed: &mut Framed<S>,
    output: &WriteBuf,
) -> Result<(), String>
where
    S: FramedWrite,
{
    if !output.filled().is_empty() {
        framed
            .write_all(output.filled())
            .await
            .map_err(|e| format!("rdp reactivation write: {}", e))?;
    }
    Ok(())
}

pub(super) fn tile_from_image(
    image: &IronDecodedImage,
    rect: InclusiveRectangle,
) -> Option<DecodedTile> {
    let left = rect.left.min(image.width().saturating_sub(1));
    let top = rect.top.min(image.height().saturating_sub(1));
    let right = rect.right.min(image.width().saturating_sub(1));
    let bottom = rect.bottom.min(image.height().saturating_sub(1));
    if right < left || bottom < top {
        return None;
    }
    let w = right - left + 1;
    let h = bottom - top + 1;
    let bpp = image.bytes_per_pixel();
    if bpp != 4 {
        return None;
    }

    let mut rgba = Vec::with_capacity(usize::from(w) * usize::from(h) * bpp);
    let framebuffer = image.data();
    let stride = image.stride();
    for row in top..=bottom {
        let start = usize::from(row) * stride + usize::from(left) * bpp;
        let end = start + usize::from(w) * bpp;
        if end > framebuffer.len() {
            return None;
        }
        rgba.extend_from_slice(&framebuffer[start..end]);
    }

    Some(DecodedTile {
        header: TileHeader {
            x: left,
            y: top,
            w,
            h,
        },
        rgba,
    })
}

pub(super) fn send_cursor_payload(out_tx: &SessionOutputSender, payload: Vec<u8>) {
    let _ = out_tx.send(SessionOutput::Channel {
        tag: channel::CURSOR,
        payload,
    });
}

pub(super) fn cursor_bitmap_payload(pointer: &DecodedPointer) -> Result<Vec<u8>, String> {
    if pointer.width == 0 || pointer.height == 0 {
        return Ok(vec![cursor::HIDDEN]);
    }
    if pointer.width > cursor::MAX_DIMENSION || pointer.height > cursor::MAX_DIMENSION {
        return Err(format!(
            "cursor dimensions {}x{} exceed {}x{}",
            pointer.width,
            pointer.height,
            cursor::MAX_DIMENSION,
            cursor::MAX_DIMENSION,
        ));
    }
    if pointer.hotspot_x >= pointer.width || pointer.hotspot_y >= pointer.height {
        return Err(format!(
            "cursor hotspot {},{} lies outside {}x{}",
            pointer.hotspot_x, pointer.hotspot_y, pointer.width, pointer.height,
        ));
    }

    let expected = usize::from(pointer.width)
        .checked_mul(usize::from(pointer.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or("cursor bitmap size overflow")?;
    if pointer.bitmap_data.len() != expected {
        return Err(format!(
            "cursor bitmap has {} bytes; expected {}",
            pointer.bitmap_data.len(),
            expected,
        ));
    }

    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            &pointer.bitmap_data,
            u32::from(pointer.width),
            u32::from(pointer.height),
            ColorType::Rgba8.into(),
        )
        .map_err(|error| format!("encode cursor PNG: {error}"))?;

    let mut payload = Vec::with_capacity(cursor::BITMAP_HEADER_LEN + png.len());
    payload.push(cursor::BITMAP);
    payload.extend_from_slice(&pointer.hotspot_x.to_be_bytes());
    payload.extend_from_slice(&pointer.hotspot_y.to_be_bytes());
    payload.extend_from_slice(&pointer.width.to_be_bytes());
    payload.extend_from_slice(&pointer.height.to_be_bytes());
    payload.extend_from_slice(&png);
    Ok(payload)
}
