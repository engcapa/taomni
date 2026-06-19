//! Machine-bound secret storage for LanChat at-rest keys (phase 0).
//!
//! Stores the message-encryption key and the node identity private key bound to
//! this machine. Primary backend is the OS keychain (macOS Keychain / Windows
//! Credential Manager / Linux Secret Service) via `keyring`; when that is
//! unavailable (headless Linux without a running secret service) it transparently
//! falls back to a `0600` file under `<app-data>/lanchat/keys/`, logging the
//! downgrade so the background service never fails to start.
//!
//! Secrets are addressed by `service = "taomni.lanchat"` + a per-key `label`.
//! Items become referenced by later phases; the module-level allow is narrowed
//! as phases 1/2/3 wire them in.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Once;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use keyring_core::{Entry, Error as KeyringError};
use zeroize::Zeroizing;

/// keyring service namespace for all LanChat machine secrets.
const SERVICE: &str = "taomni.lanchat";

/// Install the process-wide rustls crypto provider (ring) exactly once. Shared
/// with the TLS transport (phase 2) and mirrors the RDP server's installer;
/// `install_default` is global, so a second call (here or from RDP) is ignored.
pub fn ensure_crypto_provider() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Register the OS-native secret store as the keyring default, once. Best-effort:
/// on a platform with no usable secret service this fails and callers fall back
/// to the on-disk key file. `true` prefers the persistent Secret Service over the
/// volatile kernel keyutils store on Linux (the key must survive reboot).
fn ensure_keyring_store() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        if let Err(e) = keyring::use_native_store(true) {
            log::warn!("lanchat keystore: OS keychain unavailable ({e}); will use file fallback");
        }
    });
}

/// Machine-bound key store: OS keychain first, `0600` file fallback.
pub struct KeyStore {
    keys_dir: PathBuf,
}

impl KeyStore {
    /// Build a store rooted at `<app_data_dir>/lanchat/keys/` and ensure the OS
    /// keychain backend is registered.
    pub fn new(app_data_dir: &Path) -> Self {
        ensure_keyring_store();
        Self {
            keys_dir: app_data_dir.join("lanchat").join("keys"),
        }
    }

    fn file_path(&self, label: &str) -> PathBuf {
        self.keys_dir.join(label)
    }

    /// Read a secret: OS keychain first, then the on-disk fallback file.
    pub fn get(&self, label: &str) -> Option<Zeroizing<Vec<u8>>> {
        if let Ok(entry) = Entry::new(SERVICE, label) {
            match entry.get_password() {
                Ok(s) => {
                    if let Ok(bytes) = BASE64.decode(s.trim()) {
                        return Some(Zeroizing::new(bytes));
                    }
                }
                Err(KeyringError::NoEntry) => {}
                Err(e) => log::debug!("lanchat keystore: keyring get '{label}' failed: {e}"),
            }
        }
        match std::fs::read(self.file_path(label)) {
            Ok(bytes) if !bytes.is_empty() => Some(Zeroizing::new(bytes)),
            _ => None,
        }
    }

    /// Store a secret. Prefers the OS keychain and only writes the `0600` file
    /// when the keychain is unavailable, so the secret stays off disk where
    /// possible. A keychain write is verified by an immediate read-back to defend
    /// against non-persistent / mock stores.
    pub fn put(&self, label: &str, secret: &[u8]) -> Result<(), String> {
        let encoded = BASE64.encode(secret);
        if let Ok(entry) = Entry::new(SERVICE, label) {
            if entry.set_password(&encoded).is_ok()
                && matches!(entry.get_password(), Ok(s) if s == encoded)
            {
                // Drop any stale file fallback so the two backends can't diverge.
                let _ = std::fs::remove_file(self.file_path(label));
                return Ok(());
            }
        }
        self.put_file(label, secret)
    }

    fn put_file(&self, label: &str, secret: &[u8]) -> Result<(), String> {
        std::fs::create_dir_all(&self.keys_dir).map_err(|e| format!("create keystore dir: {e}"))?;
        let path = self.file_path(label);
        std::fs::write(&path, secret).map_err(|e| format!("write key file: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        log::warn!("lanchat keystore: secret '{label}' stored in file fallback (keychain unavailable)");
        Ok(())
    }

    /// Return the secret for `label`, generating + persisting a fresh `len`-byte
    /// random secret when none exists yet.
    pub fn load_or_create_random(
        &self,
        label: &str,
        len: usize,
    ) -> Result<Zeroizing<Vec<u8>>, String> {
        if let Some(existing) = self.get(label) {
            return Ok(existing);
        }
        let mut buf = Zeroizing::new(vec![0u8; len]);
        rand::fill(buf.as_mut_slice());
        self.put(label, &buf)?;
        Ok(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("lanchat-ks-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn file_fallback_round_trips_when_keychain_absent() {
        // We can't guarantee a keychain in CI; the file fallback path must work
        // regardless. Use a random label so we never collide with a real entry,
        // then assert the value survives a put -> get cycle.
        let dir = temp_dir();
        let ks = KeyStore::new(&dir);
        let label = format!("test-key-{}", uuid::Uuid::new_v4());
        let secret = b"0123456789abcdef0123456789abcdef";
        ks.put_file(&label, secret).unwrap();
        let got = ks.get(&label).expect("secret retrievable");
        assert_eq!(got.as_slice(), secret);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_or_create_is_stable_and_correct_length() {
        let dir = temp_dir();
        let ks = KeyStore::new(&dir);
        let label = format!("msgkey-{}", uuid::Uuid::new_v4());
        let a = ks.load_or_create_random(&label, 32).unwrap();
        let b = ks.load_or_create_random(&label, 32).unwrap();
        assert_eq!(a.len(), 32);
        assert_eq!(a.as_slice(), b.as_slice(), "key stable across calls");
        std::fs::remove_dir_all(&dir).ok();
    }
}
