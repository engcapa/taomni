//! SSH X11 channel forwarding: bridge an inbound `x11` SSH channel to the
//! local system X server, with MIT-MAGIC-COOKIE-1 authentication.
//!
//! Two trust modes (mirroring OpenSSH's `ForwardX11Trusted`):
//!
//! * **Trusted** (`-Y`): advertise the *real* local cookie to the remote side
//!   via `request_x11`. Inbound X11 connections already carry the right cookie,
//!   so we pump bytes straight through. Simplest and most compatible; this is
//!   also MobaXterm's default behavior.
//!
//! * **Untrusted** (`-X`): advertise a freshly generated *fake* cookie to the
//!   remote side. Each inbound X11 connection then presents that fake cookie in
//!   its connection-setup packet; we validate it, rewrite it to the real local
//!   cookie, and forward. A bad cookie is rejected (connection dropped).
//!
//! The fake-cookie path requires parsing just the fixed-layout X11 setup
//! prologue (`XConnClientPrefix`), which is what [`rewrite_setup_cookie`] does.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::terminal::x11::{LocalXStream, XDisplay};

/// Resolved X11 forwarding configuration for one SSH session.
#[derive(Clone)]
pub struct XForward {
    /// The local X server endpoint + real cookie.
    pub display: Arc<XDisplay>,
    /// `true` => trusted mode (advertise real cookie, pass-through).
    /// `false` => untrusted mode (advertise fake cookie, validate+rewrite).
    pub trusted: bool,
    /// The cookie advertised to the remote side, hex-encoded. In trusted mode
    /// this equals the real cookie; in untrusted mode it's the fake one.
    pub advertised_cookie_hex: String,
    /// Raw fake cookie bytes (untrusted mode only; empty in trusted mode).
    pub fake_cookie: Vec<u8>,
    /// Auth protocol name advertised to the remote (`MIT-MAGIC-COOKIE-1`).
    pub advertised_protocol: String,
}

impl XForward {
    /// Build forwarding config from a resolved local display.
    ///
    /// In untrusted mode a random 16-byte cookie is generated to hand to the
    /// remote; the real local cookie is kept private and swapped in per
    /// connection. Untrusted mode is only meaningful when we actually have a
    /// real local cookie to protect — otherwise we fall back to trusted
    /// pass-through (there is nothing to validate against).
    pub fn new(display: Arc<XDisplay>, trusted: bool) -> Self {
        let have_real_cookie = !display.auth_cookie.is_empty();
        let protocol = if display.auth_protocol.is_empty() {
            "MIT-MAGIC-COOKIE-1".to_string()
        } else {
            display.auth_protocol.clone()
        };

        if trusted || !have_real_cookie {
            // Advertise the real cookie (may be empty if the server runs with
            // auth disabled, in which case the remote sends no cookie either).
            return XForward {
                advertised_cookie_hex: hex::encode(&display.auth_cookie),
                advertised_protocol: protocol,
                fake_cookie: Vec::new(),
                trusted: true,
                display,
            };
        }

        // Untrusted: generate a fake cookie of the same length as the real one
        // (or 16 bytes) to advertise.
        use rand::RngCore;
        let len = display.auth_cookie.len().max(16);
        let mut fake = vec![0u8; len];
        rand::thread_rng().fill_bytes(&mut fake);
        XForward {
            advertised_cookie_hex: hex::encode(&fake),
            advertised_protocol: protocol,
            fake_cookie: fake,
            trusted: false,
            display,
        }
    }
}

/// Bridge one inbound X11 SSH channel (`remote`) to a fresh local X server
/// connection. Spawned as a task per channel by the SSH handler.
///
/// `remote` is the SSH channel's byte stream (already `AsyncRead+AsyncWrite`).
pub async fn bridge<R>(forward: Arc<XForward>, mut remote: R) -> Result<(), String>
where
    R: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let mut local = forward.display.connect_local().await?;

    if forward.trusted {
        // Straight pass-through.
        tokio::io::copy_bidirectional(&mut remote, &mut local)
            .await
            .map(|_| ())
            .map_err(|e| format!("X11 bridge: {}", e))
    } else {
        // Untrusted: read the client setup prologue from the remote, validate
        // and rewrite the cookie, replay the rewritten setup to the local X
        // server, then pump the rest both ways.
        bridge_untrusted(forward, &mut remote, &mut local).await
    }
}

/// Untrusted-mode bridge: intercept the X11 connection-setup packet, swap the
/// fake cookie for the real one, and forward.
async fn bridge_untrusted<R>(
    forward: Arc<XForward>,
    remote: &mut R,
    local: &mut LocalXStream,
) -> Result<(), String>
where
    R: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    // The X11 client setup prologue is 12 bytes, followed by the auth protocol
    // name and auth data (each padded to 4 bytes). Read enough to cover it.
    let mut header = [0u8; 12];
    remote
        .read_exact(&mut header)
        .await
        .map_err(|e| format!("X11 setup read: {}", e))?;

    let big_endian = header[0] == 0x42; // 'B' big-endian, 'l' little-endian
    let read_u16 = |hi: u8, lo: u8| -> usize {
        if big_endian {
            ((hi as usize) << 8) | lo as usize
        } else {
            ((lo as usize) << 8) | hi as usize
        }
    };
    let proto_len = read_u16(header[6], header[7]);
    let data_len = read_u16(header[8], header[9]);

    let proto_pad = (4 - (proto_len % 4)) % 4;
    let data_pad = (4 - (data_len % 4)) % 4;

    let mut proto = vec![0u8; proto_len + proto_pad];
    remote
        .read_exact(&mut proto)
        .await
        .map_err(|e| format!("X11 setup proto read: {}", e))?;
    let mut data = vec![0u8; data_len + data_pad];
    remote
        .read_exact(&mut data)
        .await
        .map_err(|e| format!("X11 setup data read: {}", e))?;

    // Validate the presented cookie against the fake one we advertised.
    let presented = &data[..data_len];
    if presented != forward.fake_cookie.as_slice() {
        return Err("X11 untrusted: cookie mismatch (rejected)".to_string());
    }

    // Rewrite to the real local cookie. (Same length is guaranteed because the
    // fake cookie was generated at >= real length; but the server expects the
    // real cookie's length, so re-emit the setup with real proto/data lengths.)
    let real_cookie = &forward.display.auth_cookie;
    let real_proto = forward.advertised_protocol.as_bytes();

    let mut out = Vec::with_capacity(12 + 64 + real_cookie.len());
    // Copy the 12-byte prologue but fix the proto/data length fields.
    out.extend_from_slice(&header);
    let set_u16 = |buf: &mut [u8], off: usize, val: usize, be: bool| {
        let (hi, lo) = (((val >> 8) & 0xff) as u8, (val & 0xff) as u8);
        if be {
            buf[off] = hi;
            buf[off + 1] = lo;
        } else {
            buf[off] = lo;
            buf[off + 1] = hi;
        }
    };
    set_u16(&mut out, 6, real_proto.len(), big_endian);
    set_u16(&mut out, 8, real_cookie.len(), big_endian);

    let push_padded = |buf: &mut Vec<u8>, field: &[u8]| {
        buf.extend_from_slice(field);
        let pad = (4 - (field.len() % 4)) % 4;
        buf.extend(std::iter::repeat(0u8).take(pad));
    };
    push_padded(&mut out, real_proto);
    push_padded(&mut out, real_cookie);

    local
        .write_all(&out)
        .await
        .map_err(|e| format!("X11 local setup write: {}", e))?;
    local
        .flush()
        .await
        .map_err(|e| format!("X11 local flush: {}", e))?;

    // Now pump the remainder both directions.
    tokio::io::copy_bidirectional(remote, local)
        .await
        .map(|_| ())
        .map_err(|e| format!("X11 bridge: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::x11::{XDisplay, XTarget};
    use std::path::PathBuf;

    fn display_with_cookie(cookie: Vec<u8>) -> Arc<XDisplay> {
        Arc::new(XDisplay {
            display: ":0".to_string(),
            screen: 0,
            target: XTarget::Unix(PathBuf::from("/tmp/.X11-unix/X0")),
            auth_protocol: "MIT-MAGIC-COOKIE-1".to_string(),
            auth_cookie: cookie,
        })
    }

    #[test]
    fn trusted_advertises_real_cookie() {
        let cookie = vec![1u8, 2, 3, 4];
        let f = XForward::new(display_with_cookie(cookie.clone()), true);
        assert!(f.trusted);
        assert_eq!(f.advertised_cookie_hex, hex::encode(&cookie));
        assert!(f.fake_cookie.is_empty());
    }

    #[test]
    fn untrusted_generates_fake_cookie() {
        let cookie = vec![1u8, 2, 3, 4, 5, 6, 7, 8];
        let f = XForward::new(display_with_cookie(cookie.clone()), false);
        assert!(!f.trusted);
        assert!(!f.fake_cookie.is_empty());
        // Fake cookie must differ from the real one and not be advertised raw.
        assert_ne!(f.fake_cookie, cookie);
        assert_eq!(f.advertised_cookie_hex, hex::encode(&f.fake_cookie));
    }

    #[test]
    fn untrusted_without_real_cookie_falls_back_to_trusted() {
        let f = XForward::new(display_with_cookie(Vec::new()), false);
        // No real cookie to protect → trusted pass-through.
        assert!(f.trusted);
        assert!(f.fake_cookie.is_empty());
    }
}
