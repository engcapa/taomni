// OS keyring storage for BYOK API keys.
//
// Used for web-search providers (Tavily, Serper, Brave, Exa, Google CSE)
// where the key is the user's own and shouldn't sit in ai.json. Each key is
// addressed by `service = "newmob.ai"` + `entry_name = <kind>:<provider>`.
//
// On platforms where the OS secret store is unavailable (e.g. headless
// Linux without a keyring daemon), the underlying `keyring` crate returns
// an error which we surface as `Err(_)` so the caller can decide whether
// to fall back to the existing AiConfig.byok_key field.

use keyring::Entry;

const SERVICE: &str = "newmob.ai";

fn entry(kind: &str, name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("{kind}:{name}")).map_err(|e| e.to_string())
}

pub fn put(kind: &str, name: &str, secret: &str) -> Result<(), String> {
    entry(kind, name)?
        .set_password(secret)
        .map_err(|e| e.to_string())
}

pub fn get(kind: &str, name: &str) -> Result<Option<String>, String> {
    match entry(kind, name)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn delete(kind: &str, name: &str) -> Result<(), String> {
    match entry(kind, name)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn keyring_put(kind: String, name: String, secret: String) -> Result<(), String> {
    put(&kind, &name, &secret)
}

#[tauri::command]
pub async fn keyring_get(kind: String, name: String) -> Result<Option<String>, String> {
    get(&kind, &name)
}

#[tauri::command]
pub async fn keyring_delete(kind: String, name: String) -> Result<(), String> {
    delete(&kind, &name)
}
