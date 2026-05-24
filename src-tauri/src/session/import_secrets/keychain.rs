// Generic OS keychain batch reader for session importers.
//
// Importers (Tabby, Termius, SecureCRT, ...) store remembered passwords
// in Credential Manager (Windows), Keychain Services (macOS) or
// Secret Service (Linux). The naming convention differs per tool —
// Tabby uses `service = "ssh@<host>[:<port>]"` / `account = <user>` —
// so the caller (frontend) builds the (service, account) pairs and we
// just look them up. NoEntry is a normal miss; other errors are
// surfaced per-entry so a single broken record doesn't fail the batch.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeychainQuery {
    pub service: String,
    pub account: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeychainHit {
    pub service: String,
    pub account: String,
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn lookup_one(query: &KeychainQuery) -> KeychainHit {
    match keyring::Entry::new(&query.service, &query.account) {
        Ok(entry) => match entry.get_password() {
            Ok(secret) => KeychainHit {
                service: query.service.clone(),
                account: query.account.clone(),
                found: true,
                value: Some(secret),
                error: None,
            },
            Err(keyring::Error::NoEntry) => KeychainHit {
                service: query.service.clone(),
                account: query.account.clone(),
                found: false,
                value: None,
                error: None,
            },
            Err(e) => KeychainHit {
                service: query.service.clone(),
                account: query.account.clone(),
                found: false,
                value: None,
                error: Some(e.to_string()),
            },
        },
        Err(e) => KeychainHit {
            service: query.service.clone(),
            account: query.account.clone(),
            found: false,
            value: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub async fn keychain_lookup_batch(entries: Vec<KeychainQuery>) -> Result<Vec<KeychainHit>, String> {
    Ok(entries.iter().map(lookup_one).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_entry_reports_not_found_without_error() {
        let q = KeychainQuery {
            service: "newmob-tests-does-not-exist-9f8a7b6c".to_string(),
            account: "nobody".to_string(),
        };
        let hit = lookup_one(&q);
        assert!(!hit.found);
        assert!(hit.value.is_none());
        // Linux without a secret service daemon may surface a PlatformFailure
        // rather than NoEntry; either case is acceptable for "no value".
    }
}
