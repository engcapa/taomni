//! RFC 4226 (HOTP) and RFC 6238 (TOTP) one-time passwords, plus the RFC 4648
//! Base32 alphabet used by `otpauth://` secrets.

use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Sha256, Sha512};

pub const MIN_DIGITS: u32 = 6;
pub const MAX_DIGITS: u32 = 8;
pub const MIN_PERIOD: u32 = 15;
pub const MAX_PERIOD: u32 = 300;
/// Google Authenticator rejects shorter keys; anything below 80 bits is almost
/// certainly a typo rather than a real enrollment secret.
pub const MIN_SECRET_BYTES: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OtpAlgorithm {
    #[serde(rename = "SHA1")]
    Sha1,
    #[serde(rename = "SHA256")]
    Sha256,
    #[serde(rename = "SHA512")]
    Sha512,
}

impl OtpAlgorithm {
    pub fn as_str(self) -> &'static str {
        match self {
            OtpAlgorithm::Sha1 => "SHA1",
            OtpAlgorithm::Sha256 => "SHA256",
            OtpAlgorithm::Sha512 => "SHA512",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "SHA1" => Some(OtpAlgorithm::Sha1),
            "SHA256" => Some(OtpAlgorithm::Sha256),
            "SHA512" => Some(OtpAlgorithm::Sha512),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OtpKind {
    Totp,
    Hotp,
}

impl OtpKind {
    pub fn as_str(self) -> &'static str {
        match self {
            OtpKind::Totp => "totp",
            OtpKind::Hotp => "hotp",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "totp" => Some(OtpKind::Totp),
            "hotp" => Some(OtpKind::Hotp),
            _ => None,
        }
    }
}

/// Decode a Base32 secret. Case-insensitive; spaces, hyphens and `=` padding
/// are ignored because users paste secrets grouped like `JBSW Y3DP …`.
pub fn decode_base32(input: &str) -> Result<Vec<u8>, String> {
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    let mut out = Vec::with_capacity(input.len() * 5 / 8);
    for ch in input.chars() {
        if ch.is_whitespace() || ch == '-' || ch == '=' {
            continue;
        }
        let value = match ch.to_ascii_uppercase() {
            c @ 'A'..='Z' => c as u32 - 'A' as u32,
            c @ '2'..='7' => c as u32 - '2' as u32 + 26,
            other => return Err(format!("invalid Base32 character {other:?}")),
        };
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

/// Unpadded RFC 4648 Base32, the form authenticator apps expect in `secret=`.
pub fn encode_base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
        buffer &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Percent-encode everything except RFC 3986 unreserved characters.
fn uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Fields of one account for an `otpauth://` link (Google Key URI format).
pub struct OtpauthFields<'a> {
    pub kind: OtpKind,
    pub issuer: &'a str,
    pub account_name: &'a str,
    pub secret: &'a [u8],
    pub algorithm: OtpAlgorithm,
    pub digits: u32,
    pub period: u32,
    pub counter: u64,
}

/// `otpauth://` link other authenticator apps can scan. The label is
/// `issuer:account` (the issuer is repeated as a parameter, as Google's format
/// recommends); HOTP links carry the current counter, TOTP links the period.
pub fn otpauth_uri(fields: &OtpauthFields<'_>) -> String {
    let label = if fields.issuer.is_empty() {
        uri_component(fields.account_name)
    } else {
        format!(
            "{}:{}",
            uri_component(fields.issuer),
            uri_component(fields.account_name)
        )
    };
    let mut uri = format!(
        "otpauth://{}/{label}?secret={}",
        fields.kind.as_str(),
        encode_base32(fields.secret)
    );
    if !fields.issuer.is_empty() {
        uri.push_str(&format!("&issuer={}", uri_component(fields.issuer)));
    }
    uri.push_str(&format!(
        "&algorithm={}&digits={}",
        fields.algorithm.as_str(),
        fields.digits
    ));
    match fields.kind {
        OtpKind::Totp => uri.push_str(&format!("&period={}", fields.period)),
        OtpKind::Hotp => uri.push_str(&format!("&counter={}", fields.counter)),
    }
    uri
}

/// RFC 4226 HOTP value for `counter`, zero-padded to `digits`.
pub fn hotp(secret: &[u8], counter: u64, digits: u32, algorithm: OtpAlgorithm) -> String {
    let message = counter.to_be_bytes();
    let digest = match algorithm {
        OtpAlgorithm::Sha1 => {
            let mut mac =
                Hmac::<Sha1>::new_from_slice(secret).expect("hmac accepts any key length");
            mac.update(&message);
            mac.finalize().into_bytes().to_vec()
        }
        OtpAlgorithm::Sha256 => {
            let mut mac =
                Hmac::<Sha256>::new_from_slice(secret).expect("hmac accepts any key length");
            mac.update(&message);
            mac.finalize().into_bytes().to_vec()
        }
        OtpAlgorithm::Sha512 => {
            let mut mac =
                Hmac::<Sha512>::new_from_slice(secret).expect("hmac accepts any key length");
            mac.update(&message);
            mac.finalize().into_bytes().to_vec()
        }
    };
    // Dynamic truncation (RFC 4226 §5.3).
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = (u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    let value = binary % 10u32.pow(digits);
    format!("{value:0width$}", width = digits as usize)
}

/// RFC 6238 time step for a Unix timestamp in milliseconds (T0 = 0).
pub fn totp_step(unix_ms: i64, period: u32) -> u64 {
    unix_ms.div_euclid(i64::from(period) * 1000).max(0) as u64
}

/// RFC 6238 TOTP value at `unix_ms`.
pub fn totp(
    secret: &[u8],
    unix_ms: i64,
    period: u32,
    digits: u32,
    algorithm: OtpAlgorithm,
) -> String {
    hotp(secret, totp_step(unix_ms, period), digits, algorithm)
}
