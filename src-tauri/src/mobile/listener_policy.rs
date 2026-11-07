//! Explicit reverse-proxy authorities supplement addresses of this listener.
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct ListenerConfig {
    pub allowed_hosts: Vec<String>,
    pub allow_all_hosts: bool,
}

impl ListenerConfig {
    pub fn load(data: &Path) -> Result<Self, String> {
        match std::fs::read(data.join("mobile-listener.json")) {
            Ok(bytes) => serde_json::from_slice::<Self>(&bytes)
                .map_err(|_| "invalid_mobile_listener_config".to_owned())?
                .normalized(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err("unreadable_mobile_listener_config".into()),
        }
    }

    pub fn normalized(mut self) -> Result<Self, String> {
        if self.allowed_hosts.len() > 32 {
            return Err("too_many_mobile_hosts".into());
        }
        let mut seen = HashSet::new();
        let mut hosts = Vec::new();
        for value in self.allowed_hosts {
            let host = value.trim().to_ascii_lowercase();
            let authority = host
                .parse::<axum::http::uri::Authority>()
                .map_err(|_| "invalid_mobile_host")?;
            let suffix = &host[authority.host().len()..];
            let valid_port = suffix.is_empty()
                || suffix.strip_prefix(':').is_some_and(|port| {
                    !port.is_empty()
                        && port.bytes().all(|b| b.is_ascii_digit())
                        && port.parse::<u16>().is_ok()
                });
            if host.len() > 255
                || host.contains('@')
                || !valid_port
                || !valid_host(authority.host())
            {
                return Err("invalid_mobile_host".into());
            }
            if seen.insert(host.clone()) {
                hosts.push(host);
            }
        }
        self.allowed_hosts = hosts;
        Ok(self)
    }

    pub fn save(&self, data: &Path) -> Result<(), String> {
        let config = self.clone().normalized()?;
        std::fs::create_dir_all(data).map_err(|_| "mobile_listener_write_failed")?;
        let mut file =
            tempfile::NamedTempFile::new_in(data).map_err(|_| "mobile_listener_write_failed")?;
        serde_json::to_writer_pretty(file.as_file_mut(), &config)
            .map_err(|_| "mobile_listener_write_failed")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "mobile_listener_write_failed")?;
        file.persist(data.join("mobile-listener.json"))
            .map_err(|_| "mobile_listener_write_failed")?;
        Ok(())
    }
}

fn valid_host(host: &str) -> bool {
    if host.starts_with('[') && host.ends_with(']') {
        return host[1..host.len() - 1]
            .parse::<std::net::Ipv6Addr>()
            .is_ok();
    }
    host.strip_suffix('.')
        .unwrap_or(host)
        .split('.')
        .all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        })
}

pub struct HostPolicy {
    pub config: ListenerConfig,
    listener_hosts: HashSet<String>,
}

impl HostPolicy {
    pub fn load(data: &Path, port: u16, lan: bool) -> Result<Self, String> {
        let config = ListenerConfig::load(data)?;
        let mut listener_hosts =
            HashSet::from([format!("127.0.0.1:{port}"), format!("localhost:{port}")]);
        if lan {
            for interface in if_addrs::get_if_addrs().map_err(|_| "mobile_interface_unavailable")? {
                let ip = interface.ip();
                listener_hosts.insert(if ip.is_ipv6() {
                    format!("[{ip}]:{port}")
                } else {
                    format!("{ip}:{port}")
                });
            }
        }
        Ok(Self {
            config,
            listener_hosts,
        })
    }

    pub fn allows(&self, host: &str) -> bool {
        !host.is_empty()
            && (self.config.allow_all_hosts
                || self.listener_hosts.contains(host)
                || self
                    .config
                    .allowed_hosts
                    .iter()
                    .any(|allowed| allowed == host))
    }
}

#[cfg(test)]
#[path = "listener_policy_tests.rs"]
mod tests;
