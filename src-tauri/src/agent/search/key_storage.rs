// OS keyring storage for BYOK API keys.
//
// Used for web-search providers (Tavily, Serper, Brave, Exa, Google CSE)
// where the key is the user's own and shouldn't sit in ai.json. Each key is
// addressed by `service = "taomni.ai"` + `entry_name = <kind>:<provider>`.
//
// On platforms where the OS secret store is unavailable (e.g. headless
// Linux without a keyring daemon), the underlying `keyring` crate returns
// an error which we surface as `Err(_)` so the caller can decide whether
// to fall back to the existing AiConfig.byok_key field.
//
// Migration: the service was renamed `newmob.ai` -> `taomni.ai`. The OS
// keyring has no enumeration API, so we migrate lazily — `get` falls back to
// the legacy service and, on a hit, copies the secret under the new service
// (best-effort) so subsequent reads are fast.

use keyring::Entry;

const SERVICE: &str = "taomni.ai";
const LEGACY_SERVICE: &str = "newmob.ai";

fn entry(kind: &str, name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("{kind}:{name}")).map_err(|e| e.to_string())
}

fn legacy_entry(kind: &str, name: &str) -> Result<Entry, String> {
    Entry::new(LEGACY_SERVICE, &format!("{kind}:{name}")).map_err(|e| e.to_string())
}

pub fn put(kind: &str, name: &str, secret: &str) -> Result<(), String> {
    entry(kind, name)?
        .set_password(secret)
        .map_err(|e| e.to_string())
}

pub fn get(kind: &str, name: &str) -> Result<Option<String>, String> {
    match entry(kind, name)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => get_legacy_and_migrate(kind, name),
        Err(e) => Err(e.to_string()),
    }
}

/// Look up the key under the legacy `newmob.ai` service. On a hit, copy it to
/// the new service so future reads don't pay the fallback. Returns the secret
/// either way.
fn get_legacy_and_migrate(kind: &str, name: &str) -> Result<Option<String>, String> {
    match legacy_entry(kind, name)?.get_password() {
        Ok(secret) => {
            // Best-effort copy forward; ignore failures (e.g. read-only store).
            let _ = entry(kind, name).and_then(|e| {
                e.set_password(&secret).map_err(|err| err.to_string())
            });
            Ok(Some(secret))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn delete(kind: &str, name: &str) -> Result<(), String> {
    // Remove the legacy entry too so a renamed key doesn't resurrect via the
    // migration fallback.
    if let Ok(e) = legacy_entry(kind, name) {
        let _ = e.delete_credential();
    }
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
