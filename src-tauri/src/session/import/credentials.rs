use super::model::DbeaverCredentialEntry;
use crate::session::import_secrets::crypto::aes_128_cbc_decrypt_pkcs7;
use serde_json::Value;
use std::collections::HashMap;

pub(super) const DBEAVER_CREDENTIALS_CONFIG_FILE: &str = "credentials-config.json";
pub(super) const DBEAVER_LOCAL_CREDENTIALS_KEY: [u8; 16] = [
    0xba, 0xbb, 0x4a, 0x9f, 0x77, 0x4a, 0xb8, 0x53, 0xc9, 0x6c, 0x2d, 0x65, 0x3d, 0xfe, 0x54, 0x4a,
];

pub(super) fn parse_dbeaver_credentials_config(
    encrypted: &[u8],
) -> Result<HashMap<String, DbeaverCredentialEntry>, String> {
    if encrypted.len() <= 16 {
        return Err("encrypted payload is too short".to_string());
    }
    let iv = &encrypted[..16];
    let ciphertext = &encrypted[16..];
    let plaintext = aes_128_cbc_decrypt_pkcs7(&DBEAVER_LOCAL_CREDENTIALS_KEY, iv, ciphertext)
        .map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_slice(plaintext.as_slice())
        .map_err(|e| format!("decrypted payload is not valid JSON: {}", e))?;
    Ok(extract_dbeaver_credentials(parsed))
}

pub(super) fn extract_dbeaver_credentials(
    parsed: Value,
) -> HashMap<String, DbeaverCredentialEntry> {
    let mut out = HashMap::new();
    let Some(root) = parsed.as_object() else {
        return out;
    };

    for (connection_id, raw_sections) in root {
        let Some(section_object) = raw_sections.as_object() else {
            continue;
        };
        let Some(connection_section) = section_object
            .get("#connection")
            .and_then(|value| value.as_object())
        else {
            continue;
        };
        let mut entry = DbeaverCredentialEntry::default();
        entry.user = first_non_empty_json_field(connection_section, &["user", "username"]);
        entry.password = first_non_empty_json_field(connection_section, &["password"]);
        if entry.user.is_some() || entry.password.is_some() {
            out.insert(connection_id.clone(), entry);
        }
    }

    out
}

pub(super) fn first_non_empty_json_field(
    fields: &serde_json::Map<String, Value>,
    names: &[&str],
) -> Option<String> {
    for name in names {
        if let Some(value) = fields.get(*name) {
            if let Some(text) = value.as_str() {
                if !text.trim().is_empty() {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
}
