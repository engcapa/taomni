use super::model::HBaseConfig;
use super::model::HBaseMode;
use super::model::HBaseSessionInner;
use super::native;
use super::rest_session::RestSession;
use super::thrift;
use std::collections::BTreeMap;
use std::time::Duration;
pub(super) fn parse_hbase_site_xml(path: &str) -> Result<BTreeMap<String, String>, String> {
    let mut content =
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read hbase-site.xml: {e}"))?;

    // Remove XML comments
    while let Some(comment_start) = content.find("<!--") {
        if let Some(comment_end) = content[comment_start..].find("-->") {
            content.replace_range(comment_start..comment_start + comment_end + 3, "");
        } else {
            break;
        }
    }

    let mut properties = BTreeMap::new();
    let re_property = regex::Regex::new(r"(?s)<property>(.*?)</property>").unwrap();
    let re_name = regex::Regex::new(r"<name>\s*([^\s<]+)\s*</name>").unwrap();
    let re_value = regex::Regex::new(r"(?s)<value>\s*(.*?)\s*</value>").unwrap();

    for cap in re_property.captures_iter(&content) {
        let block = &cap[1];
        if let Some(name_cap) = re_name.captures(block) {
            let name = name_cap[1].trim();
            if let Some(value_cap) = re_value.captures(block) {
                let value = value_cap[1].trim();
                properties.insert(name.to_string(), value.to_string());
            }
        }
    }

    Ok(properties)
}

/// Build a session for the configured transport, resolving any secrets.
pub(super) async fn build_session(
    config: &HBaseConfig,
    password: Option<String>,
) -> Result<HBaseSessionInner, String> {
    let mut resolved_config = config.clone();
    if let Some(hbase_site) = config
        .hbase_site_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let props = parse_hbase_site_xml(hbase_site)?;

        // ZK quorum
        if resolved_config.zk_quorum.is_none()
            || resolved_config
                .zk_quorum
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
        {
            if let Some(quorum) = props.get("hbase.zookeeper.quorum") {
                resolved_config.zk_quorum = Some(quorum.clone());
            }
        }

        // ZK root
        if resolved_config.zk_root.is_none()
            || resolved_config
                .zk_root
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
        {
            if let Some(root) = props.get("zookeeper.znode.parent") {
                resolved_config.zk_root = Some(root.clone());
            }
        }

        // Service principal
        if resolved_config.service_principal.is_none()
            || resolved_config
                .service_principal
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
        {
            if let Some(principal) = props
                .get("hbase.regionserver.kerberos.principal")
                .or_else(|| props.get("hbase.master.kerberos.principal"))
            {
                resolved_config.service_principal = Some(principal.clone());
            }
        }

        // Fallback host and port from ZK quorum if empty
        if resolved_config.host.trim().is_empty() {
            if let Some(quorum) = &resolved_config.zk_quorum {
                let first_zk = quorum.split(',').next().unwrap_or("").trim();
                if !first_zk.is_empty() {
                    if let Some((h, p)) = first_zk.split_once(':') {
                        resolved_config.host = h.to_string();
                        if let Ok(parsed_p) = p.parse::<u16>() {
                            resolved_config.port = parsed_p;
                        }
                    } else {
                        resolved_config.host = first_zk.to_string();
                        resolved_config.port = 2181;
                    }
                }
            }
        }
    }

    match resolved_config.mode() {
        HBaseMode::Native => {
            // If keytab + principal are configured, run kinit to refresh the
            // ticket cache before establishing the GSSAPI connection.
            if resolved_config.auth_method.as_deref().map(str::trim) == Some("kerberos") {
                try_keytab_kinit(&resolved_config)?;
            }
            Ok(HBaseSessionInner::Native(build_native_client(
                &resolved_config,
            )?))
        }
        HBaseMode::Rest => Ok(HBaseSessionInner::Rest(RestSession::new(
            &resolved_config,
            password,
        )?)),
        HBaseMode::Thrift => Ok(HBaseSessionInner::Thrift(thrift::ThriftSession::new(
            &resolved_config,
            password,
        )?)),
    }
}

/// Sets the environment variables needed for programmatic Kerberos keytab
/// authentication, avoiding the need for an external `kinit` subprocess.
pub(super) fn try_keytab_kinit(config: &HBaseConfig) -> Result<(), String> {
    if let Some(krb5_conf) = config
        .krb5_conf_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        set_kerberos_env_var("KRB5_CONFIG", krb5_conf);
    }

    let keytab = match config
        .keytab_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(k) => k,
        None => return Ok(()), // no keytab configured
    };
    let principal = config
        .principal
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Keytab auth requires a client principal (e.g. user@REALM)".to_string())?;

    // Set the client keytab path variable so MIT Kerberos/Heimdal auto-authenticates.
    set_kerberos_env_var("KRB5_CLIENT_KTNAME", keytab);

    // Isolate the ticket cache for this connection so we don't read or pollute the system cache.
    let cache_name = format!("MEMORY:taomni_hbase_{}", principal);
    set_kerberos_env_var("KRB5CCNAME", &cache_name);

    Ok(())
}

pub(super) fn set_kerberos_env_var(key: &str, value: &str) {
    // SAFETY: The current Kerberos integration is process-environment based:
    // MIT Kerberos/Heimdal read these variables when the native HBase client
    // establishes GSSAPI auth. Keep all Rust 2024 env mutation in this helper
    // until the Kerberos layer can accept per-connection configuration.
    unsafe {
        std::env::set_var(key, value);
    }
}

/// Construct the native client from the connection config.
pub(super) fn build_native_client(
    config: &HBaseConfig,
) -> Result<native::client::NativeClient, String> {
    let host = config.host.trim();
    // Native mode bootstraps via ZooKeeper, so the ZK quorum is what matters.
    // The explicit quorum (or one parsed from hbase-site.xml) wins; host:port is
    // only a single-node shorthand when no quorum is configured. host is
    // therefore optional as long as a quorum is available.
    let zk_quorum = match config.zk_quorum.as_deref().map(str::trim) {
        Some(q) if !q.is_empty() => q.to_string(),
        _ if !host.is_empty() => format!("{host}:{}", config.port),
        _ => {
            return Err(
                "HBase native mode requires a ZooKeeper quorum (set the ZK quorum \
                 field or provide an hbase-site.xml)"
                    .into(),
            );
        }
    };
    let cfg = native::client::NativeConfig {
        zk_quorum,
        zk_root: config
            .zk_root
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("/hbase")
            .to_string(),
        effective_user: config
            .effective_user
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("root")
            .to_string(),
        namespace: config.namespace.clone().filter(|s| !s.trim().is_empty()),
        timeout: Duration::from_secs(config.timeout_secs.unwrap_or(15).clamp(1, 300)),
        auth: match config.auth_method.as_deref().map(str::trim) {
            Some("kerberos") | Some("Kerberos") | Some("KERBEROS") => {
                let spn = config
                    .service_principal
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        "Kerberos auth requires a service principal (e.g. hbase/host@REALM)"
                            .to_string()
                    })?;
                let client_principal = config
                    .principal
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from);
                native::auth::AuthMethod::Kerberos {
                    service_principal: spn.to_string(),
                    client_principal,
                }
            }
            _ => native::auth::AuthMethod::Simple,
        },
    };
    Ok(native::client::NativeClient::new(cfg))
}
