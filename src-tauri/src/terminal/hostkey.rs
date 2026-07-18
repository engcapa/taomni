//! Strict SSH host-key verification and explicit trust persistence.
//!
//! Unknown keys are never trusted on first use automatically. Interactive
//! callers may inspect a fingerprint, ask the user for confirmation, and then
//! call [`HostKeyStore::confirm`]. Background callers only inspect and reject.

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use russh::keys::PublicKey;
use russh::keys::ssh_key::HashAlg;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const STORE_VERSION: u32 = 1;
const MAX_STORE_BYTES: u64 = 1024 * 1024;
const MAX_ENTRIES: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum HostKeyStatus {
    Known {
        algorithm: String,
        fingerprint: String,
    },
    Unknown {
        algorithm: String,
        fingerprint: String,
    },
    Changed {
        algorithm: String,
        expected_fingerprint: String,
        presented_fingerprint: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct KnownHostsFile {
    version: u32,
    entries: Vec<KnownHostEntry>,
}

impl Default for KnownHostsFile {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            entries: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct KnownHostEntry {
    host: String,
    port: u16,
    algorithm: String,
    public_key_base64: String,
    fingerprint: String,
    confirmed_at_unix_ms: u64,
}

#[derive(Debug)]
struct EncodedKey {
    algorithm: String,
    public_key_base64: String,
    fingerprint: String,
}

/// App-owned known-hosts store. The mutex makes inspect/confirm atomic within
/// this process; the confirmation path reloads the file after the UI prompt so
/// a stale approval cannot overwrite a key that changed in the meantime.
#[derive(Debug)]
pub struct HostKeyStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl HostKeyStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn inspect(
        &self,
        host: &str,
        port: u16,
        presented: &PublicKey,
    ) -> Result<HostKeyStatus, String> {
        let _guard = self.guard()?;
        self.inspect_unlocked(host, port, presented)
    }

    /// Persist a key only after the caller explicitly approved the exact
    /// status returned by a previous [`Self::inspect`] call.
    pub fn confirm(
        &self,
        host: &str,
        port: u16,
        presented: &PublicKey,
        approved_status: &HostKeyStatus,
    ) -> Result<HostKeyStatus, String> {
        let _guard = self.guard()?;
        let canonical_host = canonical_host(host, port)?;
        let encoded = encode_key(presented)?;
        let mut file = self.load_unlocked()?;
        let current = status_for(&file, &canonical_host, port, &encoded);

        if matches!(current, HostKeyStatus::Known { .. }) {
            return Ok(current);
        }
        if &current != approved_status {
            return Err(
                "SSH host key changed while confirmation was pending; approval was not saved"
                    .to_string(),
            );
        }

        match current {
            HostKeyStatus::Unknown { .. } => file.entries.push(KnownHostEntry {
                host: canonical_host,
                port,
                algorithm: encoded.algorithm.clone(),
                public_key_base64: encoded.public_key_base64,
                fingerprint: encoded.fingerprint.clone(),
                confirmed_at_unix_ms: unix_time_ms(),
            }),
            HostKeyStatus::Changed { .. } => {
                let entry = file
                    .entries
                    .iter_mut()
                    .find(|entry| {
                        entry.host == canonical_host
                            && entry.port == port
                            && entry.algorithm == encoded.algorithm
                    })
                    .ok_or_else(|| {
                        "known-hosts entry disappeared while replacing a changed key".to_string()
                    })?;
                entry.public_key_base64 = encoded.public_key_base64;
                entry.fingerprint = encoded.fingerprint.clone();
                entry.confirmed_at_unix_ms = unix_time_ms();
            }
            HostKeyStatus::Known { .. } => unreachable!("known keys returned above"),
        }

        file.entries.sort_by(|left, right| {
            (&left.host, left.port, &left.algorithm).cmp(&(
                &right.host,
                right.port,
                &right.algorithm,
            ))
        });
        self.write_unlocked(&file)?;
        Ok(HostKeyStatus::Known {
            algorithm: encoded.algorithm,
            fingerprint: encoded.fingerprint,
        })
    }

    fn guard(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.lock
            .lock()
            .map_err(|_| "SSH known-hosts lock is poisoned".to_string())
    }

    fn inspect_unlocked(
        &self,
        host: &str,
        port: u16,
        presented: &PublicKey,
    ) -> Result<HostKeyStatus, String> {
        let canonical_host = canonical_host(host, port)?;
        let encoded = encode_key(presented)?;
        let file = self.load_unlocked()?;
        Ok(status_for(&file, &canonical_host, port, &encoded))
    }

    fn load_unlocked(&self) -> Result<KnownHostsFile, String> {
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(KnownHostsFile::default());
            }
            Err(error) => {
                return Err(format!(
                    "read SSH known-hosts metadata at {}: {error}",
                    self.path.display()
                ));
            }
        };
        if metadata.file_type().is_symlink() {
            return Err("SSH known-hosts file must not be a symbolic link".to_string());
        }
        if !metadata.is_file() {
            return Err("SSH known-hosts path is not a regular file".to_string());
        }
        if metadata.len() > MAX_STORE_BYTES {
            return Err(format!(
                "SSH known-hosts file exceeds the {MAX_STORE_BYTES}-byte safety limit"
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o022 != 0 {
                return Err("SSH known-hosts file is writable by group or other users".to_string());
            }
        }

        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        File::open(&self.path)
            .map_err(|error| format!("open SSH known-hosts file: {error}"))?
            .take(MAX_STORE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("read SSH known-hosts file: {error}"))?;
        if bytes.len() as u64 > MAX_STORE_BYTES {
            return Err(format!(
                "SSH known-hosts file exceeds the {MAX_STORE_BYTES}-byte safety limit"
            ));
        }

        let file: KnownHostsFile = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parse SSH known-hosts file: {error}"))?;
        validate_file(&file)?;
        Ok(file)
    }

    fn write_unlocked(&self, file: &KnownHostsFile) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "SSH known-hosts path has no parent directory".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("create SSH known-hosts directory: {error}"))?;

        let mut serialized = serde_json::to_vec_pretty(file)
            .map_err(|error| format!("serialize SSH known-hosts file: {error}"))?;
        serialized.push(b'\n');
        if serialized.len() as u64 > MAX_STORE_BYTES {
            return Err("SSH known-hosts data exceeds its safety limit".to_string());
        }

        let file_name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "SSH known-hosts filename is not valid UTF-8".to_string())?;
        let temporary = parent.join(format!(
            ".{file_name}.{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let result = (|| -> Result<(), String> {
            let mut output = secure_new_file(&temporary)?;
            output
                .write_all(&serialized)
                .map_err(|error| format!("write temporary SSH known-hosts file: {error}"))?;
            output
                .sync_all()
                .map_err(|error| format!("sync temporary SSH known-hosts file: {error}"))?;
            replace_file(&temporary, &self.path)
                .map_err(|error| format!("replace SSH known-hosts file: {error}"))?;
            sync_parent_directory_best_effort(parent);
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

pub fn default_store() -> Result<&'static HostKeyStore, String> {
    static STORE: OnceLock<HostKeyStore> = OnceLock::new();
    let path = dirs::config_dir()
        .ok_or_else(|| "operating system did not provide a configuration directory".to_string())?
        .join("taomni")
        .join("ssh_known_hosts.json");
    Ok(STORE.get_or_init(|| HostKeyStore::new(path)))
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

fn status_for(
    file: &KnownHostsFile,
    host: &str,
    port: u16,
    presented: &EncodedKey,
) -> HostKeyStatus {
    match file.entries.iter().find(|entry| {
        entry.host == host && entry.port == port && entry.algorithm == presented.algorithm
    }) {
        Some(entry) if entry.public_key_base64 == presented.public_key_base64 => {
            HostKeyStatus::Known {
                algorithm: presented.algorithm.clone(),
                fingerprint: presented.fingerprint.clone(),
            }
        }
        Some(entry) => HostKeyStatus::Changed {
            algorithm: presented.algorithm.clone(),
            expected_fingerprint: entry.fingerprint.clone(),
            presented_fingerprint: presented.fingerprint.clone(),
        },
        None => HostKeyStatus::Unknown {
            algorithm: presented.algorithm.clone(),
            fingerprint: presented.fingerprint.clone(),
        },
    }
}

fn encode_key(key: &PublicKey) -> Result<EncodedKey, String> {
    let bytes = key
        .to_bytes()
        .map_err(|error| format!("encode SSH public key: {error}"))?;
    Ok(EncodedKey {
        algorithm: key.algorithm().as_str().to_string(),
        public_key_base64: BASE64.encode(bytes),
        fingerprint: fingerprint(key),
    })
}

fn validate_file(file: &KnownHostsFile) -> Result<(), String> {
    if file.version != STORE_VERSION {
        return Err(format!(
            "unsupported SSH known-hosts version {}; expected {STORE_VERSION}",
            file.version
        ));
    }
    if file.entries.len() > MAX_ENTRIES {
        return Err(format!(
            "SSH known-hosts file exceeds the {MAX_ENTRIES}-entry safety limit"
        ));
    }

    let mut unique = HashSet::with_capacity(file.entries.len());
    for entry in &file.entries {
        let canonical = canonical_host(&entry.host, entry.port)?;
        if canonical != entry.host {
            return Err(format!(
                "SSH known-hosts entry uses a non-canonical host: {}",
                entry.host
            ));
        }
        let decoded = BASE64
            .decode(&entry.public_key_base64)
            .map_err(|_| "SSH known-hosts entry contains invalid base64".to_string())?;
        let public_key = PublicKey::from_bytes(&decoded)
            .map_err(|error| format!("SSH known-hosts entry contains an invalid key: {error}"))?;
        if public_key.algorithm().as_str() != entry.algorithm {
            return Err("SSH known-hosts entry algorithm does not match its key".to_string());
        }
        if fingerprint(&public_key) != entry.fingerprint {
            return Err("SSH known-hosts entry fingerprint does not match its key".to_string());
        }
        if !unique.insert((entry.host.as_str(), entry.port, entry.algorithm.as_str())) {
            return Err("SSH known-hosts file contains a duplicate host key entry".to_string());
        }
    }
    Ok(())
}

pub(crate) fn canonical_host(host: &str, port: u16) -> Result<String, String> {
    if port == 0 {
        return Err("SSH host port must be greater than zero".to_string());
    }
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err("SSH host must not be empty".to_string());
    }
    let bracketed = trimmed.starts_with('[') || trimmed.ends_with(']');
    let raw = match (trimmed.strip_prefix('['), trimmed.strip_suffix(']')) {
        (Some(without_left), Some(_)) => &without_left[..without_left.len() - 1],
        (None, None) => trimmed,
        _ => return Err("SSH host has unbalanced IPv6 brackets".to_string()),
    };
    if raw.is_empty()
        || raw.contains('%')
        || raw.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || matches!(character, '/' | '\\' | '@' | '?' | '#')
        })
    {
        return Err("SSH host contains unsupported characters".to_string());
    }
    if let Ok(address) = raw.parse::<IpAddr>() {
        return Ok(address.to_string());
    }
    if bracketed {
        return Err("SSH brackets may only enclose an IPv6 address".to_string());
    }
    if raw.contains(':') {
        return Err("SSH host contains a port or an invalid IPv6 address".to_string());
    }

    let without_root_dot = raw.strip_suffix('.').unwrap_or(raw);
    let domain = match url::Host::parse(without_root_dot)
        .map_err(|error| format!("invalid SSH host: {error}"))?
    {
        url::Host::Domain(domain) => domain.to_ascii_lowercase(),
        url::Host::Ipv4(address) => return Ok(address.to_string()),
        url::Host::Ipv6(address) => return Ok(address.to_string()),
    };
    if domain.is_empty() || domain.len() > 253 {
        return Err("SSH host length is invalid".to_string());
    }
    for label in domain.split('.') {
        if label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("SSH host contains an invalid DNS label".to_string());
        }
    }
    Ok(domain)
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

#[cfg(unix)]
fn secure_new_file(path: &Path) -> Result<File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("create temporary SSH known-hosts file: {error}"))
}

#[cfg(not(unix))]
fn secure_new_file(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("create temporary SSH known-hosts file: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::winbase::{MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW};

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both buffers are NUL terminated and remain alive for this call.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent_directory_best_effort(parent: &Path) {
    let _ = File::open(parent).and_then(|directory| directory.sync_all());
}

#[cfg(not(unix))]
fn sync_parent_directory_best_effort(_parent: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::{Algorithm, PrivateKey};

    fn random_key() -> PublicKey {
        PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
            .expect("generate Ed25519 key")
            .public_key()
            .clone()
    }

    fn make_store(directory: &tempfile::TempDir) -> HostKeyStore {
        HostKeyStore::new(directory.path().join("ssh_known_hosts.json"))
    }

    #[test]
    fn unknown_key_is_not_written_without_confirmation() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = make_store(&directory);
        let key = random_key();

        let status = store.inspect("Example.COM.", 22, &key).expect("inspect");
        assert!(matches!(status, HostKeyStatus::Unknown { .. }));
        assert!(!store.path().exists());
    }

    #[test]
    fn explicit_confirmation_persists_and_matches_canonical_host() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = make_store(&directory);
        let key = random_key();
        let status = store
            .inspect("BÜCHER.Example.", 2222, &key)
            .expect("inspect");

        let confirmed = store
            .confirm("bücher.example", 2222, &key, &status)
            .expect("confirm");
        assert!(matches!(confirmed, HostKeyStatus::Known { .. }));
        assert_eq!(
            store.inspect("xn--bcher-kva.example", 2222, &key),
            Ok(confirmed)
        );

        let persisted = fs::read_to_string(store.path()).expect("read store");
        assert!(persisted.contains("xn--bcher-kva.example"));
        assert!(!persisted.contains("BÜCHER"));
    }

    #[test]
    fn changed_key_requires_exact_fresh_replacement_confirmation() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = make_store(&directory);
        let first = random_key();
        let second = random_key();
        let third = random_key();

        let initial = store.inspect("host.test", 22, &first).expect("inspect");
        store
            .confirm("host.test", 22, &first, &initial)
            .expect("trust first");
        let changed = store.inspect("host.test", 22, &second).expect("changed");
        assert!(matches!(changed, HostKeyStatus::Changed { .. }));

        let stale = store.confirm("host.test", 22, &third, &changed);
        assert!(stale.is_err());
        assert_eq!(
            store.inspect("host.test", 22, &first),
            Ok(HostKeyStatus::Known {
                algorithm: first.algorithm().as_str().to_string(),
                fingerprint: fingerprint(&first),
            })
        );

        store
            .confirm("host.test", 22, &second, &changed)
            .expect("replace key");
        assert!(matches!(
            store.inspect("host.test", 22, &first).expect("old key"),
            HostKeyStatus::Changed { .. }
        ));
        assert!(matches!(
            store.inspect("host.test", 22, &second).expect("new key"),
            HostKeyStatus::Known { .. }
        ));
    }

    #[test]
    fn host_and_port_are_validated_and_canonicalized() {
        assert_eq!(canonical_host("[2001:0db8::1]", 22).unwrap(), "2001:db8::1");
        assert_eq!(canonical_host("127.000.000.001", 22).unwrap(), "127.0.0.1");
        assert_eq!(
            canonical_host("BÜCHER.Example.", 22).unwrap(),
            "xn--bcher-kva.example"
        );
        assert!(canonical_host("host.test:22", 22).is_err());
        assert!(canonical_host("[host.test]", 22).is_err());
        assert!(canonical_host("host.test/path", 22).is_err());
        assert!(canonical_host("fe80::1%eth0", 22).is_err());
        assert!(canonical_host("host.test", 0).is_err());
    }

    #[test]
    fn corrupt_or_insecure_store_fails_closed() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = make_store(&directory);
        fs::write(store.path(), b"not-json").expect("write corrupt store");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(store.path(), fs::Permissions::from_mode(0o600))
                .expect("secure permissions");
        }
        let error = store
            .inspect("host.test", 22, &random_key())
            .expect_err("corruption must fail");
        assert!(error.contains("parse SSH known-hosts"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::write(store.path(), br#"{"version":1,"entries":[]}"#).expect("write valid store");
            fs::set_permissions(store.path(), fs::Permissions::from_mode(0o666))
                .expect("insecure permissions");
            let error = store
                .inspect("host.test", 22, &random_key())
                .expect_err("insecure file must fail");
            assert!(error.contains("writable by group or other users"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn persisted_store_is_owner_readable_and_writable_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("tempdir");
        let store = make_store(&directory);
        let key = random_key();
        let status = store.inspect("host.test", 22, &key).expect("inspect");
        store
            .confirm("host.test", 22, &key, &status)
            .expect("confirm");

        let mode = fs::metadata(store.path())
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
