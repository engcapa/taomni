//! SSH host-key verification (known_hosts).
//!
//! Design plan §4.3 / §16.5 #19: known_hosts / fingerprint confirmation is a
//! release gate. Host key change must block; first trust is TOFU by default
//! (interactive UI confirmation can wrap [`HostKeyPolicy::TrustOnFirstUse`]
//! later by pre-checking and prompting before connect).

use russh::keys::ssh_key::{HashAlg, PublicKey};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// How to treat unknown and changed host keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyPolicy {
    /// Accept and persist unknown keys; reject changed keys.
    TrustOnFirstUse,
    /// Reject unknown and changed keys (for non-interactive / Sockscap auto).
    Strict,
}

impl Default for HostKeyPolicy {
    fn default() -> Self {
        Self::TrustOnFirstUse
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyDecision {
    AcceptedKnown,
    AcceptedNew { fingerprint: String },
    RejectedMismatch { expected: String, presented: String },
    RejectedUnknown { fingerprint: String },
}

/// Thread-safe known_hosts store (OpenSSH-ish one line per host:port).
#[derive(Debug)]
pub struct KnownHosts {
    path: PathBuf,
    lock: Mutex<()>,
}

impl KnownHosts {
    pub fn open(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
        }
    }

    pub fn default_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("taomni")
            .join("ssh_known_hosts")
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// SHA256 fingerprint in OpenSSH `SHA256:…` form.
    pub fn fingerprint(key: &PublicKey) -> String {
        key.fingerprint(HashAlg::Sha256).to_string()
    }

    /// Stable line body for the key (algo + base64), independent of comment.
    pub fn key_blob(key: &PublicKey) -> Result<String, String> {
        // PublicKey Display/ToString is OpenSSH single-line form.
        let line = key.to_string();
        let mut parts = line.split_whitespace();
        let algo = parts
            .next()
            .ok_or_else(|| "empty public key encoding".to_string())?;
        let b64 = parts
            .next()
            .ok_or_else(|| "public key missing base64 body".to_string())?;
        Ok(format!("{algo} {b64}"))
    }

    fn host_port_key(host: &str, port: u16) -> String {
        let host = host.trim().to_ascii_lowercase();
        format!("{host}:{port}")
    }

    pub fn lookup_blob(&self, host: &str, port: u16) -> Option<String> {
        let _g = self.lock.lock().ok()?;
        let raw = fs::read_to_string(&self.path).ok()?;
        let needle = Self::host_port_key(host, port);
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut parts = line.splitn(2, ' ');
            let hp = parts.next()?;
            let rest = parts.next()?.trim();
            if hp.eq_ignore_ascii_case(&needle) {
                return Some(rest.to_string());
            }
        }
        None
    }

    pub fn store(&self, host: &str, port: u16, key: &PublicKey) -> Result<(), String> {
        let _g = self
            .lock
            .lock()
            .map_err(|_| "known_hosts lock poisoned".to_string())?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create known_hosts dir: {e}"))?;
        }
        let blob = Self::key_blob(key)?;
        let entry_host = Self::host_port_key(host, port);
        let mut kept = Vec::new();
        if let Ok(raw) = fs::read_to_string(&self.path) {
            for line in raw.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    kept.push(line.to_string());
                    continue;
                }
                let hp = trimmed.split(' ').next().unwrap_or("");
                if !hp.eq_ignore_ascii_case(&entry_host) {
                    kept.push(line.to_string());
                }
            }
        }
        kept.push(format!("{entry_host} {blob}"));
        let mut tmp = self.path.clone();
        tmp.set_extension("tmp");
        {
            let mut f = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&tmp)
                .map_err(|e| format!("write known_hosts tmp: {e}"))?;
            for line in &kept {
                writeln!(f, "{line}").map_err(|e| format!("write known_hosts: {e}"))?;
            }
            f.sync_all().ok();
        }
        fs::rename(&tmp, &self.path).map_err(|e| format!("rename known_hosts: {e}"))?;
        Ok(())
    }

    pub fn verify(
        &self,
        host: &str,
        port: u16,
        presented: &PublicKey,
        policy: HostKeyPolicy,
    ) -> Result<HostKeyDecision, String> {
        let presented_blob = Self::key_blob(presented)?;
        let fp = Self::fingerprint(presented);
        match self.lookup_blob(host, port) {
            Some(known) if known == presented_blob => Ok(HostKeyDecision::AcceptedKnown),
            Some(known) => Ok(HostKeyDecision::RejectedMismatch {
                expected: known,
                presented: format!("{fp} ({presented_blob})"),
            }),
            None => match policy {
                HostKeyPolicy::TrustOnFirstUse => {
                    self.store(host, port, presented)?;
                    Ok(HostKeyDecision::AcceptedNew { fingerprint: fp })
                }
                HostKeyPolicy::Strict => Ok(HostKeyDecision::RejectedUnknown { fingerprint: fp }),
            },
        }
    }
}

/// Process-wide default store (config dir). Lazily opened.
pub fn default_store() -> &'static KnownHosts {
    use std::sync::OnceLock;
    static STORE: OnceLock<KnownHosts> = OnceLock::new();
    STORE.get_or_init(|| KnownHosts::open(KnownHosts::default_path()))
}

/// True when host-key verification is considered production-ready for Sockscap.
pub fn verification_ready() -> bool {
    // After this module lands, Sockscap may enable SSH Jump.
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::{PrivateKey, PublicKey as _};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_store() -> KnownHosts {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("taomni-known-hosts-{n}"));
        KnownHosts::open(path)
    }

    fn random_pubkey() -> PublicKey {
        let sk = PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
            .expect("gen key");
        sk.public_key().clone()
    }

    #[test]
    fn tofu_accepts_and_persists() {
        let store = tmp_store();
        let key = random_pubkey();
        let d = store
            .verify("example.com", 22, &key, HostKeyPolicy::TrustOnFirstUse)
            .unwrap();
        assert!(matches!(d, HostKeyDecision::AcceptedNew { .. }));
        let d2 = store
            .verify("example.com", 22, &key, HostKeyPolicy::Strict)
            .unwrap();
        assert_eq!(d2, HostKeyDecision::AcceptedKnown);
        let _ = fs::remove_file(store.path());
    }

    #[test]
    fn mismatch_is_rejected() {
        let store = tmp_store();
        let k1 = random_pubkey();
        let k2 = random_pubkey();
        store
            .verify("h", 22, &k1, HostKeyPolicy::TrustOnFirstUse)
            .unwrap();
        let d = store
            .verify("h", 22, &k2, HostKeyPolicy::TrustOnFirstUse)
            .unwrap();
        assert!(matches!(d, HostKeyDecision::RejectedMismatch { .. }));
        let _ = fs::remove_file(store.path());
    }

    #[test]
    fn strict_rejects_unknown() {
        let store = tmp_store();
        let key = random_pubkey();
        let d = store
            .verify("new.example", 22, &key, HostKeyPolicy::Strict)
            .unwrap();
        assert!(matches!(d, HostKeyDecision::RejectedUnknown { .. }));
        let _ = fs::remove_file(store.path());
    }
}
