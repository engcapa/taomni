//! Pairing secrets never enter logs or the persisted device file.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
pub struct Device {
    pub device_id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub origin: Option<String>,
    pub created_at: i64,
    pub last_used_at: i64,
    pub token_hash: String,
}

const TOKEN_LIFETIME: i64 = 90 * 86400;
const TOKEN_IDLE: i64 = 30 * 86400;
fn valid(device: &Device, now: i64) -> bool {
    now < device.created_at.saturating_add(TOKEN_LIFETIME)
        && now < device.last_used_at.saturating_add(TOKEN_IDLE)
}
pub struct Auth {
    path: Option<PathBuf>,
    pub devices: Vec<Device>,
    code: Option<(String, Instant)>,
    failures: HashMap<String, (Instant, u32)>,
    pub failed_attempts: u64,
    tickets: HashMap<String, (String, Option<String>, Instant)>,
}

pub fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
// Both operands are SHA-256 hex digests, always the same length. No early exit.
fn equal(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}
impl Default for Auth {
    fn default() -> Self {
        Self {
            path: None,
            devices: vec![],
            code: None,
            failures: HashMap::new(),
            failed_attempts: 0,
            tickets: HashMap::new(),
        }
    }
}
impl Auth {
    pub fn clear_ephemeral(&mut self) {
        self.code = None;
        self.tickets.clear();
    }
    pub fn load(&mut self, path: PathBuf) -> Result<(), String> {
        self.clear_ephemeral();
        self.devices = match std::fs::read(&path) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|_| "Invalid mobile device store")?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(_) => return Err("Cannot read mobile device store".into()),
        };
        self.path = Some(path);
        Ok(())
    }
    fn save(&self) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let dir = path.parent().ok_or("Invalid device store path")?;
        std::fs::create_dir_all(dir).map_err(|_| "Cannot create device store")?;
        let mut file =
            tempfile::NamedTempFile::new_in(dir).map_err(|_| "Cannot write device store")?;
        serde_json::to_writer(file.as_file_mut(), &self.devices)
            .map_err(|_| "Cannot write device store")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "Cannot sync device store")?;
        file.persist(path)
            .map_err(|_| "Cannot publish device store")?;
        Ok(())
    }
    fn synchronize_revocation(&mut self) {
        if self.path.as_ref().is_some_and(|p| !p.is_file()) {
            self.devices.clear();
            self.tickets.clear();
        }
    }
    pub fn pairing_code(&mut self) -> String {
        let code = Uuid::new_v4().simple().to_string(); // 122 random bits, 5 minutes
        self.code = Some((hash(&code), Instant::now() + Duration::from_secs(300)));
        code
    }
    pub fn pair(
        &mut self,
        label: &str,
        code: &str,
        origin: Option<String>,
        source: &str,
    ) -> Result<serde_json::Value, String> {
        self.synchronize_revocation();
        let now = Instant::now();
        self.failures.retain(|_, (until, _)| *until > now);
        let correct = self
            .code
            .as_ref()
            .is_some_and(|(expected, until)| *until > now && equal(expected, &hash(code)));
        // A reverse proxy is an untrusted shared source. Still throttle invalid
        // attempts, but never let that shared bucket deny a valid 122-bit code.
        let shared = source
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
        if self.failures.get(source).is_some_and(|(_, n)| *n >= 5) && !(shared && correct) {
            return Err("rate_limited".into());
        }
        if !correct {
            if !self.failures.contains_key(source) && self.failures.len() >= 1024 {
                let oldest = self
                    .failures
                    .iter()
                    .min_by_key(|(_, (until, _))| *until)
                    .map(|(key, _)| key.clone());
                if let Some(key) = oldest {
                    self.failures.remove(&key);
                }
            }
            self.failures
                .entry(source.to_owned())
                .or_insert((now + Duration::from_secs(300), 0))
                .1 += 1;
            self.failed_attempts += 1;
            log::warn!(
                "Mobile pairing rejected: source={source}, failures={}",
                self.failed_attempts
            );
            return Err("invalid_or_expired_code".into());
        }
        self.devices
            .retain(|device| valid(device, chrono::Utc::now().timestamp()));
        if self.devices.len() >= 256 {
            return Err("device_limit".into());
        }
        let token = secret();
        let device = Device {
            device_id: Uuid::new_v4().to_string(),
            label: label.chars().take(80).collect(),
            origin,
            created_at: chrono::Utc::now().timestamp(),
            last_used_at: chrono::Utc::now().timestamp(),
            token_hash: hash(&token),
        };
        let device_id = device.device_id.clone();
        self.devices.push(device);
        if let Err(e) = self.save() {
            self.devices.pop();
            return Err(e);
        }
        self.code = None;
        Ok(serde_json::json!({ "device_id": device_id, "token": token }))
    }
    pub fn authenticate(&mut self, token: &str) -> Option<String> {
        if self.path.as_ref().is_some_and(|p| !p.is_file()) {
            self.devices.clear();
            self.tickets.clear();
            return None;
        }
        let now = chrono::Utc::now().timestamp();
        let digest = hash(token);
        let device = self
            .devices
            .iter_mut()
            .find(|d| valid(d, now) && equal(&d.token_hash, &digest))?;
        let checkpoint = now - device.last_used_at >= 300;
        device.last_used_at = now;
        let id = device.device_id.clone();
        if checkpoint && self.save().is_err() {
            return None;
        }
        Some(id)
    }
    pub fn paired_origin(&self, origin: &str) -> bool {
        self.devices.iter().any(|d| {
            valid(d, chrono::Utc::now().timestamp()) && d.origin.as_deref() == Some(origin)
        })
    }
    pub fn exists(&self, id: &str) -> bool {
        !self.path.as_ref().is_some_and(|p| !p.is_file())
            && self
                .devices
                .iter()
                .any(|d| d.device_id == id && valid(d, chrono::Utc::now().timestamp()))
    }
    pub fn revoke(&mut self, id: &str) -> Result<(), String> {
        self.synchronize_revocation();
        let previous = self.devices.clone();
        self.devices.retain(|d| d.device_id != id);
        if let Err(e) = self.save() {
            self.devices = previous;
            return Err(e);
        }
        self.tickets.retain(|_, (d, _, _)| d != id);
        Ok(())
    }
    pub fn ticket(&mut self, device: String, origin: Option<String>) -> Result<String, String> {
        self.tickets
            .retain(|_, (_, _, until)| *until > Instant::now());
        if self.tickets.len() >= 1024 {
            return Err("rate_limited".into());
        }
        let ticket = secret();
        self.tickets.insert(
            hash(&ticket),
            (device, origin, Instant::now() + Duration::from_secs(60)),
        );
        Ok(ticket)
    }
    pub fn consume_ticket(&mut self, ticket: &str, origin: Option<&str>) -> Option<String> {
        let (device, expected_origin, until) = self.tickets.remove(&hash(ticket))?;
        (until > Instant::now() && expected_origin.as_deref() == origin && self.exists(&device))
            .then_some(device)
    }
    pub fn flush(&mut self) -> Result<(), String> {
        self.synchronize_revocation();
        self.save()
    }
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
