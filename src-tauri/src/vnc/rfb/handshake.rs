use super::model::PendingSecurity;
use super::model::RfbConnection;
use super::model::ServerInit;
use super::negotiation::CREDENTIALS_REQUIRED;
use super::negotiation::SEC_TYPE_ARD;
use super::negotiation::SEC_TYPE_NONE;
use super::negotiation::SEC_TYPE_RA2_128;
use super::negotiation::SEC_TYPE_RA2_256;
use super::negotiation::SEC_TYPE_RA2NE_128;
use super::negotiation::SEC_TYPE_RA2NE_256;
use super::negotiation::SEC_TYPE_VNC_AUTH;
use super::negotiation::authentication_read_error;
use super::negotiation::missing_password;
use super::negotiation::needs_password;
use super::negotiation::negotiate_protocol_version;
use crate::vnc::framebuffer::Framebuffer;
use crate::vnc::policy::VncSecurityPolicy;
use crate::vnc::rfb::security::vnc_des_encrypt;
use std::io::Read;
use std::io::Write;

impl RfbConnection {
    /// Perform protocol version handshake.
    /// Negotiates the highest mutually supported minor version (3, 7, or 8).
    pub(super) fn handshake_protocol_version(&mut self) -> Result<(), String> {
        let mut buf = [0u8; 12];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read protocol version: {}", e))?;

        let (reply, negotiated_minor) = negotiate_protocol_version(&buf)?;

        self.proto_minor = negotiated_minor;

        self.write_all(&reply)
            .map_err(|e| format!("write protocol version: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Perform security handshake and return ServerInit on success.
    pub fn authenticate(
        &mut self,
        username: Option<&str>,
        password: Option<&str>,
    ) -> Result<ServerInit, String> {
        self.authenticate_with_policy(username, password, self.security_policy)
    }

    pub fn authenticate_with_policy(
        &mut self,
        username: Option<&str>,
        password: Option<&str>,
        policy: VncSecurityPolicy,
    ) -> Result<ServerInit, String> {
        self.security_policy = policy;
        if matches!(self.pending_security, Some(PendingSecurity::V33(_))) {
            let Some(PendingSecurity::V33(sec_type)) = self.pending_security.take() else {
                unreachable!();
            };
            return self.authenticate_v33_with_policy(password, policy, Some(sec_type));
        }
        // RFB 3.3: server dictates the security type directly as a u32.
        if self.proto_minor <= 3 {
            return self.authenticate_v33_with_policy(password, policy, None);
        }

        let has_username = username.is_some_and(|name| !name.trim().is_empty());
        let (chosen, write_selection) = match self.pending_security.take() {
            Some(PendingSecurity::Selected(chosen)) => (chosen, false),
            Some(PendingSecurity::V33(_)) => unreachable!(),
            None => (self.read_and_choose_security_type(has_username)?, true),
        };
        self.security_type = Some(chosen);
        if needs_password(chosen) && missing_password(password) {
            return Err(CREDENTIALS_REQUIRED.into());
        }

        if write_selection {
            self.write_all(&[chosen])
                .map_err(|e| format!("write security type: {}", e))?;
            self.flush().map_err(|e| format!("flush: {}", e))?;
        }

        match chosen {
            SEC_TYPE_NONE => {} // None — no auth
            SEC_TYPE_VNC_AUTH => {
                let pwd = password.unwrap_or("");
                self.vnc_auth_des(pwd)?;
            }
            SEC_TYPE_RA2_128 | SEC_TYPE_RA2NE_128 | SEC_TYPE_RA2_256 | SEC_TYPE_RA2NE_256 => {
                let pwd = password.unwrap_or("");
                self.vnc_auth_ra2(chosen, username.unwrap_or(""), pwd)?;
            }
            SEC_TYPE_ARD => {
                self.vnc_auth_ard(username.unwrap_or("").trim(), password.unwrap_or(""))?;
            }
            _ => unreachable!(),
        }

        // RFB 3.8 always sends SecurityResult; 3.7 only sends it on failure
        if self.proto_minor >= 8 || chosen != 1 {
            let mut result_buf = [0u8; 4];
            self.read_exact(&mut result_buf)
                .map_err(|e| authentication_read_error("waiting for the security result", e))?;
            let result = u32::from_be_bytes(result_buf);
            if result != 0 {
                // 3.8 sends a reason string; 3.7 does not
                if self.proto_minor >= 8 {
                    let mut len_buf = [0u8; 4];
                    self.read_exact(&mut len_buf)
                        .map_err(|e| format!("read auth failure len: {}", e))?;
                    let reason_len = u32::from_be_bytes(len_buf) as usize;
                    if reason_len > self.limits.max_reason_bytes {
                        return Err("VNC authentication reason exceeds configured limit".into());
                    }
                    let mut reason = vec![0u8; reason_len];
                    self.read_exact(&mut reason)
                        .map_err(|e| format!("read auth failure reason: {}", e))?;
                    return Err(format!(
                        "authentication failed: {}",
                        String::from_utf8_lossy(&reason)
                    ));
                } else {
                    return Err(format!(
                        "authentication failed (security result: {})",
                        result
                    ));
                }
            }
        }

        // ClientInit: send shared flag
        self.write_all(&[u8::from(self.shared)])
            .map_err(|e| format!("write client init: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        self.read_server_init()
    }

    pub(super) fn read_and_choose_security_type(
        &mut self,
        has_username: bool,
    ) -> Result<u8, String> {
        let mut sec_buf = [0u8; 1];
        self.read_exact(&mut sec_buf)
            .map_err(|e| authentication_read_error("reading the security type count", e))?;

        let num_types = sec_buf[0] as usize;
        if num_types == 0 {
            let mut len_buf = [0u8; 4];
            self.read_exact(&mut len_buf)
                .map_err(|e| authentication_read_error("reading the rejection reason", e))?;
            let reason_len = u32::from_be_bytes(len_buf) as usize;
            if reason_len > self.limits.max_reason_bytes {
                return Err("VNC failure reason exceeds configured limit".into());
            }
            let mut reason = vec![0u8; reason_len];
            self.read_exact(&mut reason)
                .map_err(|e| authentication_read_error("reading the rejection reason", e))?;
            return Err(format!(
                "server rejected connection: {}",
                String::from_utf8_lossy(&reason)
            ));
        }

        let mut types = vec![0u8; num_types];
        self.read_exact(&mut types)
            .map_err(|e| authentication_read_error("reading the security types", e))?;
        self.security_policy
            .choose_with_username(&types, has_username)
            .map_err(|e| e.0)
    }

    /// RFB 3.3 security handshake: server sends a u32 security type, no client choice.
    pub(super) fn authenticate_v33_with_policy(
        &mut self,
        password: Option<&str>,
        policy: VncSecurityPolicy,
        pending_security_type: Option<u32>,
    ) -> Result<ServerInit, String> {
        let sec_type = match pending_security_type {
            Some(value) => value,
            None => {
                let mut buf = [0u8; 4];
                self.read_exact(&mut buf)
                    .map_err(|e| authentication_read_error("reading the security type", e))?;
                u32::from_be_bytes(buf)
            }
        };
        if sec_type == 1 && !policy.allows_v33_none() {
            return Err(
                "server offers unauthenticated VNC; enable allow-none explicitly to continue"
                    .into(),
            );
        }
        if !matches!(sec_type, 1 | 2) {
            return Err(format!("unsupported v3.3 security type: {}", sec_type));
        }
        self.security_type = Some(sec_type as u8);
        match sec_type {
            1 => {
                // None — no authentication, proceed directly to ClientInit
                self.write_all(&[u8::from(self.shared)])
                    .map_err(|e| format!("write client init: {}", e))?;
                self.flush().map_err(|e| format!("flush: {}", e))?;
                self.read_server_init()
            }
            2 => {
                // VNC Authentication
                if missing_password(password) {
                    return Err(CREDENTIALS_REQUIRED.into());
                }
                let pwd = password.unwrap_or("");
                self.vnc_auth_des(pwd)?;

                // SecurityResult
                let mut result_buf = [0u8; 4];
                self.read_exact(&mut result_buf)
                    .map_err(|e| authentication_read_error("waiting for the security result", e))?;
                let result = u32::from_be_bytes(result_buf);
                if result != 0 {
                    return Err(format!("authentication failed (result={})", result));
                }

                self.write_all(&[u8::from(self.shared)])
                    .map_err(|e| format!("write client init: {}", e))?;
                self.flush().map_err(|e| format!("flush: {}", e))?;
                self.read_server_init()
            }
            _ => Err(format!("unsupported v3.3 security type: {}", sec_type)),
        }
    }

    /// VNC DES authentication (security type 2).
    pub(super) fn vnc_auth_des(&mut self, password: &str) -> Result<(), String> {
        let mut challenge = [0u8; 16];
        self.read_exact(&mut challenge)
            .map_err(|e| authentication_read_error("reading the VNC challenge", e))?;

        let response = vnc_des_encrypt(password, &challenge);

        self.write_all(&response)
            .map_err(|e| format!("write VNC response: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    pub(super) fn read_server_init(&mut self) -> Result<ServerInit, String> {
        let mut buf = [0u8; 24];
        self.read_exact(&mut buf)
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
        if name_len > self.limits.max_server_string_bytes {
            return Err("VNC server name exceeds configured limit".into());
        }
        self.limits
            .framebuffer_bytes(self.width, self.height)
            .map_err(|e| e.to_string())?;
        let mut name_bytes = vec![0u8; name_len];
        self.read_exact(&mut name_bytes)
            .map_err(|e| format!("read server name: {}", e))?;
        self.name = String::from_utf8_lossy(&name_bytes).to_string();

        // Allocate framebuffer (RGBA 32-bit) only after applying hard limits.
        let framebuffer = Framebuffer::new(self.width, self.height, &self.limits)?;
        *self.lock_framebuffer()? = framebuffer;

        Ok(ServerInit {
            width: self.width,
            height: self.height,
            name: self.name.clone(),
        })
    }
}
