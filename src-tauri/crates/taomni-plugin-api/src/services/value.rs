use serde::{Deserialize, Serialize};

use super::ContractError;

macro_rules! checked_string {
    ($name:ident, $validate:ident, $error:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, ContractError> {
                let value = value.into();
                if !$validate(&value) {
                    return Err(ContractError::$error);
                }
                Ok(Self(value))
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl TryFrom<String> for $name {
            type Error = ContractError;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::parse(value)
            }
        }
        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

checked_string!(FixedKeyId, valid_key_id, InvalidKeyId);
checked_string!(SafeRelativePath, valid_relative_path, InvalidRelativePath);
checked_string!(Sha256Digest, valid_digest, InvalidDigest);

fn valid_key_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
        && value.split('.').all(|part| !part.is_empty())
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.contains(['\\', ':'])
        && value.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.ends_with(['.', ' '])
                && !part.chars().any(char::is_control)
                && !reserved_windows_name(part)
        })
}

fn reserved_windows_name(part: &str) -> bool {
    let base = part
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    ["CON", "PRN", "AUX", "NUL"].contains(&base.as_str())
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && base.as_bytes()[3].is_ascii_digit())
}
