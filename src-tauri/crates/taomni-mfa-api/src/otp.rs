use serde::{Deserialize, Serialize};

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
