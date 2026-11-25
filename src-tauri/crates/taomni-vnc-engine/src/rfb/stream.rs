use super::*;

pub(super) const RUNTIME_READ_BUFFER_BYTES: usize = 256 * 1024;

/// Runtime counters. `wire_bytes` counts plaintext RFB bytes read after
/// `enter_runtime_mode` (TLS/RA2 framing overhead excluded).
#[derive(Debug, Clone, Copy)]
pub struct RuntimeStats {
    pub wire_bytes: u64,
    pub updates: u64,
    pub last_encoding: Option<i32>,
    /// Pixel format of the latest decoded update.
    pub pixel_format: PixelFormat,
    /// Pixel rectangles (and Tight ones among them) in the latest update.
    pub last_update_pixel_rects: u16,
    pub last_update_tight_rects: u16,
    /// ZRLE / Hextile / Tight rectangles, and pixels sent as Raw, in the
    /// latest update (DEC-VNC-22: a large Raw-only update means the server
    /// ignored the first encoding).
    pub last_update_compressed_rects: u16,
    pub last_update_raw_pixels: u64,
    /// Bytes and time from the first rectangle header to the end of the last
    /// FramebufferUpdate; large updates approximate the line speed.
    pub last_update_wire_bytes: u64,
    pub last_update_micros: u64,
    pub last_update_started_at: Option<std::time::Instant>,
    pub last_update_finished_at: Option<std::time::Instant>,
}

impl Default for RuntimeStats {
    fn default() -> Self {
        Self {
            wire_bytes: 0,
            updates: 0,
            last_encoding: None,
            pixel_format: PixelFormat::RGB888,
            last_update_pixel_rects: 0,
            last_update_tight_rects: 0,
            last_update_compressed_rects: 0,
            last_update_raw_pixels: 0,
            last_update_wire_bytes: 0,
            last_update_micros: 0,
            last_update_started_at: None,
            last_update_finished_at: None,
        }
    }
}

pub(super) fn set_encodings_message(encodings: &[i32]) -> Result<Vec<u8>, String> {
    let count = u16::try_from(encodings.len())
        .map_err(|_| "too many VNC encodings requested".to_string())?;
    let message_len = encodings
        .len()
        .checked_mul(4)
        .and_then(|bytes| bytes.checked_add(4))
        .ok_or_else(|| "VNC encoding list length overflow".to_string())?;
    let mut msg = vec![0u8; message_len];
    msg[0] = 2; // SetEncodings
    msg[2..4].copy_from_slice(&count.to_be_bytes());
    for (i, enc) in encodings.iter().enumerate() {
        let off = 4 + i * 4;
        msg[off..off + 4].copy_from_slice(&enc.to_be_bytes());
    }
    Ok(msg)
}

pub(super) fn set_pixel_format_message(format: PixelFormat) -> [u8; 20] {
    let mut msg = [0u8; 20];
    // Message type 0 and three bytes of padding, then PIXEL_FORMAT.
    msg[4..20].copy_from_slice(&format.to_wire());
    msg
}

pub fn encoding_name(encoding: i32) -> &'static str {
    match encoding {
        0 => "Raw",
        1 => "CopyRect",
        5 => "Hextile",
        7 => "Tight",
        16 => "ZRLE",
        _ => "Unknown",
    }
}

/// Userspace read-ahead for the plaintext RFB stream. Disabled during the
/// handshake; `enter_runtime_mode` turns it on.
pub(crate) struct ReadBuffer {
    pub(super) data: Box<[u8]>,
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) enabled: bool,
    /// Bytes read from the socket while enabled.
    pub(super) total: u64,
}

impl ReadBuffer {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            data: vec![0u8; capacity].into_boxed_slice(),
            start: 0,
            end: 0,
            enabled: false,
            total: 0,
        }
    }

    pub(super) fn read_exact(
        &mut self,
        stream: &mut TcpStream,
        dst: &mut [u8],
    ) -> std::io::Result<()> {
        if !self.enabled {
            return stream.read_exact(dst);
        }
        let mut offset = 0;
        let buffered = self.end - self.start;
        if buffered > 0 {
            let n = buffered.min(dst.len());
            dst[..n].copy_from_slice(&self.data[self.start..self.start + n]);
            self.start += n;
            offset = n;
        }
        while offset < dst.len() {
            let remaining = dst.len() - offset;
            // Large payloads (compressed ZRLE bodies, Raw rectangles) bypass
            // the buffer and land directly in the destination.
            if remaining >= self.data.len() {
                stream.read_exact(&mut dst[offset..])?;
                self.total += remaining as u64;
                return Ok(());
            }
            self.start = 0;
            self.end = loop {
                match stream.read(&mut self.data) {
                    Ok(0) => {
                        return Err(Error::new(
                            ErrorKind::UnexpectedEof,
                            "VNC server closed the connection",
                        ));
                    }
                    Ok(n) => {
                        self.total += n as u64;
                        break n;
                    }
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                }
            };
            let n = self.end.min(remaining);
            dst[offset..offset + n].copy_from_slice(&self.data[..n]);
            self.start = n;
            offset += n;
        }
        Ok(())
    }
}

/// Temporary read view over the underlying VNC TCP stream (plus an optional
/// AES-EAX secure layer). Lives only for the duration of a single decode call
/// so we can borrow sibling fields of `RfbConnection` at the same time.
pub(crate) struct RfbStreamReader<'a> {
    pub(super) stream: &'a mut TcpStream,
    pub(super) secure_io: Option<&'a mut RsaAesIo>,
    pub(super) read_buffer: &'a mut ReadBuffer,
}

impl<'a> RfbStreamReader<'a> {
    pub(super) fn new(
        stream: &'a mut TcpStream,
        secure_io: Option<&'a mut RsaAesIo>,
        read_buffer: &'a mut ReadBuffer,
    ) -> Self {
        Self {
            stream,
            secure_io,
            read_buffer,
        }
    }
}

impl<'a> Read for RfbStreamReader<'a> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // Decoders all rely on `read_exact`; this path is just a fallback so
        // generic `Read` combinators keep working. Saturate the requested
        // buffer rather than return a partial read.
        self.read_exact(buf)?;
        Ok(buf.len())
    }

    fn read_exact(&mut self, buf: &mut [u8]) -> std::io::Result<()> {
        match self.secure_io.as_mut() {
            Some(io) => io.read_exact(self.stream, buf),
            None => self.read_buffer.read_exact(self.stream, buf),
        }
    }
}
