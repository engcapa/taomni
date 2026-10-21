use super::*;

pub(super) fn serialize_cursor(cursor: DecodedCursor) -> Result<String, String> {
    if cursor.width == 0 || cursor.height == 0 {
        return serde_json::to_string(&WsOutgoingText::Cursor {
            visible: false,
            hotspot_x: 0,
            hotspot_y: 0,
            width: 0,
            height: 0,
            png_base64: String::new(),
        })
        .map_err(|e| format!("serialize hidden VNC cursor: {e}"));
    }

    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            &cursor.rgba,
            u32::from(cursor.width),
            u32::from(cursor.height),
            ColorType::Rgba8.into(),
        )
        .map_err(|e| format!("encode VNC cursor PNG: {e}"))?;
    serde_json::to_string(&WsOutgoingText::Cursor {
        visible: true,
        hotspot_x: cursor.hotspot_x,
        hotspot_y: cursor.hotspot_y,
        width: cursor.width,
        height: cursor.height,
        png_base64: BASE64_STANDARD.encode(png),
    })
    .map_err(|e| format!("serialize VNC cursor: {e}"))
}

pub(super) fn parse_binary_control(bytes: &[u8]) -> Option<VncControl> {
    match bytes.first().copied()? {
        0 if bytes.len() == 1 => Some(VncControl::Ack),
        1 if bytes.len() == 1 => None,
        2 if bytes.len() == 6 => {
            let down = bytes[1] != 0;
            let keysym = u32::from_be_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]);
            Some(VncControl::Key { down, keysym })
        }
        3 if bytes.len() == 6 => {
            let buttons = bytes[1];
            let x = u16::from_be_bytes([bytes[2], bytes[3]]);
            let y = u16::from_be_bytes([bytes[4], bytes[5]]);
            Some(VncControl::Pointer { x, y, buttons })
        }
        4 if bytes.len() == 1 => Some(VncControl::Refresh),
        5 if bytes.len() == 2 => VncPictureQuality::from_wire(bytes[1]).map(VncControl::SetQuality),
        _ => None,
    }
}

pub(super) fn coalesce_pointer_control(
    ctrl: VncControl,
    control_rx: &mut Receiver<VncControl>,
    deferred_ctrl: &mut Option<VncControl>,
    last_buttons: u8,
) -> VncControl {
    let (mut x, mut y, buttons) = match ctrl {
        VncControl::Pointer { x, y, buttons } => (x, y, buttons),
        other => return other,
    };

    if buttons != last_buttons {
        return VncControl::Pointer { x, y, buttons };
    }

    loop {
        match control_rx.try_recv() {
            Ok(VncControl::Pointer {
                x: next_x,
                y: next_y,
                buttons: next_buttons,
            }) if next_buttons == buttons => {
                x = next_x;
                y = next_y;
            }
            Ok(other @ VncControl::Pointer { .. }) => {
                *deferred_ctrl = Some(other);
                break;
            }
            Ok(other) => {
                *deferred_ctrl = Some(other);
                break;
            }
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
        }
    }

    VncControl::Pointer { x, y, buttons }
}

impl PointerArbiter {
    pub(super) fn set_native(&mut self, on: bool) {
        self.native_on = on;
        if !on {
            self.sampled_at = None;
        }
    }

    /// Whether a WebView pointer event is sent to the server.
    pub(super) fn web(&mut self, x: u16, y: u16, buttons: u8, now: Instant) -> bool {
        let previous = self.buttons;
        self.buttons = buttons;
        if buttons != 0 {
            // After the release the WebView's moves count again until the
            // sampler has resumed.
            self.sampled_at = None;
        }
        let late_copy = buttons == 0
            && previous == 0
            && self.native_on
            && self
                .sampled_at
                .is_some_and(|at| now.saturating_duration_since(at) < SAMPLED_POINTER_FRESH);
        if late_copy {
            return false;
        }
        self.last_wire = Some((x, y, buttons));
        true
    }

    /// Whether a native sample is sent to the server; a sample of the
    /// position just sent (such as the release point) is no move.
    pub(super) fn sample(&mut self, x: u16, y: u16, now: Instant) -> bool {
        if !self.native_on || self.buttons != 0 || self.last_wire == Some((x, y, 0)) {
            return false;
        }
        self.sampled_at = Some(now);
        self.last_wire = Some((x, y, 0));
        true
    }
}

/// Geometry of a `native_pointer` message; `None` stops sampling.
#[allow(clippy::too_many_arguments)]
pub(super) fn native_pointer_target(
    on: bool,
    left: Option<f64>,
    top: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
    dpr: Option<f64>,
    fb_width: Option<u16>,
    fb_height: Option<u16>,
) -> Option<NativePointerTarget> {
    if !on {
        return None;
    }
    Some(NativePointerTarget {
        left: left?,
        top: top?,
        width: width?,
        height: height?,
        dpr: dpr?,
        fb_width: fb_width?,
        fb_height: fb_height?,
    })
    .filter(NativePointerTarget::valid)
}

pub(super) fn control_allowed(
    control: &VncControl,
    view_only: bool,
    clipboard_policy: VncClipboardPolicy,
    limits: &crate::vnc::limits::DecodeLimits,
) -> bool {
    match control {
        VncControl::Key { .. }
        | VncControl::Pointer { .. }
        | VncControl::NativePointer(_)
        | VncControl::SampledPointer { .. } => !view_only,
        VncControl::Clipboard(text) => {
            clipboard_policy.allows_client_to_server() && limits.clipboard_bytes(text.len()).is_ok()
        }
        VncControl::ExtendedClipboard(formats) => {
            clipboard_policy.allows_client_to_server()
                && [
                    formats.text.as_deref(),
                    formats.html.as_deref(),
                    formats.rtf.as_deref(),
                ]
                .into_iter()
                .flatten()
                .try_fold(0usize, |total, value| {
                    limits.clipboard_bytes(value.len()).ok()?;
                    total.checked_add(value.len())
                })
                .is_some_and(|total| total <= limits.max_clipboard_decompressed_bytes)
        }
        VncControl::Refresh
        | VncControl::Ack
        | VncControl::SetQuality(_)
        | VncControl::Disconnect => true,
    }
}
