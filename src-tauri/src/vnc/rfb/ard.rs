use super::model::RfbConnection;
use super::negotiation::ARD_MAX_KEY_BYTES;
use super::negotiation::ARD_MIN_KEY_BYTES;
use super::negotiation::authentication_read_error;
use crate::vnc::rfb::security::ard_response;
use std::io::Read;
use std::io::Write;

impl RfbConnection {
    /// Apple Remote Desktop authentication (security type 30, macOS Screen
    /// Sharing): the server sends a Diffie-Hellman generator, key length,
    /// prime and public key; the client answers with the macOS account name
    /// and password encrypted under MD5(shared secret) and its public key.
    pub(super) fn vnc_auth_ard(&mut self, username: &str, password: &str) -> Result<(), String> {
        use rsa::rand_core::OsRng;

        if username.is_empty() {
            return Err(
                "ARD authentication requires the macOS account name: no VNC username was provided"
                    .into(),
            );
        }
        let mut head = [0u8; 4];
        self.read_exact(&mut head)
            .map_err(|e| authentication_read_error("reading the ARD key parameters", e))?;
        let generator = u16::from_be_bytes([head[0], head[1]]);
        let key_len = u16::from_be_bytes([head[2], head[3]]) as usize;
        if !(ARD_MIN_KEY_BYTES..=ARD_MAX_KEY_BYTES).contains(&key_len) {
            return Err(format!(
                "ARD authentication: unsupported Diffie-Hellman key length {key_len} bytes"
            ));
        }
        let mut prime = vec![0u8; key_len];
        self.read_exact(&mut prime)
            .map_err(|e| authentication_read_error("reading the ARD prime", e))?;
        let mut server_public = vec![0u8; key_len];
        self.read_exact(&mut server_public)
            .map_err(|e| authentication_read_error("reading the ARD server key", e))?;

        let (credentials, client_public) = ard_response(
            generator,
            &prime,
            &server_public,
            username,
            password,
            &mut OsRng,
        )?;
        self.write_all(&credentials)
            .map_err(|e| format!("ARD authentication: write credentials: {e}"))?;
        self.write_all(&client_public)
            .map_err(|e| format!("ARD authentication: write public key: {e}"))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;
        Ok(())
    }
}
