use super::NetworkSettings;
use crate::proxy::{AppProxyConfig, ResolvedProxy, resolve_strict_with_db};
use crate::state::AppState;

/// Resolve explicit application inheritance without reading ambient OS proxies.
pub(crate) fn resolve_application(
    state: &AppState,
    network: &mut NetworkSettings,
) -> Result<(), String> {
    let config = if network.proxy_kind == "custom" {
        network
            .custom_proxy
            .clone()
            .ok_or("Independent proxy configuration is missing")?
    } else {
        AppProxyConfig::load_strict(&crate::proxy::default_app_proxy_path())?
    };
    let db = state
        .db
        .lock()
        .map_err(|_| "Proxy session database is unavailable")?;
    let proxy = resolve_strict_with_db(&config, Some(&db), Some(&state.vault))?;
    apply_resolved(network, proxy);
    Ok(())
}

fn apply_resolved(network: &mut NetworkSettings, proxy: Option<ResolvedProxy>) {
    network.proxy_session_id.clear();
    if let Some(proxy) = proxy {
        network.proxy_kind = proxy.kind;
        network.proxy_host = proxy.host;
        network.proxy_port = proxy.port;
        network.proxy_user = proxy.username;
        network.proxy_pass = proxy.password;
    } else {
        network.proxy_kind = "none".into();
        network.proxy_host.clear();
        network.proxy_user.clear();
        network.proxy_pass.clear();
        network.proxy_port = 0;
    }
}

/// OS settings are consulted only for the explicit `system` selection. Preserve
/// URL credential case (proxy_cfg's get_proxy_for_url lowercases the whole URL).
pub(crate) fn resolve_system(
    network: &NetworkSettings,
    host: &str,
) -> Result<NetworkSettings, String> {
    let config = proxy_cfg::get_proxy_config()
        .map_err(|error| format!("Could not read system proxy settings: {error}"))?;
    resolve_system_config(network, host, config.as_ref())
}

fn resolve_system_config(
    network: &NetworkSettings,
    host: &str,
    config: Option<&proxy_cfg::ProxyConfig>,
) -> Result<NetworkSettings, String> {
    let mut resolved = network.clone();
    let proxy = match config {
        Some(config) if config.use_proxy_for_address(host) && !config.whitelist.contains("*") => {
            let host = host.to_lowercase();
            if config.whitelist.iter().any(|item| {
                item.starts_with('.')
                    && (host == item.trim_start_matches('.') || host.ends_with(item))
            }) {
                None
            } else {
                ["all", "socks", "https", "http", "*"]
                    .iter()
                    .find_map(|key| config.proxies.get(*key).map(|value| (*key, value)))
                    .map(|(key, value)| {
                        if key == "socks" && !value.contains("://") {
                            parse_proxy_url(&format!("socks5://{value}"))
                        } else {
                            parse_proxy_url(value)
                        }
                    })
                    .transpose()?
            }
        }
        _ => None,
    };
    apply_resolved(&mut resolved, proxy);
    Ok(resolved)
}

fn parse_proxy_url(value: &str) -> Result<ResolvedProxy, String> {
    let value = if value.contains("://") {
        value.to_string()
    } else {
        format!("http://{value}")
    };
    let url = reqwest::Url::parse(&value).map_err(|_| "Invalid system proxy URL")?;
    let kind = match url.scheme() {
        "http" => "http",
        "socks" | "socks5" | "socks5h" => "socks5",
        _ => return Err("System proxy must use HTTP CONNECT or SOCKS5".into()),
    };
    Ok(ResolvedProxy {
        kind: kind.into(),
        host: url.host_str().ok_or("System proxy host is missing")?.into(),
        port: url.port().unwrap_or(if kind == "http" { 80 } else { 1080 }),
        username: urlencoding::decode(url.username())
            .map_err(|_| "Invalid proxy username")?
            .into_owned(),
        password: urlencoding::decode(url.password().unwrap_or(""))
            .map_err(|_| "Invalid proxy password")?
            .into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_system_proxy_preserves_credentials_and_honors_bypass() {
        let network = NetworkSettings {
            proxy_kind: "system".into(),
            ..Default::default()
        };
        let mut config = proxy_cfg::ProxyConfig::default();
        config.proxies.insert(
            "all".into(),
            "socks5://User:Pa%24Word@127.0.0.1:1088".into(),
        );
        config.whitelist.insert(".internal".into());
        let routed = resolve_system_config(&network, "public.test", Some(&config)).unwrap();
        assert_eq!(routed.proxy_kind, "socks5");
        assert_eq!(routed.proxy_pass, "Pa$Word");
        assert_eq!(routed.proxy_user, "User");
        assert_eq!(
            resolve_system_config(&network, "db.internal", Some(&config))
                .unwrap()
                .proxy_kind,
            "none"
        );
        assert_eq!(
            resolve_system_config(&network, "public.test", None)
                .unwrap()
                .proxy_kind,
            "none"
        );
    }

    #[test]
    fn invalid_configured_proxy_does_not_fall_back_to_direct() {
        let network = NetworkSettings::default();
        let mut config = proxy_cfg::ProxyConfig::default();
        config.proxies.insert("all".into(), "broken://proxy".into());
        assert!(resolve_system_config(&network, "public.test", Some(&config)).is_err());
    }
}
