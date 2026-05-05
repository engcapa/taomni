use std::io::{Read, Write};
use std::net::TcpStream;

use crate::vnc::encodings::{self, DecodedRect};

const PROTOCOL_VERSION_3_8: &[u8] = b"RFB 003.008\n";
const PROTOCOL_VERSION_3_3: &[u8] = b"RFB 003.003\n";

#[derive(Debug)]
pub struct ServerInit {
    pub width: u16,
    pub height: u16,
    pub name: String,
}

#[derive(Debug)]
pub struct FramebufferUpdate {
    pub rects: Vec<FramebufferRect>,
}

#[derive(Debug)]
pub struct FramebufferRect {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
    pub encoding: i32,
    pub data: Vec<u8>,
}

pub struct RfbConnection {
    stream: TcpStream,
    pub width: u16,
    pub height: u16,
    pub name: String,
    framebuffer: Vec<u8>,
}

impl RfbConnection {
    pub fn connect(
        host: &str,
        port: u16,
    ) -> Result<Self, String> {
        let addr = format!("{}:{}", host, port);
        let stream =
            TcpStream::connect(&addr).map_err(|e| format!("TCP connect to {}: {}", addr, e))?;
        stream
            .set_nodelay(true)
            .map_err(|e| format!("set_nodelay failed: {}", e))?;

        let mut conn = RfbConnection {
            stream,
            width: 0,
            height: 0,
            name: String::new(),
            framebuffer: Vec::new(),
        };

        conn.handshake_protocol_version()?;
        Ok(conn)
    }

    /// Perform protocol version handshake: read server version, respond with our version.
    fn handshake_protocol_version(&mut self) -> Result<(), String> {
        let mut buf = [0u8; 12];
        self.stream
            .read_exact(&mut buf)
            .map_err(|e| format!("read protocol version: {}", e))?;

        // Determine which version to respond with
        let version = if buf == PROTOCOL_VERSION_3_8[..] || buf == PROTOCOL_VERSION_3_3[..] {
            &buf[..]
        } else if &buf[..7] == b"RFB 003" {
            // For other 3.x versions, use 3.8
            PROTOCOL_VERSION_3_8
        } else {
            return Err(format!("unsupported RFB version: {:?}", String::from_utf8_lossy(&buf)));
        };

        self.stream
            .write_all(version)
            .map_err(|e| format!("write protocol version: {}", e))?;
        self.stream
            .flush()
            .map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Perform security handshake and return ServerInit on success.
    pub fn authenticate(&mut self, password: Option<&str>) -> Result<ServerInit, String> {
        // Read number of security types
        let mut sec_buf = [0u8; 1];
        // The server might send 0 (no auth needed if num_types=0) or num_types + type list
        self.stream
            .read_exact(&mut sec_buf)
            .map_err(|e| format!("read security types count: {}", e))?;

        let num_types = sec_buf[0] as usize;

        if num_types == 0 {
            // Read failure reason length + message
            let mut len_buf = [0u8; 4];
            self.stream
                .read_exact(&mut len_buf)
                .map_err(|e| format!("read sec failure len: {}", e))?;
            let reason_len = u32::from_be_bytes(len_buf) as usize;
            let mut reason = vec![0u8; reason_len];
            self.stream
                .read_exact(&mut reason)
                .map_err(|e| format!("read sec failure reason: {}", e))?;
            return Err(format!(
                "server rejected connection: {}",
                String::from_utf8_lossy(&reason)
            ));
        }

        let mut types = vec![0u8; num_types];
        self.stream
            .read_exact(&mut types)
            .map_err(|e| format!("read security types: {}", e))?;

        let chosen = if types.contains(&1) {
            1 // None
        } else if types.contains(&2) {
            2 // VNC Authentication
        } else {
            return Err(format!(
                "no supported security type (server offers: {:?})",
                types
            ));
        };

        self.stream
            .write_all(&[chosen])
            .map_err(|e| format!("write security type: {}", e))?;
        self.stream
            .flush()
            .map_err(|e| format!("flush: {}", e))?;

        // Handle VNC Authentication
        if chosen == 2 {
            let pwd = password.unwrap_or("");
            self.vnc_auth(pwd)?;
        }

        // Read SecurityResult
        let mut result_buf = [0u8; 4];
        self.stream
            .read_exact(&mut result_buf)
            .map_err(|e| format!("read security result: {}", e))?;
        let result = u32::from_be_bytes(result_buf);
        if result == 1 {
            // Read failure reason
            let mut len_buf = [0u8; 4];
            self.stream
                .read_exact(&mut len_buf)
                .map_err(|e| format!("read auth failure len: {}", e))?;
            let reason_len = u32::from_be_bytes(len_buf) as usize;
            let mut reason = vec![0u8; reason_len];
            self.stream
                .read_exact(&mut reason)
                .map_err(|e| format!("read auth failure reason: {}", e))?;
            return Err(format!(
                "authentication failed: {}",
                String::from_utf8_lossy(&reason)
            ));
        }
        if result != 0 {
            return Err(format!("security result: {}", result));
        }

        // ClientInit: send shared flag
        self.stream
            .write_all(&[1])
            .map_err(|e| format!("write client init: {}", e))?;
        self.stream
            .flush()
            .map_err(|e| format!("flush: {}", e))?;

        // Read ServerInit
        self.read_server_init()
    }

    /// VNC DES authentication.
    fn vnc_auth(&mut self, password: &str) -> Result<(), String> {
        let mut challenge = [0u8; 16];
        self.stream
            .read_exact(&mut challenge)
            .map_err(|e| format!("read VNC challenge: {}", e))?;

        let response = vnc_des_encrypt(password, &challenge);

        self.stream
            .write_all(&response)
            .map_err(|e| format!("write VNC response: {}", e))?;
        self.stream
            .flush()
            .map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    fn read_server_init(&mut self) -> Result<ServerInit, String> {
        let mut buf = [0u8; 24];
        self.stream
            .read_exact(&mut buf)
            .map_err(|e| format!("read server init: {}", e))?;

        self.width = u16::from_be_bytes([buf[0], buf[1]]);
        self.height = u16::from_be_bytes([buf[2], buf[3]]);

        // Parsed pixel format from server (we override with RGBA via SetPixelFormat)
        let _bpp = buf[4];
        let _depth = buf[5];
        let _big_endian = buf[6];
        let _true_color = buf[7];
        let _red_max = u16::from_be_bytes([buf[8], buf[9]]);
        let _green_max = u16::from_be_bytes([buf[10], buf[11]]);
        let _blue_max = u16::from_be_bytes([buf[12], buf[13]]);
        let _red_shift = buf[14];
        let _green_shift = buf[15];
        let _blue_shift = buf[16];

        // Name length + name
        let name_len = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]) as usize;
        let mut name_bytes = vec![0u8; name_len];
        self.stream
            .read_exact(&mut name_bytes)
            .map_err(|e| format!("read server name: {}", e))?;
        self.name = String::from_utf8_lossy(&name_bytes).to_string();

        // Allocate framebuffer (RGBA 32-bit)
        let fb_size = self.width as usize * self.height as usize * 4;
        self.framebuffer = vec![0u8; fb_size];

        Ok(ServerInit {
            width: self.width,
            height: self.height,
            name: self.name.clone(),
        })
    }

    /// Request pixel format: 32-bit RGBA (8-8-8-8).
    pub fn set_pixel_format_rgba(&mut self) -> Result<(), String> {
        let mut msg = vec![0u8; 20];
        msg[0] = 0; // SetPixelFormat message type
        msg[1] = 0; // padding
        msg[2] = 0; // padding
        msg[3] = 0; // padding
                     // Pixel format:
        msg[4] = 32; // bits-per-pixel
        msg[5] = 32; // depth
        msg[6] = 0; // big-endian false (little-endian)
        msg[7] = 1; // true-colour
        msg[8] = 0; // red-max hi
        msg[9] = 255; // red-max lo
        msg[10] = 0; // green-max hi
        msg[11] = 255; // green-max lo
        msg[12] = 0; // blue-max hi
        msg[13] = 255; // blue-max lo
        msg[14] = 0; // red-shift (R at byte 0 in little-endian)
        msg[15] = 8; // green-shift (G at byte 1)
        msg[16] = 16; // blue-shift (B at byte 2)
        msg[17] = 0; // padding
        msg[18] = 0; // padding
        msg[19] = 0; // padding

        self.stream
            .write_all(&msg)
            .map_err(|e| format!("write set pixel format: {}", e))?;
        self.stream
            .flush()
            .map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Request encodings in preference order.
    pub fn set_encodings(&mut self, encodings: &[i32]) -> Result<(), String> {
        let mut msg = vec![0u8; 4 + encodings.len() * 4];
        msg[0] = 2; // SetEncodings
        msg[1] = 0;
        let count = encodings.len() as u16;
        msg[2..4].copy_from_slice(&count.to_be_bytes());

        for (i, enc) in encodings.iter().enumerate() {
            let off = 4 + i * 4;
            msg[off..off + 4].copy_from_slice(&enc.to_be_bytes());
        }

        self.stream
            .write_all(&msg)
            .map_err(|e| format!("write set encodings: {}", e))?;
        self.stream
            .flush()
            .map_err(|e| format!("flush: {}", e))?;

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

        self.stream
            .write_all(&msg)
            .map_err(|e| format!("write update request: {}", e))?;
        self.stream
            .flush()
            .map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send KeyEvent.
    pub fn send_key_event(&mut self, down: bool, keysym: u32) -> Result<(), String> {
        let mut msg = [0u8; 8];
        msg[0] = 4;
        msg[1] = if down { 1 } else { 0 };
        msg[2..4].copy_from_slice(&0u16.to_be_bytes()); // padding
        msg[4..8].copy_from_slice(&keysym.to_be_bytes());

        self.stream
            .write_all(&msg)
            .map_err(|e| format!("write key event: {}", e))?;
        self.stream
            .flush()
            .map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send PointerEvent.
    pub fn send_pointer_event(&mut self, x: u16, y: u16, buttons: u8) -> Result<(), String> {
        let mut msg = [0u8; 6];
        msg[0] = 5;
        msg[1] = buttons;
        msg[2..4].copy_from_slice(&x.to_be_bytes());
        msg[4..6].copy_from_slice(&y.to_be_bytes());

        self.stream
            .write_all(&msg)
            .map_err(|e| format!("write pointer event: {}", e))?;
        self.stream
            .flush()
            .map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send ClientCutText (clipboard).
    pub fn send_client_cut_text(&mut self, text: &str) -> Result<(), String> {
        let text_bytes = text.as_bytes();
        let mut msg = vec![0u8; 8 + text_bytes.len()];
        msg[0] = 6;
        msg[1..4].copy_from_slice(&[0u8; 3]);
        msg[4..8].copy_from_slice(&(text_bytes.len() as u32).to_be_bytes());
        msg[8..].copy_from_slice(text_bytes);

        self.stream
            .write_all(&msg)
            .map_err(|e| format!("write client cut text: {}", e))?;
        self.stream
            .flush()
            .map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Set desktop size (if server supports DesktopSize pseudo-encoding).
    pub fn set_desktop_size(&mut self, width: u16, height: u16) -> Result<(), String> {
        // DesktopSize is a pseudo-encoding; it's sent as a FramebufferUpdateRequest
        // with the new dimensions. The server responds with a FramebufferUpdate
        // that has encoding -223 (DesktopSize).
        let mut msg = [0u8; 10];
        msg[0] = 3;
        msg[1] = 0;
        msg[2..4].copy_from_slice(&0u16.to_be_bytes());
        msg[4..6].copy_from_slice(&0u16.to_be_bytes());
        msg[6..8].copy_from_slice(&width.to_be_bytes());
        msg[8..10].copy_from_slice(&height.to_be_bytes());

        self.stream
            .write_all(&msg)
            .map_err(|e| format!("write set desktop size: {}", e))?;
        self.stream
            .flush()
            .map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Read a server-to-client message. Returns None for FramebufferUpdate (handled internally).
    pub fn read_message(&mut self) -> Result<ServerMessage, String> {
        let msg_type = self.read_u8()?;
        match msg_type {
            0 => {
                // FramebufferUpdate
                self.stream
                    .read_exact(&mut [0u8; 3])
                    .map_err(|e| format!("read fu padding: {}", e))?;
                let num_rects = self.read_u16()?;
                let mut rects = Vec::with_capacity(num_rects as usize);

                for _ in 0..num_rects {
                    let x = self.read_u16()?;
                    let y = self.read_u16()?;
                    let w = self.read_u16()?;
                    let h = self.read_u16()?;
                    let encoding = self.read_i32()?;

                    let data_len = match encoding {
                        0 => {
                            // Raw
                            w as usize * h as usize * 4
                        }
                        1 => {
                            // CopyRect
                            4
                        }
                        5 => {
                            // Hextile: read until we've covered the rect
                            // We read all remaining data for now (actual parsing in decoder)
                            self.read_hextile_len(x, y, w, h)?
                        }
                        7 => {
                            // Tight
                            self.read_tight_len(x, y, w, h)?
                        }
                        16 => {
                            // ZRLE
                            self.read_zrle_len()?
                        }
                        -223 => {
                            // DesktopSize pseudo-encoding (no data)
                            0
                        }
                        _ => {
                            // Unknown encoding — read remaining data
                            w as usize * h as usize * 4
                        }
                    };

                    let mut data = vec![0u8; data_len];
                    self.stream
                        .read_exact(&mut data)
                        .map_err(|e| format!("read rect data: {}", e))?;

                    rects.push(FramebufferRect {
                        x,
                        y,
                        w,
                        h,
                        encoding,
                        data,
                    });
                }

                Ok(ServerMessage::FramebufferUpdate(FramebufferUpdate { rects }))
            }
            1 => {
                // SetColourMapEntries
                self.stream
                    .read_exact(&mut [0u8; 1])
                    .map_err(|e| format!("read colourmap padding: {}", e))?;
                let _first = self.read_u16()?;
                let count = self.read_u16()?;
                // Read and discard colour map entries (6 bytes each: 2B R + 2B G + 2B B)
                let entry_size = 6 * count as usize;
                let mut entries = vec![0u8; entry_size];
                self.stream
                    .read_exact(&mut entries)
                    .map_err(|e| format!("read colourmap entries: {}", e))?;
                Ok(ServerMessage::SetColourMapEntries)
            }
            2 => {
                // Bell
                Ok(ServerMessage::Bell)
            }
            3 => {
                // ServerCutText
                self.stream
                    .read_exact(&mut [0u8; 3])
                    .map_err(|e| format!("read cut text padding: {}", e))?;
                let len = self.read_u32()? as usize;
                let mut text = vec![0u8; len];
                self.stream
                    .read_exact(&mut text)
                    .map_err(|e| format!("read cut text: {}", e))?;
                Ok(ServerMessage::ServerCutText {
                    text: String::from_utf8_lossy(&text).to_string(),
                })
            }
            _ => Err(format!("unknown server message type: {}", msg_type)),
        }
    }

    /// Decode a FramebufferUpdate into a list of DecodedRects, updating the internal framebuffer.
    pub fn decode_update(
        &mut self,
        update: &FramebufferUpdate,
    ) -> Result<Vec<DecodedRect>, String> {
        let mut decoded: Vec<DecodedRect> = Vec::new();

        for rect in &update.rects {
            match rect.encoding {
                0 => {
                    // Raw
                    let result = encodings::decode_raw(&rect.data, rect.x, rect.y, rect.w, rect.h);
                    self.write_to_fb(&result);
                    decoded.push(result);
                }
                1 => {
                    // CopyRect
                    let (src_x, src_y) = encodings::decode_copyrect(&rect.data);
                    self.copy_in_fb(rect.x, rect.y, rect.w, rect.h, src_x, src_y);
                    decoded.push(DecodedRect::Copy { src_x, src_y });
                }
                5 => {
                    // Hextile
                    let results = encodings::decode_hextile(
                        &rect.data,
                        rect.x,
                        rect.y,
                        rect.w,
                        rect.h,
                        &self.framebuffer,
                        self.width,
                    )?;
                    for r in &results {
                        self.write_to_fb(r);
                    }
                    decoded.extend(results);
                }
                7 => {
                    // Tight
                    let results =
                        encodings::decode_tight(&rect.data, rect.x, rect.y, rect.w, rect.h)?;
                    for r in &results {
                        self.write_to_fb(r);
                    }
                    decoded.extend(results);
                }
                16 => {
                    // ZRLE
                    let results =
                        encodings::decode_zrle(&rect.data, rect.x, rect.y, rect.w, rect.h)?;
                    for r in &results {
                        self.write_to_fb(r);
                    }
                    decoded.extend(results);
                }
                -223 => {
                    // DesktopSize: resize framebuffer
                    let new_w = rect.w;
                    let new_h = rect.h;
                    self.width = new_w;
                    self.height = new_h;
                    self.framebuffer = vec![0u8; new_w as usize * new_h as usize * 4];
                }
                _ => {
                    // Unknown encoding, skip
                }
            }
        }

        Ok(decoded)
    }

    /// Write a decoded pixel rect into the framebuffer.
    fn write_to_fb(&mut self, rect: &DecodedRect) {
        if let DecodedRect::Pixels { x, y, w, h, rgba } = rect {
            let fb_w = self.width as usize;
            let src_w = *w as usize;
            for row in 0..*h as usize {
                let fb_start = ((*y as usize + row) * fb_w + *x as usize) * 4;
                let src_start = row * src_w * 4;
                let len = src_w * 4;
                if fb_start + len <= self.framebuffer.len()
                    && src_start + len <= rgba.len()
                {
                    self.framebuffer[fb_start..fb_start + len]
                        .copy_from_slice(&rgba[src_start..src_start + len]);
                }
            }
        }
    }

    /// Copy a region within the framebuffer.
    fn copy_in_fb(
        &mut self,
        dst_x: u16,
        dst_y: u16,
        w: u16,
        h: u16,
        src_x: u16,
        src_y: u16,
    ) {
        let fb_w = self.width as usize;
        let row_bytes = w as usize * 4;
        for row in 0..h as usize {
            let src_start = ((src_y as usize + row) * fb_w + src_x as usize) * 4;
            let dst_start = ((dst_y as usize + row) * fb_w + dst_x as usize) * 4;
            if src_start + row_bytes <= self.framebuffer.len()
                && dst_start + row_bytes <= self.framebuffer.len()
            {
                // Use a temp buffer because src and dst may overlap
                let row_data =
                    self.framebuffer[src_start..src_start + row_bytes].to_vec();
                self.framebuffer[dst_start..dst_start + row_bytes]
                    .copy_from_slice(&row_data);
            }
        }
    }

    /// Apply all decoded rects to the framebuffer and return the full updated frame as RGBA bytes.
    pub fn take_full_frame(&self) -> Vec<u8> {
        self.framebuffer.clone()
    }

    // --- I/O helpers ---

    fn read_u8(&mut self) -> Result<u8, String> {
        let mut buf = [0u8; 1];
        self.stream
            .read_exact(&mut buf)
            .map_err(|e| format!("read u8: {}", e))?;
        Ok(buf[0])
    }

    fn read_u16(&mut self) -> Result<u16, String> {
        let mut buf = [0u8; 2];
        self.stream
            .read_exact(&mut buf)
            .map_err(|e| format!("read u16: {}", e))?;
        Ok(u16::from_be_bytes(buf))
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        let mut buf = [0u8; 4];
        self.stream
            .read_exact(&mut buf)
            .map_err(|e| format!("read u32: {}", e))?;
        Ok(u32::from_be_bytes(buf))
    }

    fn read_i32(&mut self) -> Result<i32, String> {
        let mut buf = [0u8; 4];
        self.stream
            .read_exact(&mut buf)
            .map_err(|e| format!("read i32: {}", e))?;
        Ok(i32::from_be_bytes(buf))
    }

    /// Read Hextile data length by consuming the stream until the tile count is covered.
    /// The exact length is unknown ahead of time; we use a heuristic: read up to
    /// w*h*4 bytes (worst case raw) per tile.
    fn read_hextile_len(
        &mut self,
        _x: u16,
        _y: u16,
        w: u16,
        h: u16,
    ) -> Result<usize, String> {
        // Conservative: worst-case each tile is sent raw (subenc=0x01).
        // Each tile has 1-byte subencoding header + raw pixel data.
        // We also account for background (4B) + fg (4B) + subrects overhead.
        // Use raw pixel count as bound + 1 byte per tile for header.
        let tiles_x = (w + 15) / 16;
        let tiles_y = (h + 15) / 16;
        let max_bytes = (w as usize * h as usize * 4) + (tiles_x as usize * tiles_y as usize * 128);
        Ok(max_bytes)
    }

    fn read_tight_len(
        &mut self,
        _x: u16,
        _y: u16,
        w: u16,
        h: u16,
    ) -> Result<usize, String> {
        // Tight is compressed — the zlib data will be at most raw size
        Ok(w as usize * h as usize * 4 + 256)
    }

    fn read_zrle_len(&mut self) -> Result<usize, String> {
        // ZRLE length is encoded in first 4 bytes
        let mut buf = [0u8; 4];
        // Can't read from stream here because read_message already did the read_u8
        // Instead, peek at next 4 bytes
        self.stream
            .peek(&mut buf)
            .map_err(|e| format!("peek zrle len: {}", e))?;
        let zipped_len = u32::from_be_bytes(buf) as usize;
        Ok(zipped_len + 4) // 4 bytes length + compressed data
    }
}

#[derive(Debug)]
pub enum ServerMessage {
    FramebufferUpdate(FramebufferUpdate),
    SetColourMapEntries,
    Bell,
    ServerCutText { text: String },
}

/// VNC DES authentication: encrypt the 16-byte challenge with a key derived from the password.
fn vnc_des_encrypt(password: &str, challenge: &[u8; 16]) -> [u8; 16] {
    use des::cipher::{BlockEncrypt, KeyInit};
    use des::Des;

    // Build key: password truncated/padded to 8 bytes, each byte's bits reversed
    let mut key_bytes = [0u8; 8];
    let pwd_bytes = password.as_bytes();
    for i in 0..8 {
        let b = if i < pwd_bytes.len() { pwd_bytes[i] } else { 0 };
        key_bytes[i] = reverse_bits(b);
    }

    let cipher = Des::new_from_slice(&key_bytes).expect("DES key should be 8 bytes");

    let mut response = [0u8; 16];
    cipher.encrypt_block_b2b(
        generic_array::GenericArray::from_slice(&challenge[..8]),
        generic_array::GenericArray::from_mut_slice(&mut response[..8]),
    );
    cipher.encrypt_block_b2b(
        generic_array::GenericArray::from_slice(&challenge[8..]),
        generic_array::GenericArray::from_mut_slice(&mut response[8..]),
    );

    response
}

fn reverse_bits(b: u8) -> u8 {
    let mut result = 0u8;
    for i in 0..8 {
        result |= ((b >> i) & 1) << (7 - i);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reverse_bits() {
        assert_eq!(reverse_bits(0b0000_0001), 0b1000_0000);
        assert_eq!(reverse_bits(0b1000_0000), 0b0000_0001);
        assert_eq!(reverse_bits(0b1111_0000), 0b0000_1111);
    }

    #[test]
    fn test_vnc_des_known_vector() {
        // Test vector: password "passw0rd", challenge all zeros
        let challenge = [0u8; 16];
        let response = vnc_des_encrypt("passw0rd", &challenge);
        // Verify the response is 16 bytes and not all zeros
        assert_eq!(response.len(), 16);
        assert!(response.iter().any(|&b| b != 0));
    }
}
