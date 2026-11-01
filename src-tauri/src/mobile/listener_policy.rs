//! Explicit reverse-proxy authorities supplement addresses of this listener.
use serde::Deserialize;
use std::{collections::HashSet, path::Path};
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Config {
    allowed_hosts: Vec<String>,
}
pub fn hosts(data: &Path, port: u16, lan: bool) -> Result<HashSet<String>, String> {
    let config: Config = match std::fs::read(data.join("mobile-listener.json")) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "invalid_mobile_listener_config")?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config::default(),
        Err(_) => return Err("unreadable_mobile_listener_config".into()),
    };
    let mut hosts = HashSet::from([format!("127.0.0.1:{port}"), format!("localhost:{port}")]);
    if lan {
        for interface in if_addrs::get_if_addrs().map_err(|_| "mobile_interface_unavailable")? {
            let ip = interface.ip();
            hosts.insert(if ip.is_ipv6() {
                format!("[{ip}]:{port}")
            } else {
                format!("{ip}:{port}")
            });
        }
    }
    if config.allowed_hosts.len() > 32 {
        return Err("too_many_mobile_hosts".into());
    }
    for host in config.allowed_hosts {
        let authority = host
            .parse::<axum::http::uri::Authority>()
            .map_err(|_| "invalid_mobile_host")?;
        if authority.as_str().contains('@') || host.len() > 255 {
            return Err("invalid_mobile_host".into());
        }
        hosts.insert(host.to_ascii_lowercase());
    }
    Ok(hosts)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn custom_proxy_host_is_explicit_and_unknown_fields_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            !hosts(dir.path(), 8787, false)
                .unwrap()
                .contains("evil.example:8787")
        );
        std::fs::write(
            dir.path().join("mobile-listener.json"),
            r#"{"allowed_hosts":["pc.example.com"]}"#,
        )
        .unwrap();
        assert!(
            hosts(dir.path(), 8787, false)
                .unwrap()
                .contains("pc.example.com")
        );
        std::fs::write(dir.path().join("mobile-listener.json"), r#"{"typo":true}"#).unwrap();
        assert!(hosts(dir.path(), 8787, false).is_err());
    }
}
