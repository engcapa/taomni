use super::*;

#[cfg(windows)]
pub(super) async fn start_windows_capture(
    app: &AppHandle,
    state: &State<'_, AppState>,
    cfg: &SocksCapConfig,
    caps: &capture::SocksCapCapabilities,
) -> Result<SocksCapStatus, String> {
    use crate::sockscap::config::ScopeMode;
    use crate::sockscap::helper::{CaptureStartArgs, capture_start, ensure_helper};
    use crate::sockscap::relay::{self, RelayContext};
    use std::sync::Arc;
    use tokio::sync::RwLock;

    // 1) Elevated helper (UAC).
    let helper_st = ensure_helper(app, state).await?;
    if !helper_st.running {
        return Err(helper_st.message);
    }

    // 2) Resolve upstream credentials (manual fields; vault password_ref).
    let (mut up_host, mut up_port, mut up_user, mut up_pass) = relay::upstream_from_config(cfg);
    if !cfg.upstream.password_ref.is_empty() {
        if let Ok(Some(p)) = state.vault.resolve(&cfg.upstream.password_ref) {
            up_pass = (*p).clone();
        }
    }
    // Session-backed upstream: load host/port/user/password from the sessions
    // DB + vault when set. The password comes from the session's vault ref, not
    // the upstream's own `password_ref`.
    let mut up_session: Option<crate::session::models::SessionConfig> = None;
    if !cfg.upstream.session_id.is_empty() {
        let sess = {
            let db = state.db.lock().ok();
            db.and_then(|db| crate::session::db::get_session(&db, &cfg.upstream.session_id).ok())
        };
        if let Some(sess) = sess {
            up_host = sess.host.clone();
            up_port = sess.port;
            if let Some(u) = sess.username.clone().filter(|u| !u.is_empty()) {
                up_user = u;
            }
            if let Some(pass) = session_proxy_password(&state.vault, &sess) {
                up_pass = pass;
            }
            up_session = Some(sess);
        }
    }

    let active_profs = cfg.active_profiles();
    let mut profile_upstreams = std::collections::HashMap::new();
    // Ports of native HTTP/SOCKS5 upstreams whose host is loopback (i.e. an
    // external local proxy such as Clash/v2rayN). We resolve the PID listening
    // on each and bypass it, so the proxy's own egress to its node isn't
    // re-captured into a loop. Only native kinds: core (xray) upstreams dial via
    // their sidecar (already PID-bypassed) and their host is the remote node.
    let mut loopback_proxy_ports: Vec<u16> = Vec::new();
    for p in &active_profs {
        let (mut phost, mut pport, mut puser, mut ppass) =
            relay::upstream_from_config_ref(&p.upstream);
        let mut p_session: Option<crate::session::models::SessionConfig> = None;
        if phost.is_empty() {
            phost = up_host.clone();
            pport = up_port;
            puser = up_user.clone();
            ppass = up_pass.clone();
            // Inherit the global upstream's SSH auth (e.g. key-based session).
            p_session = up_session.clone();
        } else {
            if !p.upstream.password_ref.is_empty() {
                if let Ok(Some(pass)) = state.vault.resolve(&p.upstream.password_ref) {
                    ppass = (*pass).clone();
                }
            }
            if !p.upstream.session_id.is_empty() {
                let sess = {
                    let db = state.db.lock().ok();
                    db.and_then(|db| {
                        crate::session::db::get_session(&db, &p.upstream.session_id).ok()
                    })
                };
                if let Some(sess) = sess {
                    phost = sess.host.clone();
                    pport = sess.port;
                    if let Some(u) = sess.username.clone().filter(|u| !u.is_empty()) {
                        puser = u;
                    }
                    if let Some(pass) = session_proxy_password(&state.vault, &sess) {
                        ppass = pass;
                    }
                    p_session = Some(sess);
                }
            }
        }

        let p_ssh_pool = if matches!(p.upstream.kind, crate::sockscap::config::UpstreamKind::Ssh) {
            use crate::sockscap::egress::ssh_pool::SshPool;
            use crate::terminal::ssh::SshAuth;
            let auth = if let Some(sess) = &p_session {
                session_ssh_auth(&state.vault, sess)
            } else if !ppass.is_empty() {
                SshAuth::Password(ppass.clone())
            } else if !p.upstream.password_ref.is_empty()
                && p.upstream.password_ref.starts_with("key:")
            {
                SshAuth::PrivateKey(p.upstream.password_ref.clone())
            } else {
                SshAuth::Agent
            };
            match SshPool::connect(&phost, pport, &puser, auth).await {
                Ok(pool) => Some(Arc::new(pool)),
                Err(e) => {
                    tracing::warn!("Profile '{}' SSH upstream connect failed: {e}", p.name);
                    None
                }
            }
        } else {
            None
        };

        // Core-backed profile: spawn/reuse an xray sidecar and record its
        // local SOCKS port for the relay to dial.
        let p_xray_port =
            ensure_core_port(state, &p.id, p.upstream.kind, &phost, pport, &p.upstream).await;

        // Native loopback proxy? Remember its port for PID-bypass below.
        if matches!(
            p.upstream.kind,
            crate::sockscap::config::UpstreamKind::Http
                | crate::sockscap::config::UpstreamKind::Socks5
        ) && pport != 0
            && listener_pid::is_loopback(&phost)
            && !loopback_proxy_ports.contains(&pport)
        {
            loopback_proxy_ports.push(pport);
        }

        profile_upstreams.insert(
            p.id.clone(),
            relay::ResolvedUpstream {
                kind: p.upstream.kind,
                host: phost,
                port: pport,
                user: puser,
                pass: ppass,
                ssh_pool: p_ssh_pool,
                xray_port: p_xray_port,
            },
        );
    }

    // Optional global xray core (when the global upstream is core-backed).
    let global_xray_port = ensure_core_port(
        state,
        GLOBAL_CORE_KEY,
        cfg.upstream.kind,
        &up_host,
        up_port,
        &cfg.upstream,
    )
    .await;

    // Global native loopback proxy → remember its port for PID-bypass below.
    if matches!(
        cfg.upstream.kind,
        crate::sockscap::config::UpstreamKind::Http | crate::sockscap::config::UpstreamKind::Socks5
    ) && up_port != 0
        && listener_pid::is_loopback(&up_host)
        && !loopback_proxy_ports.contains(&up_port)
    {
        loopback_proxy_ports.push(up_port);
    }

    // Optional SSH pool for capture-path PROXY via direct-tcpip.
    let ssh_pool = if matches!(
        cfg.upstream.kind,
        crate::sockscap::config::UpstreamKind::Ssh
    ) {
        use crate::sockscap::egress::ssh_pool::SshPool;
        use crate::terminal::ssh::SshAuth;
        let auth = if let Some(sess) = &up_session {
            session_ssh_auth(&state.vault, sess)
        } else if !up_pass.is_empty() {
            SshAuth::Password(up_pass.clone())
        } else if !cfg.upstream.password_ref.is_empty()
            && cfg.upstream.password_ref.starts_with("key:")
        {
            // Convention unused; private key path stored in password_ref rare.
            SshAuth::PrivateKey(cfg.upstream.password_ref.clone())
        } else {
            // Prefer agent when no password.
            SshAuth::Agent
        };
        match SshPool::connect(&up_host, up_port, &up_user, auth).await {
            Ok(p) => Some(Arc::new(p)),
            Err(e) => {
                return Err(format!("SSH upstream connect failed: {e}"));
            }
        }
    } else {
        None
    };

    let (stats, domains) = {
        let orch = state.sockscap.orch.read().await;
        (Arc::clone(&orch.stats), Arc::clone(&orch.domains))
    };
    let rules = {
        let orch = state.sockscap.orch.read().await;
        orch.rules().map(|r| r.clone())
    };
    let dns_map = Arc::new(std::sync::Mutex::new(
        crate::sockscap::rules::dns_map::DnsMap::new(8192, std::time::Duration::from_secs(300)),
    ));
    // Seed from Windows DNS client cache (no admin).
    crate::sockscap::dns_win::refresh_dns_client_cache(&dns_map);

    // One persistent control channel for the whole capture session, instead of
    // a fresh blocking TCP connection per captured flow.
    let helper_client = state
        .sockscap
        .helper
        .inner
        .lock()
        .ok()
        .and_then(|g| g.as_ref().cloned())
        .map(|sess| Arc::new(helper::HelperClient::spawn(sess)));

    let engine = RelayContext::build_engine(cfg, rules.as_ref());
    let ctx = Arc::new(RwLock::new(RelayContext {
        config: cfg.clone(),
        rules,
        engine,
        helper: Arc::clone(&state.sockscap.helper),
        helper_client,
        stats,
        upstream_host: up_host.clone(),
        upstream_port: up_port,
        upstream_user: up_user,
        upstream_pass: up_pass,
        self_pid: std::process::id(),
        ssh_pool,
        xray_port: global_xray_port,
        profile_upstreams,
        dns_map: Arc::clone(&dns_map),
        domains,
    }));
    let relay_handle = relay::start_relay(Arc::clone(&ctx)).await?;

    // Periodic DNS cache refresh while capture runs (stopped via orch.dns_stop).
    let dns_stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let _dns_task = crate::sockscap::dns_win::spawn_dns_cache_refresher(
        dns_map,
        Arc::clone(&dns_stop),
        std::time::Duration::from_secs(60),
    );

    // 3) Tell helper to start FLOW+NETWORK capture → NAT to relay.
    let mode_apps = !active_profs.is_empty()
        && active_profs
            .iter()
            .all(|p| matches!(p.mode, ScopeMode::Apps));

    let mut app_paths: Vec<String> = Vec::new();
    for p in &active_profs {
        if matches!(p.mode, ScopeMode::Apps) {
            for a in &p.apps {
                let norm = paths::normalize_exe_path(&a.path);
                if !norm.is_empty() && !app_paths.contains(&norm) {
                    app_paths.push(norm);
                }
            }
        }
    }

    let mut bypass_pids = vec![std::process::id()];
    if let Some(pid) = helper_st.pid {
        bypass_pids.push(pid);
    }
    // Bypass every xray core: its own connection to the remote node must not be
    // re-captured (that would loop node traffic back into the relay). Robust for
    // domain nodes / multi-IP resolution where endpoint bypass alone can miss.
    let xray_pids: Vec<u32> = match state.sockscap.xray() {
        Some(mgr) => mgr.pids().await,
        None => Vec::new(),
    };
    bypass_pids.extend(xray_pids.iter().copied());
    // Bypass external local proxies used as loopback HTTP/SOCKS5 upstreams
    // (Clash/v2rayN etc): the process listening on the configured port owns the
    // egress to its node, which must not be re-captured into a loop. We bypass
    // both its PID (immediate) and its exe path (restart-proof: survives the
    // proxy restarting with a new PID, unlike the PID snapshot alone).
    let mut bypass_paths: Vec<String> = Vec::new();
    // Bypass the bundled xray binary by path as well as by pid. The pid list is
    // a snapshot; the path survives a core crashing and being respawned with a
    // new pid, which would otherwise have its node connection captured and
    // looped back into the relay.
    if let Some(xray) = paths::resolve_xray_exe(app) {
        let norm = paths::normalize_exe_path(&xray.display().to_string());
        if !norm.is_empty() && !bypass_paths.contains(&norm) {
            bypass_paths.push(norm);
        }
    }
    if !loopback_proxy_ports.is_empty() {
        let procs = process::list_processes().unwrap_or_default();
        for port in &loopback_proxy_ports {
            for pid in listener_pid::resolve_listener_pids(*port) {
                if !bypass_pids.contains(&pid) {
                    bypass_pids.push(pid);
                    tracing::info!("sockscap: bypassing local proxy pid {pid} on 127.0.0.1:{port}");
                }
                if let Some(path) = procs
                    .iter()
                    .find(|p| p.pid == pid)
                    .map(|p| paths::normalize_exe_path(&p.path))
                    .filter(|s| !s.is_empty())
                {
                    if !bypass_paths.contains(&path) {
                        tracing::info!("sockscap: bypassing local proxy path {path}");
                        bypass_paths.push(path);
                    }
                }
            }
        }
    }
    let mut bypass_endpoints = Vec::new();
    if !up_host.is_empty() && up_port > 0 {
        bypass_endpoints.push((up_host, up_port));
    }
    // Relay listens on 0.0.0.0 / :: (streamdump reflection). Bypass those endpoints
    // so we never re-capture the proxy's own accept path as a new flow.
    bypass_endpoints.push(("127.0.0.1".into(), relay_handle.port));
    bypass_endpoints.push(("::1".into(), relay_handle.port));
    bypass_endpoints.push(("0.0.0.0".into(), relay_handle.port));

    let args = CaptureStartArgs {
        mode_apps,
        app_paths,
        bypass_cidrs: cfg.bypass_cidrs.clone(),
        bypass_pids,
        bypass_paths,
        bypass_endpoints,
        // Unused for streamdump reflection dest (kept for helper JSON compat).
        relay_ip: "0.0.0.0".into(),
        relay_port: relay_handle.port,
        block_quic: cfg.block_quic,
    };

    if args.mode_apps && args.app_paths.is_empty() {
        dns_stop.store(true, std::sync::atomic::Ordering::SeqCst);
        relay_handle.stop().await;
        return Err("App mode requires at least one application path".into());
    }

    let capture_result = {
        let guard = state
            .sockscap
            .helper
            .inner
            .lock()
            .map_err(|e| e.to_string())?;
        let sess = guard
            .as_ref()
            .ok_or_else(|| "helper session lost".to_string())?;
        capture_start(sess, &args)
    };

    match capture_result {
        Ok(info) => {
            // Keep the helper's bypass list current as cores are respawned.
            spawn_xray_bypass_updater(state, &args.bypass_pids, &xray_pids, &args.bypass_paths);
            let mut orch = state.sockscap.orch.write().await;
            orch.relay = Some(relay_handle);
            orch.relay_ctx = Some(ctx);
            orch.dns_stop = Some(dns_stop);
            let gfw_note = orch
                .gfwlist_meta()
                .map(|m| format!(", gfw={}", m.rule_count))
                .unwrap_or_default();
            orch.set_active(
                &caps.capture_backend,
                format!(
                    "capture active (relay :{}, elevated=true{gfw_note})",
                    args.relay_port
                ),
            );
            tracing::info!("sockscap capture started: {info}");
            Ok(orch.status())
        }
        Err(e) => {
            dns_stop.store(true, std::sync::atomic::Ordering::SeqCst);
            relay_handle.stop().await;
            let mut orch = state.sockscap.orch.write().await;
            orch.set_start_failed(format!("helper/capture failed: {e}"));
            Err(e)
        }
    }
}

/// Push a refreshed bypass list to the helper whenever an xray core respawns.
///
/// The helper's bypass pids are a snapshot taken at capture start. A core that
/// crashes comes back with a new pid, and until the helper is told, that core's
/// connection to its remote node is captured and reflected into the relay —
/// which then dials the core's own SOCKS inbound. The resulting loop wedges all
/// proxied traffic, and a crash somewhere in a multi-hour session is exactly the
/// kind of event that made long runs stop working.
///
/// The task ends when the manager drops the sender (`stop_monitor`, called from
/// every teardown path) or when a later capture start replaces it.
#[cfg(windows)]
pub(super) fn spawn_xray_bypass_updater(
    state: &State<'_, AppState>,
    base_pids: &[u32],
    initial_core_pids: &[u32],
    bypass_paths: &[String],
) {
    let Some(mgr) = state.sockscap.xray() else {
        return;
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u32>>();
    mgr.set_respawn_notifier(tx);

    let helper = Arc::clone(&state.sockscap.helper);
    // Everything except the core pids, which the notification re-supplies in
    // full. Dropping the dead ones matters: a recycled pid could later belong to
    // a process that should be captured.
    let mut base: Vec<u32> = base_pids.to_vec();
    base.retain(|p| !initial_core_pids.contains(p));
    let paths = bypass_paths.to_vec();

    tokio::spawn(async move {
        while let Some(core_pids) = rx.recv().await {
            let mut pids = base.clone();
            for p in core_pids {
                if !pids.contains(&p) {
                    pids.push(p);
                }
            }
            let Some(sess) = helper.inner.lock().ok().and_then(|g| g.as_ref().cloned()) else {
                continue;
            };
            let paths = paths.clone();
            let sent = tokio::task::spawn_blocking(move || {
                helper::capture_update_bypass(&sess, &pids, &paths)
            })
            .await;
            match sent {
                Ok(Ok(_)) => {
                    tracing::info!("sockscap: pushed refreshed bypass list after xray respawn")
                }
                Ok(Err(e)) => tracing::warn!("sockscap: bypass refresh failed: {e}"),
                Err(e) => tracing::warn!("sockscap: bypass refresh task failed: {e}"),
            }
        }
    });
}

#[cfg(not(windows))]
pub(super) fn spawn_xray_bypass_updater(
    _state: &State<'_, AppState>,
    _pids: &[u32],
    _core_pids: &[u32],
    _paths: &[String],
) {
}
