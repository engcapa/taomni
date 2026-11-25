use super::*;

impl RfbWriter {
    pub fn set_framebuffer_size(&mut self, width: u16, height: u16) {
        self.width = width;
        self.height = height;
    }

    /// Switch the wire pixel format mid-session. Callers send this only
    /// while no FramebufferUpdateRequest is outstanding, so the reader can
    /// apply the format to the very next update.
    pub fn set_pixel_format(&mut self, format: PixelFormat) -> Result<(), String> {
        *self
            .pending_pixel_format
            .lock()
            .map_err(|_| "VNC pixel format lock poisoned".to_string())? = Some(format);
        self.write_all(&set_pixel_format_message(format))
            .map_err(|e| format!("write set pixel format: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))
    }

    /// Replace the encoding preference list mid-session.
    pub fn set_encodings(&mut self, encodings: &[i32]) -> Result<(), String> {
        self.write_all(&set_encodings_message(encodings)?)
            .map_err(|e| format!("write set encodings: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))
    }

    /// Non-incremental request for one pixel: a liveness probe that every
    /// server must answer (KeepAlive, VNC-SESS-003).
    pub fn request_probe(&mut self) -> Result<(), String> {
        let mut msg = [0u8; 10];
        msg[0] = 3;
        msg[6..8].copy_from_slice(&1u16.to_be_bytes());
        msg[8..10].copy_from_slice(&1u16.to_be_bytes());
        self.write_all(&msg)
            .map_err(|e| format!("write keepalive request: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))
    }

    /// Send FramebufferUpdateRequest. incremental=true skips unchanged regions.
    pub fn request_update(&mut self, incremental: bool) -> Result<(), String> {
        let mut msg = [0u8; 10];
        msg[0] = 3; // FramebufferUpdateRequest
        msg[1] = if incremental { 1 } else { 0 };
        msg[2..4].copy_from_slice(&0u16.to_be_bytes()); // x
        msg[4..6].copy_from_slice(&0u16.to_be_bytes()); // y
        msg[6..8].copy_from_slice(&self.width.to_be_bytes()); // width
        msg[8..10].copy_from_slice(&self.height.to_be_bytes()); // height

        self.write_all(&msg)
            .map_err(|e| format!("write update request: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send KeyEvent.
    pub fn send_key_event(&mut self, down: bool, keysym: u32) -> Result<(), String> {
        let mut msg = [0u8; 8];
        msg[0] = 4;
        msg[1] = if down { 1 } else { 0 };
        msg[2..4].copy_from_slice(&0u16.to_be_bytes()); // padding
        msg[4..8].copy_from_slice(&keysym.to_be_bytes());

        self.write_all(&msg)
            .map_err(|e| format!("write key event: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send PointerEvent.
    pub fn send_pointer_event(&mut self, x: u16, y: u16, buttons: u8) -> Result<(), String> {
        if self.width == 0 || self.height == 0 || x >= self.width || y >= self.height {
            return Err("pointer coordinates are outside the remote framebuffer".into());
        }
        let mut msg = [0u8; 6];
        msg[0] = 5;
        msg[1] = buttons;
        msg[2..4].copy_from_slice(&x.to_be_bytes());
        msg[4..6].copy_from_slice(&y.to_be_bytes());

        self.write_all(&msg)
            .map_err(|e| format!("write pointer event: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send ClientCutText (clipboard).
    pub fn send_client_cut_text(&mut self, text: &str) -> Result<(), String> {
        let text_bytes = encode_legacy_cut_text(text);
        DecodeLimits::default()
            .clipboard_bytes(text_bytes.len())
            .map_err(|error| error.to_string())?;
        let text_len = u32::try_from(text_bytes.len())
            .map_err(|_| "clipboard text exceeds RFB length limit".to_string())?;
        let message_len = 8usize
            .checked_add(text_bytes.len())
            .ok_or_else(|| "clipboard message length overflow".to_string())?;
        let mut msg = vec![0u8; message_len];
        msg[0] = 6;
        msg[1..4].copy_from_slice(&[0u8; 3]);
        msg[4..8].copy_from_slice(&text_len.to_be_bytes());
        msg[8..].copy_from_slice(&text_bytes);

        self.write_all(&msg)
            .map_err(|e| format!("write client cut text: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send an ExtendedClipboard body. The wire frame is a ClientCutText (msg
    /// type 6) with a *negative* length signaling the extended payload.
    pub fn send_extended_clipboard(&mut self, body: &[u8]) -> Result<(), String> {
        if body.len() < 4 {
            return Err("extended clipboard body is truncated".into());
        }
        if body.len() > DecodeLimits::default().max_clipboard_decompressed_bytes {
            return Err("extended clipboard body exceeds configured limit".into());
        }
        let body_len = i32::try_from(body.len())
            .map_err(|_| "extended clipboard body exceeds RFB length limit".to_string())?;
        let neg_len = body_len
            .checked_neg()
            .ok_or_else(|| "extended clipboard length overflow".to_string())?;
        let capacity = 8usize
            .checked_add(body.len())
            .ok_or_else(|| "extended clipboard message length overflow".to_string())?;
        let mut msg = Vec::with_capacity(capacity);
        msg.push(6);
        msg.extend_from_slice(&[0u8; 3]); // padding
        msg.extend_from_slice(&neg_len.to_be_bytes());
        msg.extend_from_slice(body);

        self.write_all(&msg)
            .map_err(|e| format!("write ext clipboard: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    pub(super) fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        match self.secure_output.as_mut() {
            Some(output) => {
                for chunk in buf.chunks(RA2_AES_FRAME_MAX) {
                    rsa_aes_write_message(&mut self.stream, output, chunk)?;
                }
                Ok(())
            }
            None => self.stream.write_all(buf),
        }
    }

    pub(super) fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}
