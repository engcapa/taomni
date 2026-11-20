use std::io::Error;
use std::io::ErrorKind;

pub(super) const SEC_TYPE_NONE: u8 = 1;
pub(super) const SEC_TYPE_VNC_AUTH: u8 = 2;
pub(super) const SEC_TYPE_RA2_128: u8 = 5;
pub(super) const SEC_TYPE_RA2NE_128: u8 = 6;
pub(crate) const SEC_TYPE_ANONYMOUS_TLS: u8 = 18;
pub(super) const SEC_TYPE_RA2_256: u8 = 129;
pub(super) const SEC_TYPE_RA2NE_256: u8 = 130;
/// Apple Remote Desktop (macOS Screen Sharing).
pub(super) const SEC_TYPE_ARD: u8 = 30;
/// Diffie-Hellman modulus sizes accepted for ARD (macOS sends 128 bytes).
pub(super) const ARD_MIN_KEY_BYTES: usize = 64;
pub(super) const ARD_MAX_KEY_BYTES: usize = 1024;
/// Username and password are NUL-terminated in 64-byte fields.
pub(super) const ARD_FIELD_BYTES: usize = 64;

/// The chosen security type needs a password the caller did not supply; the
/// attempt stops before any challenge is answered so the viewer can ask
/// (DEC-VNC-21). `VncError::classify` maps it to `credentials-required`.
pub(crate) const CREDENTIALS_REQUIRED: &str =
    "credentials required: the server asks for a password to log in";

/// Security types that authenticate with a password.
pub(super) fn needs_password(sec_type: u8) -> bool {
    matches!(
        sec_type,
        SEC_TYPE_VNC_AUTH
            | SEC_TYPE_RA2_128
            | SEC_TYPE_RA2NE_128
            | SEC_TYPE_RA2_256
            | SEC_TYPE_RA2NE_256
            | SEC_TYPE_ARD
    )
}

pub(super) fn missing_password(password: Option<&str>) -> bool {
    password.is_none_or(str::is_empty)
}

pub(super) const RA2_SUBTYPE_USER_PASS: u8 = 1;
pub(super) const RA2_SUBTYPE_PASS: u8 = 2;
pub(super) const RA2_MIN_KEY_BITS: usize = 1024;
pub(super) const RA2_MAX_KEY_BITS: usize = 8192;
pub(super) const RA2_AES_FRAME_MAX: usize = 8192;

pub(crate) fn negotiate_protocol_version(
    server_banner: &[u8; 12],
) -> Result<([u8; 12], u8), String> {
    if &server_banner[..4] != b"RFB " || server_banner[11] != b'\n' {
        return Err(format!(
            "invalid RFB version: {:?}",
            String::from_utf8_lossy(server_banner)
        ));
    }

    let major: u32 = std::str::from_utf8(&server_banner[4..7])
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3);
    let minor: u32 = std::str::from_utf8(&server_banner[8..11])
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3);

    let (reply, negotiated_minor) = if major > 3 || minor >= 8 {
        (*b"RFB 003.008\n", 8)
    } else if minor >= 7 {
        (*b"RFB 003.007\n", 7)
    } else {
        (*b"RFB 003.003\n", 3)
    };
    Ok((reply, negotiated_minor))
}

pub(super) fn authentication_read_error(action: &str, error: Error) -> String {
    if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) {
        format!("VNC authentication timed out while {action}")
    } else {
        format!("VNC authentication failed while {action}: {error}")
    }
}
