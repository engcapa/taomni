//! SSH host-key verification for Sockscap SSH-jump egress (plan §4.3-8,
//! §16.5-19, §15 risk table).
//!
//! The app's shared SSH handler (`terminal/ssh.rs::check_server_key`) currently
//! accepts *any* server key unconditionally — a documented release blocker for
//! SSH egress. Sockscap must not inherit that. This module provides a
//! trust-on-first-use host-key store: an offered key is `Verified` when it
//! matches a stored key, `Changed` (⇒ hard block + MITM alarm) when the host is
//! known but the key differs, and `Unknown` (⇒ first-use confirmation) when the
//! host is new. It maintains its OWN known_hosts file so it never mutates the
//! user's `~/.ssh/known_hosts`.

use std::path::{Path, PathBuf};

use russh::keys::PublicKey;
use russh::keys::ssh_key::HashAlg;

use super::SockscapError;

/// The outcome of checking an offered server key against the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyVerdict {
    /// Offered key matches a stored key for this host.
    Verified,
    /// Host is known but the offered key differs — treat as a MITM alarm and
    /// block; require explicit human re-confirmation (plan §16.5-19).
    Changed {
        known_fingerprints: Vec<String>,
        offered_fingerprint: String,
    },
    /// Host not seen before — first-use confirmation required.
    Unknown { offered_fingerprint: String },
}

impl HostKeyVerdict {
    /// Whether a connect may proceed without human interaction. Only `Verified`
    /// is auto-approvable; `Unknown` needs first-use confirmation and `Changed`
    /// is always blocked.
    pub fn is_trusted(&self) -> bool {
        matches!(self, HostKeyVerdict::Verified)
    }
}

/// One stored host → key association.
#[derive(Debug, Clone)]
struct HostKeyEntry {
    host_key: String,
    key: PublicKey,
}

/// A Sockscap-owned known_hosts store. Backed by an optional file; construct
/// with [`HostKeyStore::in_memory`] for tests.
pub struct HostKeyStore {
    path: Option<PathBuf>,
    entries: Vec<HostKeyEntry>,
}

/// The canonical known_hosts host token: bare hostname on port 22, else
/// `[host]:port` (OpenSSH convention).
pub fn host_token(host: &str, port: u16) -> String {
    let host = host.trim().to_ascii_lowercase();
    if port == 22 {
        host
    } else {
        format!("[{host}]:{port}")
    }
}

/// OpenSSH-style SHA-256 fingerprint (`SHA256:…`) of a public key.
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

impl HostKeyStore {
    /// A store with no backing file (tests, ephemeral use).
    pub fn in_memory() -> HostKeyStore {
        HostKeyStore {
            path: None,
            entries: Vec::new(),
        }
    }

    /// Load a store from `path`, creating an empty one if the file is absent.
    pub fn load(path: impl AsRef<Path>) -> Result<HostKeyStore, SockscapError> {
        let path = path.as_ref().to_path_buf();
        let mut store = HostKeyStore {
            path: Some(path.clone()),
            entries: Vec::new(),
        };
        if path.exists() {
            let text = std::fs::read_to_string(&path)
                .map_err(|e| SockscapError::Invalid(format!("read known_hosts: {e}")))?;
            store.parse_into(&text);
        }
        Ok(store)
    }

    fn parse_into(&mut self, text: &str) {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((host, rest)) = line.split_once(char::is_whitespace) else {
                continue;
            };
            match PublicKey::from_openssh(rest.trim()) {
                Ok(key) => self.entries.push(HostKeyEntry {
                    host_key: host.to_string(),
                    key,
                }),
                Err(e) => tracing::warn!("sockscap: skipping bad known_hosts line: {e}"),
            }
        }
    }

    /// Check an offered key for `host:port`.
    pub fn verify(&self, host: &str, port: u16, offered: &PublicKey) -> HostKeyVerdict {
        let token = host_token(host, port);
        let known: Vec<&HostKeyEntry> =
            self.entries.iter().filter(|e| e.host_key == token).collect();
        if known.is_empty() {
            return HostKeyVerdict::Unknown {
                offered_fingerprint: fingerprint(offered),
            };
        }
        if known.iter().any(|e| &e.key == offered) {
            return HostKeyVerdict::Verified;
        }
        HostKeyVerdict::Changed {
            known_fingerprints: known.iter().map(|e| fingerprint(&e.key)).collect(),
            offered_fingerprint: fingerprint(offered),
        }
    }

    /// Trust a key for `host:port` (first-use confirmation or an explicit
    /// re-confirmation after a change). Persists to the backing file if any.
    pub fn trust(&mut self, host: &str, port: u16, key: PublicKey) -> Result<(), SockscapError> {
        let token = host_token(host, port);
        // Replace any existing entries for this host so a re-confirmed change
        // doesn't leave the stale key behind.
        self.entries.retain(|e| e.host_key != token);
        self.entries.push(HostKeyEntry {
            host_key: token,
            key,
        });
        self.persist()
    }

    fn persist(&self) -> Result<(), SockscapError> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let mut out = String::new();
        for e in &self.entries {
            let line = e
                .key
                .to_openssh()
                .map_err(|err| SockscapError::Invalid(format!("encode key: {err}")))?;
            out.push_str(&format!("{} {}\n", e.host_key, line));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(path, out)
            .map_err(|e| SockscapError::Invalid(format!("write known_hosts: {e}")))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::public::{Ed25519PublicKey, KeyData};

    /// Build a valid ed25519 public key from a fixed seed (no RNG needed — we
    /// only exercise storage/compare/fingerprint, not signature verification).
    fn key(seed: u8) -> PublicKey {
        PublicKey::new(KeyData::Ed25519(Ed25519PublicKey([seed; 32])), "test")
    }

    #[test]
    fn host_token_formats_nonstandard_port() {
        assert_eq!(host_token("Example.COM", 22), "example.com");
        assert_eq!(host_token("example.com", 2222), "[example.com]:2222");
    }

    #[test]
    fn unknown_host_is_first_use() {
        let store = HostKeyStore::in_memory();
        let v = store.verify("jump.example", 22, &key(1));
        assert!(matches!(v, HostKeyVerdict::Unknown { .. }));
        assert!(!v.is_trusted());
    }

    #[test]
    fn trusted_key_verifies() {
        let mut store = HostKeyStore::in_memory();
        store.trust("jump.example", 22, key(1)).unwrap();
        assert!(store.verify("jump.example", 22, &key(1)).is_trusted());
    }

    #[test]
    fn changed_key_is_blocked_with_fingerprints() {
        let mut store = HostKeyStore::in_memory();
        store.trust("jump.example", 22, key(1)).unwrap();
        match store.verify("jump.example", 22, &key(2)) {
            HostKeyVerdict::Changed {
                known_fingerprints,
                offered_fingerprint,
            } => {
                assert_eq!(known_fingerprints.len(), 1);
                assert!(known_fingerprints[0].starts_with("SHA256:"));
                assert_ne!(known_fingerprints[0], offered_fingerprint);
            }
            other => panic!("expected Changed, got {other:?}"),
        }
    }

    #[test]
    fn reconfirming_change_replaces_old_key() {
        let mut store = HostKeyStore::in_memory();
        store.trust("h", 22, key(1)).unwrap();
        store.trust("h", 22, key(2)).unwrap(); // re-confirm the new key
        assert_eq!(store.len(), 1);
        assert!(store.verify("h", 22, &key(2)).is_trusted());
        assert!(!store.verify("h", 22, &key(1)).is_trusted());
    }

    #[test]
    fn file_store_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sockscap_known_hosts");
        {
            let mut store = HostKeyStore::load(&path).unwrap();
            store.trust("jump.example", 2222, key(7)).unwrap();
        }
        let reloaded = HostKeyStore::load(&path).unwrap();
        assert_eq!(reloaded.len(), 1);
        assert!(reloaded.verify("jump.example", 2222, &key(7)).is_trusted());
        assert!(matches!(
            reloaded.verify("jump.example", 22, &key(7)),
            HostKeyVerdict::Unknown { .. }
        ));
    }
}
