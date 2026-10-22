use super::model::RfbConnection;
use super::model::ServerMessage;
use crate::vnc::clipboard::decode_legacy_cut_text;
use crate::vnc::clipboard::parse_extended_body_with_limits;
use crate::vnc::encodings;
use crate::vnc::encodings::DecodedPointerPosition;
use crate::vnc::encodings::ENCODING_DESKTOP_SIZE;
use crate::vnc::encodings::ENCODING_POINTER_POS;
use crate::vnc::encodings::ENCODING_RICH_CURSOR;
use crate::vnc::encodings::ENCODING_X_CURSOR;
use crate::vnc::framebuffer::FbRect;
use crate::vnc::pixel::PixelConverter;
use crate::vnc::rfb::stream;
use crate::vnc::rfb::stream::RfbStreamReader;
use crate::vnc::tight;
use crate::vnc::tight::ENCODING_TIGHT;
use std::io::Read;

impl RfbConnection {
    /// Read the next server-to-client message, decoding rectangle data in
    /// place. `FramebufferUpdate` is returned with the already-decoded rects
    /// so callers never have to know about the specific wire encoding.
    pub fn read_server_message(&mut self) -> Result<ServerMessage, String> {
        let msg_type = self.read_u8()?;
        match msg_type {
            0 => self.read_framebuffer_update(),
            1 => {
                self.read_exact(&mut [0u8; 1])
                    .map_err(|e| format!("read colourmap padding: {}", e))?;
                let _first = self.read_u16()?;
                let count = self.read_u16()?;
                let entry_size = (count as usize)
                    .checked_mul(6)
                    .ok_or_else(|| "colour-map byte count overflow".to_string())?;
                if entry_size > self.limits.max_server_string_bytes {
                    return Err("colour-map payload exceeds configured limit".into());
                }
                let mut entries = vec![0u8; entry_size];
                self.read_exact(&mut entries)
                    .map_err(|e| format!("read colourmap entries: {}", e))?;
                Ok(ServerMessage::SetColourMapEntries)
            }
            2 => Ok(ServerMessage::Bell),
            3 => {
                self.read_exact(&mut [0u8; 3])
                    .map_err(|e| format!("read cut text padding: {}", e))?;
                let len_signed = self.read_i32()?;
                if len_signed < 0 {
                    // ExtendedClipboard rides on ServerCutText with a negative length.
                    let len = len_signed
                        .checked_abs()
                        .ok_or_else(|| "extended clipboard length overflow".to_string())?
                        as usize;
                    // Reasonable cap so a corrupt server can't make us allocate
                    // a 4 GiB buffer.
                    if len > self.limits.max_clipboard_decompressed_bytes {
                        return Err("extended clipboard body exceeds configured limit".into());
                    }
                    let mut body = vec![0u8; len];
                    self.read_exact(&mut body)
                        .map_err(|e| format!("read ext clipboard: {}", e))?;
                    match parse_extended_body_with_limits(&body, &self.limits)? {
                        Some(msg) => Ok(ServerMessage::ExtendedClipboard(msg)),
                        None => {
                            // Unknown action — return a no-op so the relay keeps running.
                            Ok(ServerMessage::SetColourMapEntries)
                        }
                    }
                } else {
                    let len = len_signed as usize;
                    if len > self.limits.max_clipboard_format_bytes {
                        return Err("legacy clipboard body exceeds configured limit".into());
                    }
                    let mut text = vec![0u8; len];
                    self.read_exact(&mut text)
                        .map_err(|e| format!("read cut text: {}", e))?;
                    Ok(ServerMessage::ServerCutText {
                        text: decode_legacy_cut_text(&text),
                    })
                }
            }
            _ => Err(format!("unknown server message type: {}", msg_type)),
        }
    }

    pub(super) fn read_framebuffer_update(&mut self) -> Result<ServerMessage, String> {
        // The writer only switches formats while no update is outstanding, so
        // this update is the first one encoded in the new format.
        if let Some(format) = self
            .pending_pixel_format
            .lock()
            .map_err(|_| "VNC pixel format lock poisoned".to_string())?
            .take()
        {
            self.pixel = PixelConverter::new(format);
            self.stats.pixel_format = format;
        }
        self.read_exact(&mut [0u8; 1])
            .map_err(|e| format!("read fu padding: {}", e))?;
        let num_rects = self.read_u16()? as usize;
        if num_rects > self.limits.max_rectangles_per_update {
            return Err("framebuffer update contains too many rectangles".into());
        }

        let update_started = std::time::Instant::now();
        let wire_before = self.read_buffer.total;
        let mut pixel_rects = 0u16;
        let mut tight_rects = 0u16;
        let mut compressed_rects = 0u16;
        let mut raw_pixels = 0u64;
        let mut damage: Vec<FbRect> = Vec::with_capacity(num_rects.min(64));
        let mut cursor = None;
        let mut pointer_pos = None;
        for _ in 0..num_rects {
            let x = self.read_u16()?;
            let y = self.read_u16()?;
            let w = self.read_u16()?;
            let h = self.read_u16()?;
            let encoding = self.read_i32()?;
            if encoding == ENCODING_DESKTOP_SIZE {
                self.limits
                    .framebuffer_bytes(w, h)
                    .map_err(|e| e.to_string())?;
            } else if encoding == ENCODING_POINTER_POS {
                if w != 0 || h != 0 {
                    return Err("pointer position encoding must have zero dimensions".into());
                }
            } else if encoding != ENCODING_RICH_CURSOR && encoding != ENCODING_X_CURSOR {
                self.limits
                    .rectangle_bytes(w, h)
                    .map_err(|e| e.to_string())?;
            }
            if x.checked_add(w).is_none_or(|end| end > self.width)
                || y.checked_add(h).is_none_or(|end| end > self.height)
            {
                // DesktopSize is the only rectangle allowed to describe a new
                // framebuffer geometry; pixel rectangles must stay in bounds.
                if encoding != ENCODING_DESKTOP_SIZE
                    && encoding != ENCODING_RICH_CURSOR
                    && encoding != ENCODING_X_CURSOR
                    && encoding != ENCODING_POINTER_POS
                {
                    return Err("framebuffer rectangle is outside the negotiated size".into());
                }
            }

            let rect = FbRect::new(x, y, w, h);
            match encoding {
                0 | 5 | 16 | ENCODING_TIGHT => {
                    self.stats.last_encoding = Some(encoding);
                    pixel_rects = pixel_rects.saturating_add(1);
                    if encoding == ENCODING_TIGHT {
                        tight_rects = tight_rects.saturating_add(1);
                    }
                    if encoding == 0 {
                        raw_pixels += u64::from(w) * u64::from(h);
                    } else {
                        compressed_rects = compressed_rects.saturating_add(1);
                    }
                    self.decode_pixels(encoding, w, h)?;
                    self.lock_framebuffer()?.blit(rect, &self.scratch)?;
                    damage.push(rect);
                }
                1 => {
                    self.stats.last_encoding.get_or_insert(1);
                    let (src_x, src_y) =
                        self.decode_via_reader(|reader| encodings::read_copyrect_source(reader))?;
                    self.lock_framebuffer()?.copy_rect(src_x, src_y, rect)?;
                    damage.push(rect);
                }
                ENCODING_DESKTOP_SIZE => {
                    // DesktopSize pseudo-encoding: no payload, just a resize.
                    // Rectangles decoded earlier in this update refer to the
                    // old geometry; the relay repaints the whole new surface.
                    self.lock_framebuffer()?.resize(w, h, &self.limits)?;
                    self.width = w;
                    self.height = h;
                    damage.clear();
                    damage.push(FbRect::new(0, 0, w, h));
                }
                ENCODING_RICH_CURSOR => {
                    let conv = self.pixel.clone();
                    cursor = Some(self.decode_via_reader(|reader| {
                        encodings::read_rich_cursor(reader, x, y, w, h, &conv)
                    })?);
                }
                ENCODING_X_CURSOR => {
                    cursor = Some(self.decode_via_reader(|reader| {
                        encodings::read_x_cursor(reader, x, y, w, h)
                    })?);
                }
                ENCODING_POINTER_POS => {
                    pointer_pos = Some(DecodedPointerPosition { x, y });
                }
                other => {
                    return Err(format!(
                        "unsupported encoding {} — client did not request this",
                        other
                    ));
                }
            }
        }

        self.stats.updates += 1;
        self.stats.last_update_pixel_rects = pixel_rects;
        self.stats.last_update_tight_rects = tight_rects;
        self.stats.last_update_compressed_rects = compressed_rects;
        self.stats.last_update_raw_pixels = raw_pixels;
        self.stats.last_update_wire_bytes = self.read_buffer.total - wire_before;
        self.stats.last_update_micros = update_started.elapsed().as_micros() as u64;
        self.stats.last_update_started_at = Some(update_started);
        self.stats.last_update_finished_at = Some(std::time::Instant::now());
        Ok(ServerMessage::FramebufferUpdate {
            rects: damage,
            cursor,
            pointer_pos,
        })
    }

    /// Decode one pixel rectangle into `self.scratch` (resized to `w*h*4`).
    pub(super) fn decode_pixels(&mut self, encoding: i32, w: u16, h: u16) -> Result<(), String> {
        let bytes = self
            .limits
            .rectangle_bytes(w, h)
            .map_err(|e| e.to_string())?;
        let limits = self.limits;
        let Self {
            stream,
            secure_io,
            read_buffer,
            scratch,
            hextile_state,
            zrle_decoder,
            tight_decoder,
            pixel,
            ..
        } = self;
        if scratch.capacity() < bytes {
            // A fresh zeroed allocation maps zero pages lazily instead of
            // memsetting megabytes the decoder overwrites anyway.
            *scratch = vec![0u8; bytes];
        } else {
            scratch.resize(bytes, 0);
        }
        let mut reader = RfbStreamReader::new(stream, secure_io.as_mut(), read_buffer);
        match encoding {
            0 => encodings::decode_raw_into(&mut reader, w, h, pixel, scratch),
            5 => encodings::decode_hextile_into(&mut reader, w, h, hextile_state, pixel, scratch),
            16 => encodings::decode_zrle_into(
                &mut reader,
                w,
                h,
                zrle_decoder,
                &limits,
                pixel,
                scratch,
            ),
            ENCODING_TIGHT => {
                tight::decode_tight_into(&mut reader, w, h, tight_decoder, &limits, pixel, scratch)
            }
            other => Err(format!("unsupported pixel encoding {other}")),
        }
    }

    /// Run a decoder closure over a temporary `impl Read` view of the stream.
    /// Scoped borrowing so self stays available for framebuffer writes afterwards.
    pub(super) fn decode_via_reader<T>(
        &mut self,
        f: impl FnOnce(&mut RfbStreamReader<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let Self {
            stream,
            secure_io,
            read_buffer,
            ..
        } = self;
        let mut reader = RfbStreamReader::new(stream, secure_io.as_mut(), read_buffer);
        f(&mut reader)
    }
}
