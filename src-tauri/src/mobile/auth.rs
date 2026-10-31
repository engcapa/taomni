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
    pub fn load(&mut self, path: PathBuf) -> Result<(), String> {
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
        // Also bound arbitrary source identities; the listener never trusts X-Forwarded-For.
        if self.failures.len() >= 1024 {
            return Err("rate_limited".into());
        }
        let attempt = self
            .failures
            .entry(source.to_owned())
            .or_insert((now + Duration::from_secs(300), 0));
        if attempt.1 >= 5 {
            return Err("rate_limited".into());
        }
        attempt.1 += 1;
        if !self
            .code
            .as_ref()
            .is_some_and(|(expected, until)| *until > now && equal(expected, &hash(code)))
        {
            self.failed_attempts += 1;
            log::warn!(
                "Mobile pairing rejected: source={source}, failures={}",
                self.failed_attempts
            );
            return Err("invalid_or_expired_code".into());
        }
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
        let digest = hash(token);
        let device = self
            .devices
            .iter_mut()
            .find(|d| equal(&d.token_hash, &digest))?;
        device.last_used_at = chrono::Utc::now().timestamp();
        Some(device.device_id.clone())
    }
    pub fn paired_origin(&self, origin: &str) -> bool {
        self.devices
            .iter()
            .any(|d| d.origin.as_deref() == Some(origin))
    }
    pub fn exists(&self, id: &str) -> bool {
        !self.path.as_ref().is_some_and(|p| !p.is_file())
            && self.devices.iter().any(|d| d.device_id == id)
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
mod tests {
    use super::*;
    #[test]
    fn single_use_expiry_revocation_and_origin_bound_tickets() {
        let mut auth = Auth::default();
        let code = auth.pairing_code();
        let pair = auth
            .pair("phone", &code, Some("https://phone.example".into()), "ip")
            .unwrap();
        assert!(auth.pair("again", &code, None, "ip").is_err());
        let token = pair["token"].as_str().unwrap();
        let id = auth.authenticate(token).unwrap();
        assert!(auth.authenticate("wrong").is_none());
        assert!(
            !serde_json::to_string(&auth.devices)
                .unwrap()
                .contains(token)
        );
        let ticket = auth
            .ticket(id.clone(), Some("https://phone.example".into()))
            .unwrap();
        assert!(
            auth.consume_ticket(&ticket, Some("https://evil.example"))
                .is_none()
        );
        assert!(
            auth.consume_ticket(&ticket, Some("https://phone.example"))
                .is_none()
        );
        let ticket = auth.ticket(id.clone(), None).unwrap();
        assert_eq!(auth.consume_ticket(&ticket, None), Some(id.clone()));
        assert!(auth.consume_ticket(&ticket, None).is_none());
        auth.revoke(&id).unwrap();
        assert!(auth.authenticate(token).is_none());
        assert!(!auth.paired_origin("https://phone.example"));
        let code = auth.pairing_code();
        auth.code.as_mut().unwrap().1 = Instant::now() - Duration::from_secs(1);
        assert!(auth.pair("expired", &code, None, "ip2").is_err());
        for _ in 0..5 {
            let _ = auth.pair("bad", "bad", None, "bad-ip");
        }
        assert_eq!(
            auth.pair("bad", "bad", None, "bad-ip").unwrap_err(),
            "rate_limited"
        );
    }
    #[test]
    fn persistence_contains_only_hashes_and_deletion_revokes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mobile-devices.json");
        let mut a = Auth::default();
        a.load(path.clone()).unwrap();
        let code = a.pairing_code();
        let pair = a.pair("phone", &code, None, "ip").unwrap();
        let token = pair["token"].as_str().unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains(token));
        let mut b = Auth::default();
        b.load(path.clone()).unwrap();
        assert!(b.authenticate(token).is_some());
        std::fs::remove_file(&path).unwrap();
        // Shutdown must never resurrect a deleted device store.
        b.flush().unwrap();
        b.load(path).unwrap();
        assert!(b.authenticate(token).is_none());
    }
}
