use super::*;

/// Extract the `passwordRef` a saved Proxy / SSH session keeps in its
/// `options_json`. `SessionConfig` has no password column of its own — the
/// secret is stored as a `vault:<id>` reference under `options_json.passwordRef`
/// (see `terminal::resolve_proxy_session`). Returns `None` when absent/blank.
pub(super) fn session_password_ref(options_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(options_json)
        .ok()
        .and_then(|v| {
            v.get("passwordRef")
                .and_then(|r| r.as_str())
                .map(str::to_string)
        })
        .filter(|s| !s.trim().is_empty())
}

/// Resolve a saved session's stored proxy/SSH password to plaintext.
///
/// Mirrors `NetworkSettings::resolve_proxy_pass`: a `vault:<id>` reference is
/// decrypted through the vault; a non-reference value is treated as a literal
/// password (backwards compat). Returns `None` when the session carries no
/// `passwordRef` — callers then keep any password already resolved from the
/// upstream's own `password_ref`. Vault errors (e.g. locked) are swallowed to
/// match the sibling `password_ref` resolution and the UI's unlock gate.
pub(super) fn session_proxy_password(
    vault: &crate::vault::Vault,
    session: &crate::session::models::SessionConfig,
) -> Option<String> {
    let pass_ref = session_password_ref(&session.options_json)?;
    match vault.resolve(&pass_ref) {
        Ok(Some(plain)) => Some((*plain).clone()),
        Ok(None) => Some(pass_ref),
        Err(_) => None,
    }
}

/// Resolve the SSH auth to use for a saved SSH session bound as an upstream.
///
/// PrivateKey sessions store a key **file path** in `auth_method` (a DB column),
/// while Password sessions keep the secret as a `vault:<id>` reference in
/// `options_json.passwordRef`. Mirrors `terminal::create_ssh_terminal` /
/// `terminal::resolve_jump_credentials`; without this a key-based SSH upstream
/// would silently fall through to the agent. Falls back to the SSH agent when
/// neither a key path nor a password is available.
pub(super) fn session_ssh_auth(
    vault: &crate::vault::Vault,
    session: &crate::session::models::SessionConfig,
) -> crate::terminal::ssh::SshAuth {
    use crate::session::models::AuthMethod;
    use crate::terminal::ssh::SshAuth;
    match &session.auth_method {
        AuthMethod::PrivateKey { key_path } if !key_path.trim().is_empty() => {
            SshAuth::PrivateKey(key_path.clone())
        }
        AuthMethod::Agent => SshAuth::Agent,
        // Password / None / keyless PrivateKey: use the stored password if any.
        _ => match session_proxy_password(vault, session) {
            Some(pass) if !pass.is_empty() => SshAuth::Password(pass),
            _ => SshAuth::Agent,
        },
    }
}

/// Resolve a `vault:<id>` reference to plaintext, treating a non-reference value
/// as a literal (backwards compat, matching [`session_proxy_password`]). Blank
/// refs and vault errors (e.g. locked) yield an empty string.
pub(super) fn resolve_secret_ref(vault: &crate::vault::Vault, reference: &str) -> String {
    let reference = reference.trim();
    if reference.is_empty() {
        return String::new();
    }
    match vault.resolve(reference) {
        Ok(Some(plain)) => (*plain).clone(),
        Ok(None) => reference.to_string(),
        Err(_) => String::new(),
    }
}

/// Build a [`core::ResolvedCoreUpstream`] for a core-backed upstream, decrypting
/// every `vault:<id>` secret to plaintext for the (short-lived) xray config.
/// `host`/`port` are the node address the xray outbound dials.
pub(super) fn build_core_spec(
    vault: &crate::vault::Vault,
    kind: config::UpstreamKind,
    host: String,
    port: u16,
    up: &config::UpstreamRef,
) -> core::ResolvedCoreUpstream {
    core::ResolvedCoreUpstream {
        kind,
        host,
        port,
        secret: resolve_secret_ref(vault, &up.password_ref),
        uuid: resolve_secret_ref(vault, &up.params.uuid_ref),
        private_key: resolve_secret_ref(vault, &up.params.private_key_ref),
        pre_shared_key: resolve_secret_ref(vault, &up.params.pre_shared_key_ref),
        params: up.params.clone(),
    }
}

/// Ensure a core is running for a core-backed upstream and return its local
/// SOCKS port. Non-core kinds return None immediately. Failures are logged and
/// return None (the relay then emits a clear per-flow error) so one bad profile
/// does not abort the whole capture start — mirrors the per-profile SSH policy.
pub(super) async fn ensure_core_port(
    state: &State<'_, AppState>,
    profile_key: &str,
    kind: config::UpstreamKind,
    host: &str,
    port: u16,
    up: &config::UpstreamRef,
) -> Option<u16> {
    if !kind.requires_core() {
        return None;
    }
    let mgr = state.sockscap.xray()?;
    let spec = build_core_spec(&state.vault, kind, host.to_string(), port, up);
    match mgr.ensure(profile_key, &spec).await {
        Ok(local_port) => Some(local_port),
        Err(e) => {
            tracing::warn!(
                "sockscap: xray core for '{profile_key}' ({}) failed: {e}",
                kind.as_tag()
            );
            None
        }
    }
}

/// Resolve upstreams (including vault secrets, session-backed hosts, and SSH
/// pools) into a relay context. Shared by the Unix capture backends.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) async fn build_unix_relay_context(
    state: &State<'_, AppState>,
    cfg: &SocksCapConfig,
) -> Result<Arc<RwLock<relay::RelayContext>>, String> {
    let (mut upstream_host, mut upstream_port, mut upstream_user, mut upstream_pass) =
        relay::upstream_from_config(cfg);
    if !cfg.upstream.password_ref.is_empty() {
        if let Ok(Some(password)) = state.vault.resolve(&cfg.upstream.password_ref) {
            upstream_pass = (*password).clone();
        }
    }
    let mut upstream_session: Option<crate::session::models::SessionConfig> = None;
    if !cfg.upstream.session_id.is_empty() {
        let session = {
            let db = state.db.lock().ok();
            db.and_then(|db| crate::session::db::get_session(&db, &cfg.upstream.session_id).ok())
        };
        if let Some(session) = session {
            upstream_host = session.host.clone();
            upstream_port = session.port;
            if let Some(username) = session.username.clone().filter(|u| !u.is_empty()) {
                upstream_user = username;
            }
            // Session credentials live in the vault, not the upstream's own
            // `password_ref`; without this a session-backed SOCKS5/HTTP proxy
            // that needs auth would dial with an empty password.
            if let Some(pass) = session_proxy_password(&state.vault, &session) {
                upstream_pass = pass;
            }
            upstream_session = Some(session);
        }
    }

    let ssh_pool = if matches!(cfg.upstream.kind, config::UpstreamKind::Ssh) {
        use crate::sockscap::egress::ssh_pool::SshPool;
        use crate::terminal::ssh::SshAuth;

        // A bound SSH session carries its own auth (key path in `auth_method`,
        // or a vault password); manual upstreams fall back to the old rules.
        let auth = if let Some(sess) = &upstream_session {
            session_ssh_auth(&state.vault, sess)
        } else if !upstream_pass.is_empty() {
            SshAuth::Password(upstream_pass.clone())
        } else if cfg.upstream.password_ref.starts_with("key:") {
            SshAuth::PrivateKey(cfg.upstream.password_ref.clone())
        } else {
            SshAuth::Agent
        };
        Some(Arc::new(
            SshPool::connect(&upstream_host, upstream_port, &upstream_user, auth)
                .await
                .map_err(|error| format!("SSH upstream connect failed: {error}"))?,
        ))
    } else {
        None
    };

    let mut profile_upstreams = std::collections::HashMap::new();
    for profile in cfg.active_profiles() {
        let (mut host, mut port, mut user, mut password) =
            relay::upstream_from_config_ref(&profile.upstream);
        let mut profile_session: Option<crate::session::models::SessionConfig> = None;
        if host.is_empty() {
            host = upstream_host.clone();
            port = upstream_port;
            user = upstream_user.clone();
            password = upstream_pass.clone();
            // Inherit the global upstream's SSH auth (e.g. key-based session).
            profile_session = upstream_session.clone();
        } else {
            if !profile.upstream.password_ref.is_empty() {
                if let Ok(Some(resolved)) = state.vault.resolve(&profile.upstream.password_ref) {
                    password = (*resolved).clone();
                }
            }
            if !profile.upstream.session_id.is_empty() {
                let session = {
                    let db = state.db.lock().ok();
                    db.and_then(|db| {
                        crate::session::db::get_session(&db, &profile.upstream.session_id).ok()
                    })
                };
                if let Some(session) = session {
                    host = session.host.clone();
                    port = session.port;
                    if let Some(username) = session.username.clone().filter(|u| !u.is_empty()) {
                        user = username;
                    }
                    if let Some(pass) = session_proxy_password(&state.vault, &session) {
                        password = pass;
                    }
                    profile_session = Some(session);
                }
            }
        }
        let profile_ssh_pool = if matches!(profile.upstream.kind, config::UpstreamKind::Ssh) {
            use crate::sockscap::egress::ssh_pool::SshPool;
            use crate::terminal::ssh::SshAuth;

            let auth = if let Some(sess) = &profile_session {
                session_ssh_auth(&state.vault, sess)
            } else if !password.is_empty() {
                SshAuth::Password(password.clone())
            } else if profile.upstream.password_ref.starts_with("key:") {
                SshAuth::PrivateKey(profile.upstream.password_ref.clone())
            } else {
                SshAuth::Agent
            };
            Some(Arc::new(
                SshPool::connect(&host, port, &user, auth)
                    .await
                    .map_err(|error| {
                        format!(
                            "Profile '{}' SSH upstream connect failed: {error}",
                            profile.name
                        )
                    })?,
            ))
        } else {
            None
        };
        // Core-backed profile: spawn/reuse an xray sidecar. NOTE: on Linux the
        // capture backend is cgroup-based; ensuring the xray child is excluded
        // from the taomni cgroup (so its node connection is not re-captured) is
        // a Linux-capture follow-up. Windows (PID bypass) is the phase-1 target.
        let profile_xray_port = ensure_core_port(
            state,
            &profile.id,
            profile.upstream.kind,
            &host,
            port,
            &profile.upstream,
        )
        .await;

        profile_upstreams.insert(
            profile.id.clone(),
            relay::ResolvedUpstream {
                kind: profile.upstream.kind,
                host,
                port,
                user,
                pass: password,
                ssh_pool: profile_ssh_pool,
                xray_port: profile_xray_port,
            },
        );
    }

    let (stats, domains, rules) = {
        let orch = state.sockscap.orch.read().await;
        (
            Arc::clone(&orch.stats),
            Arc::clone(&orch.domains),
            orch.rules().cloned(),
        )
    };
    let dns_map = Arc::new(std::sync::Mutex::new(rules::dns_map::DnsMap::new(
        8192,
        std::time::Duration::from_secs(300),
    )));

    // Optional global xray core (when the global upstream is core-backed).
    let global_xray_port = ensure_core_port(
        state,
        GLOBAL_CORE_KEY,
        cfg.upstream.kind,
        &upstream_host,
        upstream_port,
        &cfg.upstream,
    )
    .await;

    let engine = relay::RelayContext::build_engine(cfg, rules.as_ref());
    Ok(Arc::new(RwLock::new(relay::RelayContext {
        config: cfg.clone(),
        rules,
        engine,
        helper: Arc::clone(&state.sockscap.helper),
        // Linux recovers the original destination from the redirected socket
        // itself (`SO_ORIGINAL_DST`); there is no privileged helper to ask.
        helper_client: None,
        stats,
        upstream_host,
        upstream_port,
        upstream_user,
        upstream_pass,
        self_pid: std::process::id(),
        ssh_pool,
        xray_port: global_xray_port,
        profile_upstreams,
        dns_map,
        domains,
    })))
}

#[tauri::command]
pub async fn sockscap_test_upstream(
    state: State<'_, AppState>,
    kind: String,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    session_id: Option<String>,
    test_host: Option<String>,
    test_port: Option<u16>,
) -> Result<String, String> {
    let target_host = test_host.unwrap_or_else(|| "www.google.com".into());
    let target_port = test_port.unwrap_or(443);
    let mut host = host;
    let mut port = port;
    let mut user = username.unwrap_or_default();
    let mut pass = password.unwrap_or_default();
    // Resolve vault:<id> if the UI passed a password_ref.
    if pass.starts_with("vault:") {
        if let Ok(Some(p)) = state.vault.resolve(&pass) {
            pass = (*p).clone();
        }
    }
    // Session-backed upstream: pull host/port/user/password from the saved
    // session so the Test button matches what a real capture start would dial.
    // The session's own vault ref overrides any manually supplied credentials.
    let mut test_session: Option<crate::session::models::SessionConfig> = None;
    if let Some(sid) = session_id.filter(|s| !s.trim().is_empty()) {
        let session = {
            let db = state.db.lock().ok();
            db.and_then(|db| crate::session::db::get_session(&db, &sid).ok())
        };
        if let Some(session) = session {
            host = session.host.clone();
            port = session.port;
            if let Some(u) = session.username.clone().filter(|u| !u.is_empty()) {
                user = u;
            }
            if let Some(p) = session_proxy_password(&state.vault, &session) {
                pass = p;
            }
            test_session = Some(session);
        } else {
            return Err(format!("upstream session '{sid}' not found"));
        }
    }

    match kind.as_str() {
        "http" => {
            egress::http_connect::dial(&host, port, &target_host, target_port, &user, &pass)
                .await?;
            Ok(format!(
                "HTTP CONNECT via {}:{} to {}:{} ok",
                host, port, target_host, target_port
            ))
        }
        "socks5" => {
            egress::socks5::dial(&host, port, &target_host, target_port, &user, &pass).await?;
            Ok(format!(
                "SOCKS5 via {}:{} to {}:{} ok",
                host, port, target_host, target_port
            ))
        }
        "ssh" => {
            use crate::sockscap::egress::ssh_pool::SshPool;
            use crate::terminal::ssh::SshAuth;
            // A bound SSH session carries its own auth (key path or vault
            // password); manual entry only has the typed password.
            let auth = if let Some(sess) = &test_session {
                session_ssh_auth(&state.vault, sess)
            } else if pass.is_empty() {
                SshAuth::Agent
            } else {
                SshAuth::Password(pass)
            };
            let pool = SshPool::connect(&host, port, &user, auth).await?;
            let stream = pool.dial(&target_host, target_port, "127.0.0.1", 0).await?;
            // Drop after successful open.
            drop(stream);
            Ok(format!(
                "SSH direct-tcpip via {host}:{port} to {target_host}:{target_port} ok"
            ))
        }
        other => Err(format!("unknown upstream kind: {other}")),
    }
}

/// Parse a single proxy share link (`ss://`/`trojan://`/`vmess://`/`vless://`)
/// into upstream fields the UI can drop into a form. Secrets come back as
/// plaintext for the frontend to store as `vault:<id>` refs.
#[tauri::command]
pub async fn sockscap_parse_share_link(
    link: String,
) -> Result<core::share_link::ParsedShareLink, String> {
    core::share_link::parse(&link)
}

/// Parse a subscription blob (base64 or plain newline-separated links) into a
/// list of upstreams. Unparseable lines are skipped.
#[tauri::command]
pub async fn sockscap_parse_subscription(
    blob: String,
) -> Result<Vec<core::share_link::ParsedShareLink>, String> {
    Ok(core::share_link::parse_subscription(&blob))
}

/// Fetch a subscription and parse it into upstreams. `input` is either an
/// http(s) subscription URL (fetched) or a pasted blob (base64 / newline links,
/// used as-is). Returns the parsed nodes for the UI to turn into profiles.
#[tauri::command]
pub async fn sockscap_import_subscription(
    input: String,
) -> Result<Vec<core::share_link::ParsedShareLink>, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("subscription is empty".into());
    }
    let blob = if input.starts_with("http://") || input.starts_with("https://") {
        let client = reqwest::Client::builder()
            .user_agent("taomni-sockscap")
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let resp = client
            .get(input)
            .send()
            .await
            .map_err(|e| format!("fetch subscription: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("subscription HTTP {}", resp.status()));
        }
        resp.text()
            .await
            .map_err(|e| format!("read subscription body: {e}"))?
    } else {
        input.to_string()
    };
    let nodes = core::share_link::parse_subscription(&blob);
    if nodes.is_empty() {
        return Err("no valid nodes found in subscription".into());
    }
    Ok(nodes)
}

/// Test a core-backed upstream (shadowsocks/trojan/vmess/vless/wireguard) by
/// spawning a throwaway xray sidecar, dialing a probe target through it, and
/// tearing it down. Secrets in `upstream` (password_ref / uuid_ref / wg key
/// refs) are resolved from the vault, matching a real capture start.
#[tauri::command]
pub async fn sockscap_test_core_upstream(
    state: State<'_, AppState>,
    upstream: config::UpstreamRef,
    test_host: Option<String>,
    test_port: Option<u16>,
) -> Result<String, String> {
    if !upstream.kind.requires_core() {
        return Err(format!(
            "{} is not a core-backed upstream",
            upstream.kind.as_tag()
        ));
    }
    let target_host = test_host.unwrap_or_else(|| "www.google.com".into());
    let target_port = test_port.unwrap_or(443);
    if upstream.host.trim().is_empty() || upstream.port == 0 {
        return Err("upstream host and port are required".into());
    }

    let mgr = state
        .sockscap
        .xray()
        .ok_or_else(|| "xray manager not initialized".to_string())?;
    if !mgr.has_exe() {
        return Err("xray-core binary not provisioned; run scripts/fetch-xray.ps1".into());
    }

    let spec = build_core_spec(
        &state.vault,
        upstream.kind,
        upstream.host.clone(),
        upstream.port,
        &upstream,
    );
    // Unique throwaway key so a concurrent Test never collides with a live
    // profile's core or another Test in flight.
    let key = format!(
        "__test_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let local_port = mgr.ensure(&key, &spec).await?;
    let result =
        egress::socks5::dial("127.0.0.1", local_port, &target_host, target_port, "", "").await;
    mgr.remove(&key).await;
    result.map(|_| {
        format!(
            "{} via {}:{} to {target_host}:{target_port} ok",
            upstream.kind.as_tag(),
            upstream.host,
            upstream.port
        )
    })
}
