use super::model::RfbConnection;
use super::model::RfbWriter;
use crate::vnc::encodings;
use crate::vnc::framebuffer::Framebuffer;
use crate::vnc::framebuffer::SharedFramebuffer;
use crate::vnc::pixel::PixelConverter;
use crate::vnc::pixel::PixelFormat;
use crate::vnc::rfb::stream;
use crate::vnc::rfb::stream::RuntimeStats;
use crate::vnc::rfb::stream::set_encodings_message;
use crate::vnc::rfb::stream::set_pixel_format_message;
use std::io::Write;

impl RfbConnection {
    /// Request pixel format: 32-bit true-colour with depth 24 so ZRLE can use
    /// the 3-byte CPIXEL form and rectangles copy straight into RGBA.
    pub fn set_pixel_format_rgba(&mut self) -> Result<(), String> {
        self.set_pixel_format(PixelFormat::RGB888)
    }

    /// Request a pixel format before the first update request.
    pub fn set_pixel_format(&mut self, format: PixelFormat) -> Result<(), String> {
        self.write_all(&set_pixel_format_message(format))
            .map_err(|e| format!("write set pixel format: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;
        self.pixel = PixelConverter::new(format);
        self.stats.pixel_format = format;
        Ok(())
    }

    /// Request encodings in preference order.
    pub fn set_encodings(&mut self, encodings: &[i32]) -> Result<(), String> {
        let msg = set_encodings_message(encodings)?;
        self.write_all(&msg)
            .map_err(|e| format!("write set encodings: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
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

    /// Authentication uses a bounded read timeout so an unresponsive peer
    /// cannot hold a connection attempt forever. Once the RFB session is
    /// established, however, a server may legitimately stay silent while no
    /// pixels change or while the viewer is hidden. Runtime cancellation closes
    /// the socket explicitly, so remove the handshake timeout before entering
    /// the long-lived read loop.
    pub fn enter_runtime_mode(&mut self) -> Result<(), String> {
        self.stream
            .set_read_timeout(None)
            .map_err(|e| format!("clear VNC runtime read timeout failed: {e}"))?;
        // Handshake reads stay unbuffered so no byte meant for a sub-protocol
        // (RA2, TLS bridge) is consumed early. From here on every read goes
        // through `read_exact`/`RfbStreamReader`, so buffering is safe.
        if self.secure_io.is_none() {
            self.read_buffer.enabled = true;
        }
        Ok(())
    }

    /// Counters for the session-information view and performance evidence.
    pub fn runtime_stats(&self) -> RuntimeStats {
        RuntimeStats {
            wire_bytes: self.read_buffer.total,
            ..self.stats
        }
    }

    /// Handle to the authoritative framebuffer for relay-side extraction.
    pub fn framebuffer(&self) -> SharedFramebuffer {
        self.framebuffer.clone()
    }

    pub(super) fn lock_framebuffer(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Framebuffer>, String> {
        self.framebuffer
            .lock()
            .map_err(|_| "VNC framebuffer lock poisoned".to_string())
    }

    /// Split out an independent writer so input events can be sent while the
    /// reader is blocked waiting for the next server message.
    pub fn take_writer(&mut self) -> Result<RfbWriter, String> {
        let stream = self
            .stream
            .try_clone()
            .map_err(|e| format!("clone VNC stream for writer: {}", e))?;
        let secure_output = match self.secure_io.as_mut() {
            Some(io) => Some(
                io.take_output()
                    .ok_or_else(|| "VNC secure writer already split".to_string())?,
            ),
            None => None,
        };

        Ok(RfbWriter {
            stream,
            secure_output,
            width: self.width,
            height: self.height,
            pending_pixel_format: self.pending_pixel_format.clone(),
        })
    }
}
