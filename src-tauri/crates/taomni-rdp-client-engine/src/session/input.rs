use super::*;

pub(super) async fn handle_control<S>(
    ctrl: RdpControl,
    active_stage: &mut ActiveStage,
    image: &mut IronDecodedImage,
    input_db: &mut InputDatabase,
    last_buttons: &mut u8,
    framed: &mut Framed<S>,
    out_tx: &SessionOutputSender,
    clipboard: Option<&ClipboardBridge>,
    activation_factory: &ConnectionActivationFactory,
    reactivation: &mut Option<ConnectionActivationSequence>,
) -> Result<ControlOutcome, String>
where
    S: FramedRead + FramedWrite,
{
    match ctrl {
        RdpControl::Disconnect => return Ok(ControlOutcome::Disconnect),
        RdpControl::Ack => return Ok(ControlOutcome::Continue),
        RdpControl::Key(key) => {
            let events = input_db.apply(key_operations(key));
            let outputs = active_stage
                .process_fastpath_input(image, &events)
                .map_err(|e| format!("rdp key input: {}", e))?;
            match handle_active_outputs(framed, image, outputs, out_tx).await? {
                ActiveOutputFlow::Continue => {}
                ActiveOutputFlow::Terminate => return Ok(ControlOutcome::Disconnect),
                ActiveOutputFlow::Reactivate => {
                    *reactivation = Some(activation_factory.create());
                }
            }
        }
        RdpControl::UnicodeText(text) => {
            let events = input_db.apply(unicode_operations(&text));
            if events.is_empty() {
                return Ok(ControlOutcome::Continue);
            }
            let outputs = active_stage
                .process_fastpath_input(image, &events)
                .map_err(|e| format!("rdp Unicode input: {}", e))?;
            match handle_active_outputs(framed, image, outputs, out_tx).await? {
                ActiveOutputFlow::Continue => {}
                ActiveOutputFlow::Terminate => return Ok(ControlOutcome::Disconnect),
                ActiveOutputFlow::Reactivate => {
                    *reactivation = Some(activation_factory.create());
                }
            }
        }
        RdpControl::ReleaseInput => {
            let events = input_db.release_all();
            *last_buttons = 0;
            if events.is_empty() {
                return Ok(ControlOutcome::Continue);
            }
            let outputs = active_stage
                .process_fastpath_input(image, &events)
                .map_err(|e| format!("rdp release input: {}", e))?;
            match handle_active_outputs(framed, image, outputs, out_tx).await? {
                ActiveOutputFlow::Continue => {}
                ActiveOutputFlow::Terminate => return Ok(ControlOutcome::Disconnect),
                ActiveOutputFlow::Reactivate => {
                    *reactivation = Some(activation_factory.create());
                }
            }
        }
        RdpControl::Pointer(pointer) => {
            let ops = pointer_operations(pointer, last_buttons);
            let events = input_db.apply(ops);
            let outputs = active_stage
                .process_fastpath_input(image, &events)
                .map_err(|e| format!("rdp pointer input: {}", e))?;
            match handle_active_outputs(framed, image, outputs, out_tx).await? {
                ActiveOutputFlow::Continue => {}
                ActiveOutputFlow::Terminate => return Ok(ControlOutcome::Disconnect),
                ActiveOutputFlow::Reactivate => {
                    *reactivation = Some(activation_factory.create());
                }
            }
        }
        RdpControl::Wheel(wheel) => {
            let events = input_db.apply(wheel_operations(wheel));
            let outputs = active_stage
                .process_fastpath_input(image, &events)
                .map_err(|e| format!("rdp wheel input: {}", e))?;
            match handle_active_outputs(framed, image, outputs, out_tx).await? {
                ActiveOutputFlow::Continue => {}
                ActiveOutputFlow::Terminate => return Ok(ControlOutcome::Disconnect),
                ActiveOutputFlow::Reactivate => {
                    *reactivation = Some(activation_factory.create());
                }
            }
        }
        RdpControl::Resize { width, height } => {
            let width = normalize_width(width);
            let height = height.clamp(200, 8192);
            if width == image.width() && height == image.height() {
                return Ok(ControlOutcome::Continue);
            }
            match active_stage.encode_resize(u32::from(width), u32::from(height), None, None) {
                Some(Ok(frame)) => {
                    framed
                        .write_all(&frame)
                        .await
                        .map_err(|e| format!("rdp resize write: {}", e))?;
                }
                Some(Err(e)) => return Err(format!("rdp resize: {}", e)),
                None => {
                    send_status(
                        out_tx,
                        "resize-reconnect",
                        "Display Control is unavailable; reconnecting at the requested desktop size.",
                    );
                    return Ok(ControlOutcome::Reconnect { width, height });
                }
            }
        }
        RdpControl::Refresh => {
            request_full_refresh(active_stage, image, framed, out_tx).await?;
        }
        RdpControl::ClipboardOffer { .. } => {
            send_status(
                out_tx,
                "clipboard-offer-ignored",
                "Clipboard offers are driven by text data.",
            );
        }
        RdpControl::ClipboardData { format, data } => {
            let Some(clipboard) = clipboard else {
                send_status(
                    out_tx,
                    "clipboard-disabled",
                    "RDP clipboard redirection is disabled.",
                );
                return Ok(ControlOutcome::Continue);
            };
            if format != ClipboardFormatId::CF_UNICODETEXT.value() {
                send_status(
                    out_tx,
                    "clipboard-unsupported-format",
                    "Only Unicode text clipboard is wired.",
                );
                return Ok(ControlOutcome::Continue);
            }
            let text =
                String::from_utf8(data).map_err(|e| format!("rdp clipboard text utf8: {}", e))?;
            clipboard.set_local_text(text);
            advertise_clipboard_formats(
                active_stage,
                clipboard.local_formats(),
                framed,
                out_tx,
                "clipboard-local-copy",
            )
            .await?;
        }
        RdpControl::ClipboardFiles { paths } => {
            let Some(clipboard) = clipboard else {
                send_status(
                    out_tx,
                    "clipboard-disabled",
                    "RDP clipboard redirection is disabled.",
                );
                return Ok(ControlOutcome::Continue);
            };
            match collect_local_clipboard_files(&paths) {
                Ok(files) if !files.is_empty() => {
                    let count = files.len();
                    clipboard.set_local_files(files);
                    advertise_clipboard_formats(
                        active_stage,
                        clipboard.local_formats(),
                        framed,
                        out_tx,
                        "clipboard-local-files",
                    )
                    .await?;
                    send_status(
                        out_tx,
                        "clipboard-local-files",
                        &format!("{} local file item(s) are ready for RDP paste.", count),
                    );
                }
                Ok(_) => send_status(
                    out_tx,
                    "clipboard-local-files-empty",
                    "No existing local files were found in the clipboard.",
                ),
                Err(e) => send_status(
                    out_tx,
                    "clipboard-local-files-error",
                    &format!("Local file clipboard could not be prepared: {}", e),
                ),
            }
        }
    }
    Ok(ControlOutcome::Continue)
}

pub(super) fn key_operations(key: KeyEvent) -> Vec<Operation> {
    let extended = key.scancode & 0x0100 != 0;
    let code = (key.scancode & 0x00ff) as u8;
    let scancode = Scancode::from_u8(extended, code);
    if key.down {
        vec![Operation::KeyPressed(scancode)]
    } else {
        vec![Operation::KeyReleased(scancode)]
    }
}

pub(super) fn unicode_operations(text: &str) -> Vec<Operation> {
    text.chars()
        .flat_map(|character| {
            [
                Operation::UnicodeKeyPressed(character),
                Operation::UnicodeKeyReleased(character),
            ]
        })
        .collect()
}

pub(super) fn pointer_operations(pointer: PointerEvent, last_buttons: &mut u8) -> Vec<Operation> {
    let mut ops = Vec::with_capacity(4);
    ops.push(Operation::MouseMove(MousePosition {
        x: pointer.x,
        y: pointer.y,
    }));

    let changed = *last_buttons ^ pointer.buttons;
    for (mask, button) in [
        (0x01, MouseButton::Left),
        (0x02, MouseButton::Right),
        (0x04, MouseButton::Middle),
    ] {
        if changed & mask == 0 {
            continue;
        }
        if pointer.buttons & mask != 0 {
            ops.push(Operation::MouseButtonPressed(button));
        } else {
            ops.push(Operation::MouseButtonReleased(button));
        }
    }
    *last_buttons = pointer.buttons;
    ops
}

pub(super) fn wheel_operations(wheel: PointerWheelEvent) -> Vec<Operation> {
    vec![
        Operation::MouseMove(MousePosition {
            x: wheel.x,
            y: wheel.y,
        }),
        Operation::WheelRotations(WheelRotations {
            is_vertical: wheel.is_vertical,
            rotation_units: wheel.rotation_units,
        }),
    ]
}
