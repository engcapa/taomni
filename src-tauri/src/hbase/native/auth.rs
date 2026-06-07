//! HBase RPC authentication: simple (no negotiation) and Kerberos/GSSAPI.
//!
//! Simple auth (the default) writes the preamble with auth byte `0x50` and then
//! the ConnectionHeader directly; the server stays silent on success.
//!
//! Kerberos (`0x51`) inserts a SASL/GSSAPI token negotiation between the
//! preamble and the ConnectionHeader. The wire framing, transcribed from
//! HBase's `HBaseSaslRpcClient.saslConnect` (rel/2.6.1):
//! - client → server: `i32 BE token_len | token bytes` (initial response)
//! - server → client: `i32 BE status` (0 = SUCCESS), then `i32 BE len | token`
//!   where `len == -88` (`SWITCH_TO_SIMPLE_AUTH`) asks the client to downgrade.
//! - repeat until the SASL client reports complete.
//!
//! The Kerberos path is compiled only with the `hbase-kerberos` feature so the
//! default build pulls in no GSSAPI system libraries.

/// SASL status sentinel: success.
#[allow(dead_code)]
pub const SASL_SUCCESS: i32 = 0;
/// SASL length sentinel asking the client to fall back to simple auth.
#[allow(dead_code)]
pub const SWITCH_TO_SIMPLE_AUTH: i32 = -88;

/// Selected authentication method for a connection.
#[derive(Debug, Clone)]
pub enum AuthMethod {
    /// Simple auth (effective user only); preamble byte 0x50.
    Simple,
    /// Kerberos/GSSAPI; preamble byte 0x51. Carries the service principal name
    /// (SPN), e.g. `hbase/host@REALM`.
    Kerberos { service_principal: String },
}

impl AuthMethod {
    /// The preamble auth byte for this method.
    pub fn preamble_byte(&self) -> u8 {
        match self {
            AuthMethod::Simple => super::rpc::codec::AUTH_SIMPLE,
            AuthMethod::Kerberos { .. } => super::rpc::codec::AUTH_KERBEROS,
        }
    }
}

#[cfg(feature = "hbase-kerberos")]
pub mod kerberos {
    //! GSSAPI SASL negotiation over a tokio TCP connection.
    use cross_krb5::{ClientCtx, InitiateFlags, K5Ctx, Step};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Perform the HBase SASL/GSSAPI handshake on the raw socket halves, right
    /// after the preamble and before the ConnectionHeader. Returns `Ok(true)`
    /// when SASL completed, `Ok(false)` if the server asked to fall back to
    /// simple auth.
    ///
    /// `service_principal` is the server SPN, e.g. `hbase/rs1.example.com@REALM`.
    pub async fn sasl_connect<R, W>(
        read: &mut R,
        write: &mut W,
        service_principal: &str,
    ) -> Result<bool, String>
    where
        R: AsyncReadExt + Unpin,
        W: AsyncWriteExt + Unpin,
    {
        // Initial token.
        let (mut pending, token) =
            ClientCtx::new(InitiateFlags::empty(), None, service_principal, None)
                .map_err(|e| format!("GSSAPI init failed: {e}"))?;
        write_token(write, &token).await?;

        // First server reply: status + (challenge | switch-to-simple).
        read_status(read).await?;
        let len = read.read_i32().await.map_err(ioerr)?;
        if len == super::SWITCH_TO_SIMPLE_AUTH {
            return Ok(false);
        }
        let mut challenge = read_n(read, len).await?;

        // Negotiation loop.
        loop {
            match pending.step(&challenge).map_err(|e| format!("GSSAPI step failed: {e}"))? {
                Step::Finished((_ctx, last)) => {
                    if let Some(tok) = last {
                        write_token(write, &tok).await?;
                    }
                    return Ok(true);
                }
                Step::Continue((next, tok)) => {
                    write_token(write, &tok).await?;
                    read_status(read).await?;
                    let len = read.read_i32().await.map_err(ioerr)?;
                    challenge = read_n(read, len).await?;
                    pending = next;
                }
            }
        }
    }

    async fn write_token<W: AsyncWriteExt + Unpin>(
        write: &mut W,
        token: &[u8],
    ) -> Result<(), String> {
        write.write_i32(token.len() as i32).await.map_err(ioerr)?;
        write.write_all(token).await.map_err(ioerr)?;
        write.flush().await.map_err(ioerr)?;
        Ok(())
    }

    async fn read_status<R: AsyncReadExt + Unpin>(read: &mut R) -> Result<(), String> {
        let status = read.read_i32().await.map_err(ioerr)?;
        if status != super::SASL_SUCCESS {
            // On error the server sends two writable strings (class, message).
            let class = read_writable_string(read).await.unwrap_or_default();
            let msg = read_writable_string(read).await.unwrap_or_default();
            return Err(format!("SASL negotiation failed: {class}: {msg}"));
        }
        Ok(())
    }

    async fn read_n<R: AsyncReadExt + Unpin>(read: &mut R, len: i32) -> Result<Vec<u8>, String> {
        if len < 0 {
            return Err(format!("negative SASL token length {len}"));
        }
        let mut buf = vec![0u8; len as usize];
        read.read_exact(&mut buf).await.map_err(ioerr)?;
        Ok(buf)
    }

    /// Hadoop `WritableUtils.readString`: a vint length prefix + UTF-8 bytes.
    /// We approximate with a 4-byte length (sufficient for error text framing
    /// in practice; on parse trouble we just return what we read).
    async fn read_writable_string<R: AsyncReadExt + Unpin>(
        read: &mut R,
    ) -> Result<String, String> {
        let len = read.read_i32().await.map_err(ioerr)?;
        if !(0..=1_000_000).contains(&len) {
            return Ok(String::new());
        }
        let mut buf = vec![0u8; len as usize];
        read.read_exact(&mut buf).await.map_err(ioerr)?;
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }

    fn ioerr(e: std::io::Error) -> String {
        format!("SASL io error: {e}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preamble_bytes() {
        assert_eq!(AuthMethod::Simple.preamble_byte(), 0x50);
        assert_eq!(
            AuthMethod::Kerberos {
                service_principal: "hbase/h@R".into()
            }
            .preamble_byte(),
            0x51
        );
    }

    #[test]
    fn sasl_constants() {
        assert_eq!(SASL_SUCCESS, 0);
        assert_eq!(SWITCH_TO_SIMPLE_AUTH, -88);
    }
}
